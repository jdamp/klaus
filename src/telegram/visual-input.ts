import type { ImageContent } from "@earendil-works/pi-ai";

import type { TelegramApi } from "./client.js";
import type { TelegramDocument, TelegramPhotoSize, TelegramVisualAttachment } from "./types.js";

export type VisualInputFailure =
  "unsupported" | "oversized" | "invalid" | "unavailable" | "model-incompatible";

export class VisualInputError extends Error {
  constructor(
    readonly failure: VisualInputFailure,
    message: string,
  ) {
    super(message);
    this.name = "VisualInputError";
  }
}

const MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const EXTENSION_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

function extensionMime(fileName?: string): string | undefined {
  const extension = fileName?.toLowerCase().match(/\.([a-z0-9]+)$/u)?.[1];
  return extension ? EXTENSION_MIME[extension] : undefined;
}

function containsAscii(bytes: Uint8Array, value: string): boolean {
  const target = new TextEncoder().encode(value);
  outer: for (let index = 0; index <= bytes.length - target.length; index += 1) {
    for (let offset = 0; offset < target.length; offset += 1) {
      if (bytes[index + offset] !== target[offset]) continue outer;
    }
    return true;
  }
  return false;
}

export function detectImageMime(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (
    bytes.length >= pngSignature.length &&
    pngSignature.every((value, index) => bytes[index] === value)
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
  ) {
    return "image/webp";
  }
  return undefined;
}

export function validateImageBytes(
  bytes: Uint8Array,
  declaredMimeType?: string,
  fileName?: string,
): { mimeType: string; data: string } {
  const mimeType = detectImageMime(bytes);
  if (!mimeType) throw new VisualInputError("unsupported", "The image format is unsupported.");
  if (
    containsAscii(bytes, "acTL") ||
    containsAscii(bytes, "ANIM") ||
    containsAscii(bytes, "ANMF")
  ) {
    throw new VisualInputError("unsupported", "Animated images are not supported.");
  }

  const normalizedDeclared = declaredMimeType?.toLowerCase();
  if (
    normalizedDeclared &&
    (!MIME_TYPES.has(normalizedDeclared) || normalizedDeclared !== mimeType)
  ) {
    throw new VisualInputError("unsupported", "The image format is unsupported or mislabeled.");
  }
  const filenameMime = extensionMime(fileName);
  if (filenameMime && filenameMime !== mimeType) {
    throw new VisualInputError("unsupported", "The image format is unsupported or mislabeled.");
  }
  return { mimeType, data: Buffer.from(bytes).toString("base64") };
}

function documentHint(document: TelegramDocument): { mimeType?: string; fileName?: string } {
  const mimeType = document.mime_type?.toLowerCase();
  if (mimeType && !MIME_TYPES.has(mimeType)) {
    throw new VisualInputError("unsupported", "The image format is unsupported.");
  }
  const fileName = document.file_name;
  const filenameMime = extensionMime(fileName);
  if (fileName && !filenameMime && !mimeType) {
    throw new VisualInputError("unsupported", "The image format is unsupported.");
  }
  return {
    ...(mimeType ? { mimeType } : {}),
    ...(fileName ? { fileName } : {}),
  };
}

export function selectPhotoVariant(
  variants: readonly TelegramPhotoSize[],
  maxBytes: number,
): TelegramPhotoSize {
  const candidates = [...variants]
    .filter((variant) => variant.file_id.length > 0)
    .sort((left, right) => right.width * right.height - left.width * left.height);
  const selected = candidates.find(
    (variant) => variant.file_size === undefined || variant.file_size <= maxBytes,
  );
  if (!selected)
    throw new VisualInputError("oversized", "The image exceeds the configured size limit.");
  return selected;
}

export class TelegramVisualInputLoader {
  constructor(
    private readonly api: TelegramApi,
    private readonly maxBytes: number,
    private readonly timeoutMs: number,
  ) {}

  async load(attachment: TelegramVisualAttachment): Promise<ImageContent> {
    if (!this.api.getFile || !this.api.downloadFile) {
      throw new VisualInputError("unavailable", "Telegram image retrieval is unavailable.");
    }

    let fileId: string;
    let declaredMimeType: string | undefined;
    let fileName: string | undefined;
    if (attachment.kind === "photo") {
      fileId = selectPhotoVariant(attachment.variants, this.maxBytes).file_id;
    } else {
      const hint = documentHint(attachment.document);
      fileId = attachment.document.file_id;
      declaredMimeType = hint.mimeType;
      fileName = hint.fileName;
      if (
        attachment.document.file_size !== undefined &&
        attachment.document.file_size > this.maxBytes
      ) {
        throw new VisualInputError("oversized", "The image exceeds the configured size limit.");
      }
    }

    const signal = AbortSignal.timeout(this.timeoutMs);
    try {
      const file = await this.api.getFile(fileId, signal);
      if (file.file_size !== undefined && file.file_size > this.maxBytes) {
        throw new VisualInputError("oversized", "The image exceeds the configured size limit.");
      }
      if (!file.file_path) throw new Error("Telegram did not return a file path");
      const bytes = await this.api.downloadFile(
        file.file_path,
        this.maxBytes,
        this.timeoutMs,
        signal,
      );
      const validated = validateImageBytes(bytes, declaredMimeType, fileName);
      return { type: "image", mimeType: validated.mimeType, data: validated.data };
    } catch (error) {
      if (error instanceof VisualInputError) throw error;
      const message = error instanceof Error ? error.message : "";
      if (message.includes("size limit")) {
        throw new VisualInputError("oversized", "The image exceeds the configured size limit.");
      }
      throw new VisualInputError("unavailable", "Telegram could not retrieve the image.");
    }
  }
}

export function visualInputErrorMessage(error: VisualInputError): string {
  return error.message;
}
