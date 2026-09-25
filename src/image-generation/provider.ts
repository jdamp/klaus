import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";

import type { ComponentHealth } from "../app/lifecycle.js";
import type { CapabilityBinding, CapabilityProvider } from "../capabilities/types.js";
import type { OutboxRepository, ToolAuditRepository } from "../persistence/repositories.js";
import type { SecretRedactor } from "../security/secrets.js";
import type { TurnContextRegistry } from "../agent/turn-context.js";
import { promptByteLength, validateGeneratedImage, type ImageGenerator } from "./types.js";

class SafeImageToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SafeImageToolError";
  }
}

const parameters = {
  type: "object",
  additionalProperties: false,
  required: ["prompt"],
  properties: { prompt: { type: "string", minLength: 1 } },
};

export type ImageGeneratorWithHealth = ImageGenerator & {
  checkAuth?: (signal?: AbortSignal) => Promise<void>;
  health?: () => { status: "healthy" | "degraded"; detail?: string };
};

export class ImageGenerationProvider implements CapabilityProvider {
  readonly id = "image-generation";
  #lastError: string | undefined;

  constructor(
    private readonly generator: ImageGeneratorWithHealth,
    private readonly outbox: OutboxRepository,
    private readonly audits: ToolAuditRepository,
    private readonly turnContexts: TurnContextRegistry,
    private readonly promptMaxBytes: number,
    private readonly maxImageBytes: number,
    private readonly redactor?: SecretRedactor,
  ) {}

  async start(signal: AbortSignal): Promise<void> {
    try {
      await this.generator.checkAuth?.(signal);
    } catch {
      this.#lastError = "Image provider authentication unavailable";
    }
  }

  stop(): Promise<void> {
    return Promise.resolve();
  }

  health(): Record<string, ComponentHealth> {
    const state = this.generator.health?.();
    if (state?.status === "degraded" || this.#lastError) {
      return {
        provider: {
          status: "degraded",
          detail: state?.detail ?? this.#lastError ?? "Image provider degraded",
        },
      };
    }
    return { provider: { status: "healthy" } };
  }

  tools(binding?: CapabilityBinding): readonly ToolDefinition[] {
    if (!binding?.sessionId) return [];
    return [
      defineTool({
        name: "generate_image",
        label: "generate_image",
        description:
          "Generate one image from a text description and queue it for this Telegram chat.",
        parameters,
        execute: async (toolCallId, params, signal) => {
          const value = params as { prompt?: unknown };
          if (typeof value.prompt !== "string" || !value.prompt.trim()) {
            throw new Error("Image prompt must be a non-empty string");
          }
          const prompt = value.prompt.trim();
          if (promptByteLength(prompt) > this.promptMaxBytes) {
            throw new Error("Image prompt exceeds the configured limit");
          }
          const context = this.turnContexts.require(binding.sessionId!);
          const dedupeKey = `image:${context.updateId}:${toolCallId}`;
          if (this.outbox.hasDedupe(dedupeKey)) {
            return {
              content: [
                { type: "text", text: JSON.stringify({ status: "already_queued", count: 1 }) },
              ],
              details: { provider: this.id, outcome: "success" },
            };
          }
          const auditId = this.audits.start(
            this.id,
            "generate_image",
            { promptBytes: promptByteLength(prompt) },
            context.updateId,
            toolCallId,
          );
          try {
            const generationSignal = signal ?? new AbortController().signal;
            if (generationSignal.aborted) throw new Error("Image generation was cancelled");
            const image = validateGeneratedImage(
              await this.generator.generate({ prompt }, generationSignal),
              this.maxImageBytes,
            );
            if (generationSignal.aborted) throw new Error("Image generation was cancelled");
            const inserted = this.outbox.enqueuePhoto({
              dedupeKey,
              chatId: context.chatId,
              replyToMessageId: context.messageId,
              sequence: 0,
              bytes: image.bytes,
              mediaType: image.mediaType,
              holdForResponse: true,
            });
            const result = {
              status: inserted ? "queued" : "already_queued",
              count: 1,
              mediaType: image.mediaType,
              bytes: image.bytes.byteLength,
            } as const;
            this.audits.finish(auditId, "success", {
              status: result.status,
              mediaType: result.mediaType,
              bytes: result.bytes,
            });
            this.#lastError = undefined;
            return {
              content: [{ type: "text", text: JSON.stringify(result) }],
              details: { provider: this.id, outcome: "success" },
            };
          } catch (error) {
            const message = error instanceof Error ? error.message : "Image generation failed";
            const safe = this.redactor ? this.redactor.redact(message) : message;
            this.audits.finish(auditId, "failure", { error: safe });
            this.#lastError = typeof safe === "string" ? safe : "Image generation failed";
            throw new SafeImageToolError(this.#lastError);
          }
        },
      }),
    ];
  }
}
