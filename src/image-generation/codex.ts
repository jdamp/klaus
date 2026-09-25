import { randomUUID } from "node:crypto";

import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

import type { AppConfig } from "../config.js";
import { validateGeneratedImage, type GeneratedImage, type ImageGenerator } from "./types.js";

const CODEX_IMAGE_URL = "https://chatgpt.com/backend-api/codex/images/generations";
const CODEX_ACCOUNT_CLAIM = "https://api.openai.com/auth";
const MAX_BASE64_EXPANSION = 4 / 3;

class SafeImageGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SafeImageGenerationError";
  }
}

export type ImageGeneratorHealth = { status: "healthy" } | { status: "degraded"; detail: string };

export class CodexImageGenerator implements ImageGenerator {
  #health: ImageGeneratorHealth = { status: "degraded", detail: "Not checked" };

  constructor(
    private readonly runtime: Pick<ModelRuntime, "getAuth">,
    private readonly config: NonNullable<AppConfig["imageGeneration"]>,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  health(): ImageGeneratorHealth {
    return this.#health;
  }

  async checkAuth(signal?: AbortSignal): Promise<void> {
    try {
      const auth = signal
        ? await this.runtime.getAuth("openai-codex", { signal })
        : await this.runtime.getAuth("openai-codex");
      if (!auth?.auth.apiKey) throw new Error("Image provider authentication is unavailable");
      accountIdFromToken(auth.auth.apiKey);
      this.#health = { status: "healthy" };
    } catch {
      this.#health = { status: "degraded", detail: "Image provider authentication unavailable" };
    }
  }

  async generate(request: { prompt: string }, signal: AbortSignal): Promise<GeneratedImage> {
    const timeout = AbortSignal.timeout(this.config.requestTimeoutMs);
    const combined = AbortSignal.any([signal, timeout]);
    try {
      const auth = await this.runtime.getAuth("openai-codex", { signal: combined });
      const token = auth?.auth.apiKey;
      if (!token) throw new Error("Image provider authentication is unavailable");
      const accountId = accountIdFromToken(token);
      const response = await this.fetcher(CODEX_IMAGE_URL, {
        method: "POST",
        redirect: "error",
        signal: combined,
        headers: {
          authorization: `Bearer ${token}`,
          "chatgpt-account-id": accountId,
          originator: "klaus-agent",
          "content-type": "application/json",
          "x-codex-image-turn-id": randomUUID(),
        },
        body: JSON.stringify({
          prompt: request.prompt,
          model: "gpt-image-2",
          background: "auto",
          quality: "auto",
          size: "auto",
        }),
      });
      if (!response.ok) throw new Error("Image provider request failed");
      const body = await readBoundedBody(response, this.config.maxResponseBytes, combined);
      const encoded = parseImageResponse(body, this.config.maxImageBytes);
      const bytes = decodeBase64(encoded, this.config.maxImageBytes);
      const mediaType = detectMediaType(bytes);
      const image = validateGeneratedImage({ bytes, mediaType }, this.config.maxImageBytes);
      this.#health = { status: "healthy" };
      return image;
    } catch (error) {
      this.#health = {
        status: "degraded",
        detail: safeFailure(error, combined),
      };
      throw new SafeImageGenerationError(this.#health.detail);
    }
  }
}

function accountIdFromToken(token: string): string {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("invalid token");
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    const auth = payload[CODEX_ACCOUNT_CLAIM];
    const accountId =
      auth && typeof auth === "object"
        ? (auth as Record<string, unknown>).chatgpt_account_id
        : undefined;
    if (typeof accountId !== "string" || !accountId) throw new Error("missing account");
    return accountId;
  } catch {
    throw new Error("Image provider authentication is invalid");
  }
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (!response.body) throw new Error("Image provider returned no response body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) throw new Error("Image provider response exceeds the configured limit");
      chunks.push(next.value);
      if (signal.aborted) throw new Error("Image generation was cancelled");
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function parseImageResponse(body: Uint8Array, maxImageBytes: number): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new Error("Image provider returned invalid response data");
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !Array.isArray((parsed as { data?: unknown }).data)
  ) {
    throw new Error("Image provider returned no image data");
  }
  const data = (parsed as { data: unknown[] }).data;
  if (data.length !== 1) throw new Error("Image provider returned an unexpected image count");
  const value = data[0];
  const encoded =
    value && typeof value === "object" ? (value as { b64_json?: unknown }).b64_json : undefined;
  if (typeof encoded !== "string" || !encoded)
    throw new Error("Image provider returned empty image data");
  if (encoded.length > Math.ceil(maxImageBytes * MAX_BASE64_EXPANSION)) {
    throw new Error("Image provider image data exceeds the configured limit");
  }
  return encoded;
}

function decodeBase64(value: string, maxBytes: number): Uint8Array {
  if (
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new Error("Image provider returned invalid image data");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value || decoded.byteLength > maxBytes) {
    throw new Error("Image provider returned invalid image data");
  }
  return new Uint8Array(decoded);
}

function detectMediaType(bytes: Uint8Array): "image/png" | "image/jpeg" {
  if (
    bytes.length >= 8 &&
    bytes
      .slice(0, 8)
      .every((byte, index) => byte === [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a][index])
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  throw new Error("Image provider returned an unsupported image encoding");
}

function safeFailure(error: unknown, signal: AbortSignal): string {
  if (signal.aborted) return "Image generation was cancelled or timed out";
  return error instanceof Error ? error.message : "Image generation failed";
}
