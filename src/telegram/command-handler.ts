import { createHash } from "node:crypto";

import type { SessionStats } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

import { enqueueResponse } from "../delivery/intents.js";
import type { ChatRepository, OutboxRepository } from "../persistence/repositories.js";
import { commandHelp } from "./commands.js";
import type { AcceptedTelegramInput, TelegramInlineKeyboardMarkup } from "./types.js";
import type { MemoryRepository } from "../memory/repository.js";

export type AvailableModel = { provider: string; id: string };
export type SessionStatus = {
  model?: AvailableModel;
  thinkingLevel: ThinkingLevel;
  availableThinkingLevels?: readonly ThinkingLevel[];
  stats: SessionStats;
  preferredModel?: { provider: string; modelId: string };
};

export interface TelegramSessionControl {
  status(chatId: string, sessionId: string): Promise<SessionStatus>;
  availableModels(refresh: boolean): Promise<{ models: AvailableModel[]; warning?: string }>;
  selectModel(chatId: string, sessionId: string, reference: string): Promise<AvailableModel>;
  setThinkingLevel(chatId: string, sessionId: string, level: ThinkingLevel): Promise<ThinkingLevel>;
  compact(chatId: string, sessionId: string): Promise<"compacted" | "nothing" | "cancelled">;
  abortCurrent(sessionId: string): Promise<boolean>;
}

const MODEL_PAGE_SIZE = 8;
const CALLBACK_PREFIX = "k:model:";
const DEFAULT_THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

function modelReference(model: AvailableModel): string {
  return `${model.provider}/${model.id}`;
}

function modelDigest(model: AvailableModel): string {
  return createHash("sha256")
    .update(`${model.provider}\0${model.id}`)
    .digest("base64url")
    .slice(0, 16);
}

function buttonText(model: AvailableModel, current?: AvailableModel): string {
  const reference = modelReference(model);
  const selected = current?.provider === model.provider && current.id === model.id ? "* " : "";
  const maximum = 60 - selected.length;
  return `${selected}${reference.length > maximum ? `${reference.slice(0, maximum - 3)}...` : reference}`;
}

export function buildModelSelector(
  models: readonly AvailableModel[],
  requestedPage: number,
  current?: AvailableModel,
  thinkingLevel?: ThinkingLevel,
  availableThinkingLevels: readonly ThinkingLevel[] = DEFAULT_THINKING_LEVELS,
): { text: string; replyMarkup: TelegramInlineKeyboardMarkup } | undefined {
  if (models.length === 0) return undefined;
  const pages = Math.ceil(models.length / MODEL_PAGE_SIZE);
  if (!Number.isInteger(requestedPage) || requestedPage < 0 || requestedPage >= pages) {
    return undefined;
  }
  const start = requestedPage * MODEL_PAGE_SIZE;
  const pageModels = models.slice(start, start + MODEL_PAGE_SIZE);
  const rows = pageModels.map((model) => [
    {
      text: buttonText(model, current),
      callback_data: `${CALLBACK_PREFIX}s:${modelDigest(model)}`,
    },
  ]);
  if (availableThinkingLevels.length > 0) {
    rows.push(
      availableThinkingLevels.map((level) => ({
        text: `${level === thinkingLevel ? "* " : ""}${level}`,
        callback_data: `${CALLBACK_PREFIX}t:${level}`,
      })),
    );
  }
  const navigation = [];
  if (requestedPage > 0) {
    navigation.push({
      text: "Previous",
      callback_data: `${CALLBACK_PREFIX}p:${requestedPage - 1}`,
    });
  }
  if (requestedPage + 1 < pages) {
    navigation.push({ text: "Next", callback_data: `${CALLBACK_PREFIX}p:${requestedPage + 1}` });
  }
  if (navigation.length > 0) rows.push(navigation);
  return {
    text: `Select a model (page ${requestedPage + 1}/${pages}, ${models.length} available).\nCurrent: ${current ? modelReference(current) : "unknown"}${thinkingLevel ? `\nReasoning: ${thinkingLevel}` : ""}`,
    replyMarkup: { inline_keyboard: rows },
  };
}

function safeCommandError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message.startsWith("Model is not available:")) return message;
  return "The command could not be completed.";
}

