import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

import { PiSessionFactory } from "../agent/pi-runtime.js";
import { SessionRegistry } from "../agent/session-registry.js";
import { AgentTurnHandler } from "../agent/turn.js";
import type { ServiceComponent } from "../app/lifecycle.js";
import type { AppConfig } from "../config.js";
import type { CapabilityCatalog } from "../capabilities/types.js";
import type { AppDatabase } from "../persistence/database.js";
import {
  ChatRepository,
  OutboxRepository,
  SessionEntryRepository,
  ToolAuditRepository,
  UpdateRepository,
} from "../persistence/repositories.js";
import type { AcceptedTelegramInput } from "../telegram/types.js";
import type { MemoryRepository } from "../memory/repository.js";
import type { MemoryTurnContextRegistry } from "../memory/context.js";
import type { KeyedQueue } from "../dispatch/keyed-queue.js";
import type { TelegramPoller } from "../telegram/poller.js";
import type {
  AvailableModel,
  SessionStatus,
  TelegramSessionControl,
} from "../telegram/command-handler.js";

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
    new UpdateRepository(this.database).markInterruptedIndeterminate();
    new ToolAuditRepository(this.database).markInterruptedIndeterminate();
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
  constructor(readonly catalog: CapabilityCatalog) {}
  start(signal: AbortSignal): Promise<void> {
    return this.catalog.start(signal);
  }
  stop(): Promise<void> {
    return this.catalog.stop();
  }
  health() {
    const states = Object.values(this.catalog.health());
    const unhealthy = states.find((state) => state.status === "unhealthy");
    const degraded = states.find((state) => state.status === "degraded");
    return unhealthy ?? degraded ?? { status: "healthy" as const };
  }
}

export class SessionComponent implements ServiceComponent, TelegramSessionControl {
  readonly name = "sessions";
  #registry?: SessionRegistry;
  #handler?: AgentTurnHandler;
  #chats?: ChatRepository;

  constructor(
    private readonly config: AppConfig,
    private readonly runtime: ModelRuntime,
    private readonly database: AppDatabase,
    private readonly capabilities: CapabilityCatalog,
    private readonly systemPrompt?: string,
    private readonly memory?: {
      repository: MemoryRepository;
      contexts: MemoryTurnContextRegistry;
    },
  ) {}

  start(signal: AbortSignal): Promise<void> {
    const factory = new PiSessionFactory(
      this.config,
      this.runtime,
      new SessionEntryRepository(this.database),
      (sessionId) => this.capabilities.tools({ sessionId }),
      this.systemPrompt,
      this.memory?.contexts,
    );
    this.#registry = new SessionRegistry(factory);
    this.#chats = new ChatRepository(this.database);
    signal.addEventListener("abort", () => void this.#registry?.abortAll(), { once: true });
    this.#handler = new AgentTurnHandler(
      this.#registry,
      new OutboxRepository(this.database),
      this.#chats,
      this.memory,
    );
    return Promise.resolve();
  }

  handle(input: AcceptedTelegramInput, sessionId: string): Promise<void> {
    if (!this.#handler) return Promise.reject(new Error("Session component is not started"));
    return this.#handler.handle(input, sessionId);
  }

  async status(chatId: string, sessionId: string): Promise<SessionStatus> {
    const managed = await this.#get(chatId, sessionId);
    const model = managed.session.model;
    const preferredModel = this.#chats?.modelPreference(chatId);
    return {
      ...(model ? { model: { provider: model.provider, id: model.id } } : {}),
      thinkingLevel: managed.session.thinkingLevel,
      availableThinkingLevels: managed.session.getAvailableThinkingLevels(),
      stats: managed.session.getSessionStats(),
      ...(preferredModel ? { preferredModel } : {}),
    };
  }

  async availableModels(refresh: boolean): Promise<{ models: AvailableModel[]; warning?: string }> {
    let warning: string | undefined;
    if (refresh) {
      try {
        const result = await this.runtime.refresh({
          allowNetwork: true,
          signal: AbortSignal.timeout(15_000),
        });
        if (result.aborted) warning = "Model refresh timed out; showing cached models.";
        else if (result.errors.size > 0)
          warning = "Some model catalogues could not refresh; showing available cached models.";
      } catch {
        warning = "Model refresh failed; showing cached models.";
      }
    }
    let available;
    try {
      available = await this.runtime.getAvailable(undefined, {
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      available = this.runtime.getAvailableSnapshot();
      warning ??= "Model availability check failed; showing cached models.";
    }
    const models = available
      .map((model) => ({ provider: model.provider, id: model.id }))
      .sort((left, right) =>
        `${left.provider}/${left.id}`.localeCompare(`${right.provider}/${right.id}`),
      );
    return { models, ...(warning ? { warning } : {}) };
  }

  async selectModel(chatId: string, sessionId: string, reference: string): Promise<AvailableModel> {
    const { models } = await this.availableModels(false);
    const normalized = reference.trim().toLowerCase();
    const matches = models.filter(
      (model) => `${model.provider}/${model.id}`.toLowerCase() === normalized,
    );
    const match = matches[0];
    if (matches.length !== 1 || !match) throw new Error(`Model is not available: ${reference}`);
    const selected = this.runtime.getModel(match.provider, match.id);
    if (!selected) throw new Error(`Model is not available: ${reference}`);
    const managed = await this.#get(chatId, sessionId);
    await managed.session.setModel(selected);
    managed.persist();
    this.#chats?.setModelPreference(chatId, selected.provider, selected.id);
    return { provider: selected.provider, id: selected.id };
  }

  async setThinkingLevel(
    chatId: string,
    sessionId: string,
    level: ThinkingLevel,
  ): Promise<ThinkingLevel> {
    const managed = await this.#get(chatId, sessionId);
    managed.session.setThinkingLevel(level);
    managed.persist();
    return managed.session.thinkingLevel;
  }

  async compact(chatId: string, sessionId: string): Promise<"compacted" | "nothing" | "cancelled"> {
    const managed = await this.#get(chatId, sessionId);
    try {
      await managed.session.compact();
      managed.persist();
      return "compacted";
    } catch (error) {
      if (this.#registry?.consumeUserCancellation(sessionId)) {
        managed.persist();
        return "cancelled";
      }
      const message = error instanceof Error ? error.message : String(error);
      if (message === "Already compacted" || message === "Nothing to compact (session too small)") {
        return "nothing";
      }
      throw error;
    }
  }

  abortCurrent(sessionId: string): Promise<boolean> {
    return this.#registry?.abortForUser(sessionId) ?? Promise.resolve(false);
  }

  #get(chatId: string, sessionId: string) {
    if (!this.#registry || !this.#chats) {
      return Promise.reject(new Error("Session component is not started"));
    }
    return this.#registry.get(sessionId, this.#chats.modelPreference(chatId));
  }

  async stop(): Promise<void> {
    await this.#registry?.abortAll();
    this.#registry?.dispose();
  }
}
