import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import type { ComponentHealth } from "../../app/lifecycle.js";
import type { CapabilityProvider } from "../../capabilities/types.js";
import { NativeToolExecutor } from "../../capabilities/execution.js";
import type { ToolAuditRepository } from "../../persistence/repositories.js";
import type { SecretRedactor } from "../../security/secrets.js";
import type { TurnContextRegistry } from "../../agent/turn-context.js";
import {
  PaperlessClient,
  PaperlessHttpError,
  type PaperlessConfig,
  type PaperlessFetch,
} from "./client.js";

export class PaperlessProvider implements CapabilityProvider {
  readonly id = "paperless";
  readonly #client: PaperlessClient;
  readonly #executor: NativeToolExecutor;
  readonly #turnContexts: TurnContextRegistry;
  readonly #allowedChats: ReadonlySet<string>;
  readonly #allowedUsers: ReadonlySet<string>;
  #state: ComponentHealth = { status: "degraded", detail: "Paperless has not been checked" };
  #incompatible = false;

  constructor(
    config: PaperlessConfig,
    token: string,
    audits: ToolAuditRepository,
    redactor: SecretRedactor,
    turnContexts: TurnContextRegistry,
    allowedChats: ReadonlySet<string>,
    allowedUsers: ReadonlySet<string>,
    fetcher?: PaperlessFetch,
  ) {
    redactor.add(token);
    this.#client = new PaperlessClient(config, token, fetcher);
    this.#executor = new NativeToolExecutor(
      audits,
      redactor,
      this.id,
      { timeoutMs: config.requestTimeoutMs, maxResultBytes: config.maxResultBytes },
      (signal) => this.#ensureAvailable(signal),
    );
    this.#turnContexts = turnContexts;
    this.#allowedChats = allowedChats;
    this.#allowedUsers = allowedUsers;
  }

  async start(signal: AbortSignal): Promise<void> {
    await this.#refresh(AbortSignal.any([signal, AbortSignal.timeout(10_000)]));
  }

  async stop(): Promise<void> {
    // Fetch requests are bounded and owned by individual tools.
  }

  health(): Record<string, ComponentHealth> {
    return { service: this.#state };
  }

  tools(): readonly ToolDefinition[] {
    return [];
  }

  async #ensureAvailable(signal: AbortSignal): Promise<void> {
    await this.#refresh(AbortSignal.any([signal, AbortSignal.timeout(10_000)]));
    if (this.#incompatible) throw new Error(this.#state.detail ?? "Paperless API is incompatible");
    if (this.#state.status !== "healthy")
      throw new Error(this.#state.detail ?? "Paperless is unavailable");
  }

  async #refresh(signal: AbortSignal): Promise<void> {
    try {
      const response = await this.#client.probe(signal);
      const body = asRecord(response.body);
      if (response.apiVersion !== "10" || !response.serverVersion) {
        this.#incompatible = true;
        this.#state = {
          status: "degraded",
          detail: "Paperless API v10 compatibility could not be verified",
        };
        return;
      }
      if (!Array.isArray(body.results) || typeof body.count !== "number") {
        this.#incompatible = true;
        this.#state = {
          status: "degraded",
          detail: "Paperless API v10 document response is incompatible",
        };
        return;
      }
      this.#incompatible = false;
      this.#state = { status: "healthy" };
    } catch (error) {
      this.#incompatible = error instanceof PaperlessHttpError && error.status === 406;
      this.#state = {
        status: "degraded",
        detail: this.#incompatible
          ? "Paperless does not support API v10; upgrade to a compatible release"
          : error instanceof PaperlessHttpError && [401, 403].includes(error.status)
            ? "Paperless rejected the configured token or document access"
            : signal.aborted
              ? "Paperless compatibility check timed out or was cancelled"
              : "Paperless is unavailable or returned an invalid response",
      };
    }
  }

  #requireTrustedContext(sessionId: string) {
    const context = this.#turnContexts.require(sessionId);
    if (!this.#allowedChats.has(context.chatId) || !this.#allowedUsers.has(context.senderId)) {
      throw new Error("Paperless requires an authorized active Telegram turn");
    }
    return context;
  }

  get executor(): NativeToolExecutor {
    return this.#executor;
  }

  get client(): PaperlessClient {
    return this.#client;
  }

  authorize(sessionId: string) {
    return this.#requireTrustedContext(sessionId);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