function formatStatus(status: SessionStatus): string {
  const { stats } = status;
  const context = stats.contextUsage;
  const contextText =
    !context || context.tokens === null || context.percent === null
      ? "unknown"
      : `${context.tokens.toLocaleString()} / ${context.contextWindow.toLocaleString()} (${context.percent.toFixed(1)}%)`;
  const active = status.model ? modelReference(status.model) : "unknown";
  const preferred = status.preferredModel
    ? `${status.preferredModel.provider}/${status.preferredModel.modelId}`
    : undefined;
  return [
    `Model: ${active}`,
    ...(preferred && preferred !== active
      ? [`Preferred model: ${preferred} (currently unavailable)`]
      : []),
    `Reasoning: ${status.thinkingLevel}`,
    "",
    "Session usage:",
    `Input: ${stats.tokens.input.toLocaleString()}`,
    `Output: ${stats.tokens.output.toLocaleString()}`,
    `Cache read: ${stats.tokens.cacheRead.toLocaleString()}`,
    `Cache write: ${stats.tokens.cacheWrite.toLocaleString()}`,
    `Total: ${stats.tokens.total.toLocaleString()}`,
    `Cost: $${stats.cost.toFixed(3)}`,
    `Context: ${contextText}`,
  ].join("\n");
}

export class TelegramCommandHandler {
  constructor(
    private readonly chats: ChatRepository,
    private readonly outbox: OutboxRepository,
    private readonly sessions: TelegramSessionControl,
    private readonly memory?: MemoryRepository,
  ) {}

  async handle(input: AcceptedTelegramInput, sessionId: string): Promise<void> {
    try {
      if (input.kind === "callback") {
        await this.#handleCallback(input, sessionId);
        return;
      }
      if (input.kind !== "command") throw new Error("Expected a Telegram command");
      switch (input.command.name) {
        case "start":
        case "help":
          enqueueResponse(this.outbox, input, commandHelp());
          return;
        case "status":
          enqueueResponse(
            this.outbox,
            input,
            formatStatus(await this.sessions.status(input.chatId, sessionId)),
          );
          return;
        case "model":
          await this.#handleModelCommand(input, sessionId);
          return;
        case "compact": {
          const result = await this.sessions.compact(input.chatId, sessionId);
          if (result !== "cancelled") {
            enqueueResponse(
              this.outbox,
              input,
              result === "compacted" ? "Conversation compacted." : "Nothing to compact.",
            );
          }
          return;
        }
        case "new":
          this.chats.newSession(input.chatId);
          enqueueResponse(this.outbox, input, "Started a fresh conversation.");
          return;
        case "memory":
          this.#handleMemoryCommand(input);
          return;
        case "stop":
          await this.stop(input, sessionId);
          return;
        case "unknown":
          enqueueResponse(
            this.outbox,
            input,
            `Unsupported command: /${input.command.rawName}\n\n${commandHelp()}`,
          );
      }
    } catch (error) {
      enqueueResponse(this.outbox, input, `Command failed: ${safeCommandError(error)}`);
    }
  }

