import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { PiSessionFactory } from "../agent/pi-runtime.js";
import { SessionRegistry } from "../agent/session-registry.js";
import { AgentTurnHandler } from "../agent/turn.js";
import type { ServiceComponent } from "../app/lifecycle.js";
import type { AppConfig } from "../config.js";
import type { McpRegistry } from "../mcp/registry.js";
import type { AppDatabase } from "../persistence/database.js";
import { OutboxRepository, SessionEntryRepository } from "../persistence/repositories.js";
import type { AcceptedTelegramInput } from "../telegram/types.js";
import type { KeyedQueue } from "../dispatch/keyed-queue.js";
import type { TelegramPoller } from "../telegram/poller.js";

export class TelegramRuntimeComponent implements ServiceComponent {
  readonly name = "telegram";

  constructor(
    private readonly poller: TelegramPoller,
    private readonly queue: KeyedQueue,
  ) {}

  start(signal: AbortSignal): Promise<void> {
    return this.poller.start(signal);
  }

  async stop(): Promise<void> {
    await this.poller.stop();
    await this.queue.close();
  }

  health() {
    return this.poller.health();
  }
}

export class PersistenceComponent implements ServiceComponent {
  readonly name = "persistence";
  constructor(private readonly database: AppDatabase) {}
  start(): Promise<void> {
    this.database.migrate();
    return Promise.resolve();
  }
  stop(): Promise<void> {
    this.database.close();
    return Promise.resolve();
  }
  health() {
    try {
      this.database.connection.prepare("SELECT 1").get();
      return { status: "healthy" as const };
    } catch (error) {
      return {
        status: "unhealthy" as const,
        detail: error instanceof Error ? error.message : "SQLite failed",
      };
    }
  }
}

export class CapabilityComponent implements ServiceComponent {
  readonly name = "capabilities";
  constructor(readonly registry: McpRegistry) {}
  start(): Promise<void> {
    return this.registry.connect();
  }
  stop(): Promise<void> {
    return this.registry.close();
  }
  health() {
    const states = Object.values(this.registry.health());
    const degraded = states.find((state) => state.status === "degraded");
    return degraded
      ? {
          status: "degraded" as const,
          ...(degraded.detail ? { detail: degraded.detail } : {}),
        }
      : { status: "healthy" as const };
  }
}

export class SessionComponent implements ServiceComponent {
  readonly name = "sessions";
  #registry?: SessionRegistry;
  #handler?: AgentTurnHandler;

  constructor(
    private readonly config: AppConfig,
    private readonly runtime: ModelRuntime,
    private readonly database: AppDatabase,
    private readonly capabilities: McpRegistry,
  ) {}

  start(): Promise<void> {
    const factory = new PiSessionFactory(
      this.config,
      this.runtime,
      new SessionEntryRepository(this.database),
      this.capabilities.piTools(),
    );
    this.#registry = new SessionRegistry(factory);
    this.#handler = new AgentTurnHandler(this.#registry, new OutboxRepository(this.database));
    return Promise.resolve();
  }

  handle(input: AcceptedTelegramInput, sessionId: string): Promise<void> {
    if (!this.#handler) return Promise.reject(new Error("Session component is not started"));
    return this.#handler.handle(input, sessionId);
  }

  stop(): Promise<void> {
    this.#registry?.dispose();
    return Promise.resolve();
  }
}
