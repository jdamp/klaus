import { createHash } from "node:crypto";

import type { TelegramApi } from "./client.js";
import type { TelegramDocument, TelegramUploadAttachment } from "./types.js";

export type TrustedUploadFile = {
  bytes: Uint8Array;
  mediaType: "application/pdf" | "image/jpeg" | "image/png";
  name: string;
  sha256: string;
};

export type UploadFileFailure = "unsupported" | "oversized" | "unavailable";

export class UploadFileError extends Error {
  constructor(
    readonly failure: UploadFileFailure,
    message: string,
  ) {
    super(message);
    this.name = "UploadFileError";
  }
}

const supportedTypes = new Set(["application/pdf", "image/jpeg", "image/png"]);
const extensionTypes: Record<string, string> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
};

function declaredType(document: TelegramDocument): string | undefined {
  const mime = document.mime_type?.trim().toLowerCase();
  const extension = document.file_name?.toLowerCase().match(/\.([a-z0-9]+)$/u)?.[1];
  const extensionType = extension ? extensionTypes[extension] : undefined;
  if (mime && !supportedTypes.has(mime)) {
    throw new UploadFileError("unsupported", "Only PDF, JPEG, and PNG files can be uploaded.");
  }
  if (extension && !extensionType) {
    throw new UploadFileError("unsupported", "Only PDF, JPEG, and PNG files can be uploaded.");
  }
  if (mime && extensionType && mime !== extensionType) {
    throw new UploadFileError("unsupported", "The file type does not match its name.");
  }
  return mime || extensionType;
}

function sniffType(bytes: Uint8Array): TrustedUploadFile["mediaType"] | undefined {
  if (bytes.length >= 5 && new TextDecoder().decode(bytes.subarray(0, 5)) === "%PDF-") {
    return "application/pdf";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= png.length && png.every((byte, index) => bytes[index] === byte)) {
    return "image/png";
  }
  return undefined;
}

function safeName(original: string | undefined, mediaType: TrustedUploadFile["mediaType"]): string {
  const extension =
    mediaType === "application/pdf" ? ".pdf" : mediaType === "image/png" ? ".png" : ".jpg";
  let stem = (original ?? "document")
    .normalize("NFKC")
    .replace(/[\\/]/gu, "_")
    .split("")
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 ? "_" : character;
    })
    .join("")
    .replace(/\.[^.]*$/u, "")
    .replace(/^\.+/u, "")
    .trim()
    .slice(0, 100);
  if (!stem) stem = "document";
  return `${stem}${extension}`;
}

function fileReference(attachment: TelegramUploadAttachment, maxBytes: number) {
  if (attachment.kind === "photo") {
    const candidates = [...attachment.variants]
      .filter((variant) => variant.file_id.length > 0)
      .sort((left, right) => right.width * right.height - left.width * left.height);
    const selected = candidates.find(
      (variant) => variant.file_size === undefined || variant.file_size <= maxBytes,
    );
    if (!selected) {
      throw new UploadFileError("oversized", "The attachment exceeds the configured upload limit.");
    }
    return { fileId: selected.file_id, expectedType: undefined, fileName: undefined };
  }

  const document = attachment.document;
  if (document.file_size !== undefined && document.file_size > maxBytes) {
    throw new UploadFileError("oversized", "The attachment exceeds the configured upload limit.");
  }
  return {
    fileId: document.file_id,
    expectedType: declaredType(document),
    fileName: document.file_name,
  };
}

export class TelegramUploadFileLoader {
  constructor(
    private readonly api: TelegramApi,
    private readonly maxBytes: number,
    private readonly timeoutMs: number,
  ) {}

  async load(
    attachment: TelegramUploadAttachment,
    parentSignal?: AbortSignal,
  ): Promise<TrustedUploadFile> {
    if (!this.api.getFile || !this.api.downloadFile) {
      throw new UploadFileError("unavailable", "Telegram attachment retrieval is unavailable.");
    }
    const reference = fileReference(attachment, this.maxBytes);
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = parentSignal ? AbortSignal.any([parentSignal, timeout]) : timeout;
    try {
      const telegramFile = await this.api.getFile(reference.fileId, signal);
      if (telegramFile.file_size !== undefined && telegramFile.file_size > this.maxBytes) {
        throw new UploadFileError(
          "oversized",
          "The attachment exceeds the configured upload limit.",
        );
      }
      if (!telegramFile.file_path) throw new Error("missing Telegram file path");
      const bytes = await this.api.downloadFile(
        telegramFile.file_path,
        this.maxBytes,
        this.timeoutMs,
        signal,
      );
      if (bytes.byteLength > this.maxBytes) {
        throw new UploadFileError(
          "oversized",
          "The attachment exceeds the configured upload limit.",
        );
      }
      const mediaType = sniffType(bytes);
      if (!mediaType) {
        throw new UploadFileError("unsupported", "Only PDF, JPEG, and PNG files can be uploaded.");
      }
      if (reference.expectedType && reference.expectedType !== mediaType) {
        throw new UploadFileError(
          "unsupported",
          "The file content does not match its declared type.",
        );
      }
      return {
        bytes,
        mediaType,
        name: safeName(reference.fileName, mediaType),
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    } catch (error) {
      if (error instanceof UploadFileError) throw error;
      throw new UploadFileError("unavailable", "Telegram could not retrieve this attachment.");
    }
  }
}