  #handleMemoryCommand(input: AcceptedTelegramInput): void {
    if (input.kind !== "command") return;
    if (!this.memory) {
      enqueueResponse(this.outbox, input, "Memory is unavailable.");
      return;
    }
    const argumentsValue = input.command.arguments.trim();
    if (!argumentsValue) {
      this.#sendMemoryPage(input, 1);
      return;
    }
    const parts = argumentsValue.split(/\s+/);
    if (parts[0]?.toLowerCase() === "list") {
      if (parts.length !== 2 || !/^\d+$/.test(parts[1] ?? "")) {
        enqueueResponse(this.outbox, input, "Usage: /memory list <positive-page>");
        return;
      }
      const page = Number(parts[1]);
      if (page < 1) {
        enqueueResponse(this.outbox, input, "Usage: /memory list <positive-page>");
        return;
      }
      this.#sendMemoryPage(input, page);
      return;
    }
    if (parts.length !== 1) {
      enqueueResponse(this.outbox, input, "Usage: /memory [list <page>|<note-id>]");
      return;
    }
    const note = this.memory.read(parts[0]!);
    if (!note) {
      enqueueResponse(this.outbox, input, `Memory note not found: ${parts[0]}`);
      return;
    }
    const metadata = [
      `Memory note: ${note.title}`,
      `ID: ${note.id}`,
      `Revision: ${note.revision}`,
      `Tags: ${note.tags.length > 0 ? note.tags.join(", ") : "(none)"}`,
      `Updated: ${note.updatedAt}`,
      "",
      "--- stored body (literal) ---",
      note.body,
    ].join("\n");
    enqueueResponse(this.outbox, input, metadata);
  }

  #sendMemoryPage(input: AcceptedTelegramInput, page: number): void {
    const result = this.memory!.list({ page });
    if (result.items.length === 0) {
      enqueueResponse(this.outbox, input, `Memory page ${page} is not available.`);
      return;
    }
    const lines = [
      `Memory — page ${page}`,
      ...result.items.flatMap((item) => [
        "",
        `${item.id} — ${item.title} (revision ${item.revision})`,
        item.preview || "(empty)",
      ]),
      "",
      "Open a note with /memory <note-id>.",
      ...(result.nextPage ? [`Next page: /memory list ${result.nextPage}`] : []),
    ];
    enqueueResponse(this.outbox, input, lines.join("\n"));
  }

  async stop(input: AcceptedTelegramInput, sessionId: string): Promise<void> {
    try {
      const stopped = await this.sessions.abortCurrent(sessionId);
      enqueueResponse(this.outbox, input, stopped ? "Stopped." : "Nothing is running.");
    } catch {
      enqueueResponse(this.outbox, input, "Could not stop the current operation.");
    }
  }

  async #handleModelCommand(input: AcceptedTelegramInput, sessionId: string): Promise<void> {
    if (input.kind !== "command") return;
    if (input.command.arguments) {
      const selected = await this.sessions.selectModel(
        input.chatId,
        sessionId,
        input.command.arguments,
      );
      enqueueResponse(this.outbox, input, `Model selected: ${modelReference(selected)}`);
      return;
    }
    await this.#sendModelPage(input, sessionId, 0, true);
  }

  async #handleCallback(input: AcceptedTelegramInput, sessionId: string): Promise<void> {
    if (input.kind !== "callback") return;
    const action = input.callbackData.slice(CALLBACK_PREFIX.length);
    if (action.startsWith("p:")) {
      const page = Number(action.slice(2));
      await this.#sendModelPage(input, sessionId, page, false);
      return;
    }
    if (action.startsWith("t:")) {
      const level = action.slice(2);
      const status = await this.sessions.status(input.chatId, sessionId);
      const availableThinkingLevels = status.availableThinkingLevels ?? DEFAULT_THINKING_LEVELS;
      if (!availableThinkingLevels.includes(level as ThinkingLevel)) {
        enqueueResponse(this.outbox, input, "That reasoning choice is stale. Open /model again.");
        return;
      }
      const selected = await this.sessions.setThinkingLevel(
        input.chatId,
        sessionId,
        level as ThinkingLevel,
      );
      enqueueResponse(this.outbox, input, `Reasoning selected: ${selected}`);
      return;
    }
    if (action.startsWith("s:")) {
      const digest = action.slice(2);
      const { models } = await this.sessions.availableModels(false);
      const matches = models.filter((model) => modelDigest(model) === digest);
      const match = matches[0];
      if (matches.length !== 1 || !match) {
        enqueueResponse(this.outbox, input, "That model choice is stale. Open /model again.");
        return;
      }
      const selected = await this.sessions.selectModel(
        input.chatId,
        sessionId,
        modelReference(match),
      );
      enqueueResponse(this.outbox, input, `Model selected: ${modelReference(selected)}`);
      return;
    }
    enqueueResponse(this.outbox, input, "That model control is invalid. Open /model again.");
  }

  async #sendModelPage(
    input: AcceptedTelegramInput,
    sessionId: string,
    page: number,
    refresh: boolean,
  ): Promise<void> {
    const [{ models, warning }, status] = await Promise.all([
      this.sessions.availableModels(refresh),
      this.sessions.status(input.chatId, sessionId),
    ]);
    const selector = buildModelSelector(
      models,
      page,
      status.model,
      status.thinkingLevel,
      status.availableThinkingLevels,
    );
    if (!selector) {
      enqueueResponse(
        this.outbox,
        input,
        models.length === 0
          ? "No models are available from authenticated backends."
          : "That model page is stale. Open /model again.",
      );
      return;
    }
    enqueueResponse(
      this.outbox,
      input,
      warning ? `${warning}\n\n${selector.text}` : selector.text,
      selector.replyMarkup,
    );
  }
}
