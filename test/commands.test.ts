import { describe, expect, it } from "vitest";

import { AppDatabase } from "../src/persistence/database.js";
import { ChatRepository, OutboxRepository } from "../src/persistence/repositories.js";
import {
  buildModelSelector,
  TelegramCommandHandler,
  type AvailableModel,
  type TelegramSessionControl,
} from "../src/telegram/command-handler.js";
import type { AcceptedTelegramInput } from "../src/telegram/types.js";

function command(
  updateId: string,
  name: "start" | "help" | "status" | "model" | "compact" | "stop" | "new" | "unknown",
  argumentsValue = "",
): AcceptedTelegramInput {
  return {
    kind: "command",
    updateId,
    chatId: "1",
    chatType: "private",
    senderId: "1",
    messageId: updateId,
    text: `/${name}`,
    command: { name, rawName: name, arguments: argumentsValue },
  };
}

function callback(updateId: string, callbackData: string): AcceptedTelegramInput {
  return {
    kind: "callback",
    updateId,
    chatId: "1",
    chatType: "private",
    senderId: "1",
    messageId: "selector",
    text: callbackData,
    callbackQueryId: `query-${updateId}`,
    callbackData,
  };
}

function fakeControl(models: AvailableModel[] = []): TelegramSessionControl & {
  selected: string[];
  compactResult: "compacted" | "nothing" | "cancelled";
  stopped: boolean;
  thinking: string[];
} {
  return {
    selected: [],
    compactResult: "nothing",
    stopped: false,
    thinking: [],
    status: async () => ({
      model: models[0] ?? { provider: "openai", id: "gpt" },
      thinkingLevel: "medium",
      stats: {
        sessionFile: undefined,
        sessionId: "session",
        userMessages: 2,
        assistantMessages: 2,
        toolCalls: 1,
        toolResults: 1,
        totalMessages: 6,
        tokens: { input: 100, output: 20, cacheRead: 30, cacheWrite: 10, total: 160 },
        cost: 0.123,
        contextUsage: { tokens: 400, contextWindow: 1000, percent: 40 },
      },
    }),
    availableModels: async () => ({ models }),
    async selectModel(_chatId, _sessionId, reference) {
      const selected = models.find(
        (model) => `${model.provider}/${model.id}`.toLowerCase() === reference.toLowerCase(),
      );
      if (!selected) throw new Error(`Model is not available: ${reference}`);
      this.selected.push(reference);
      return selected;
    },
    async setThinkingLevel(_chatId, _sessionId, level) {
      this.thinking.push(level);
      return level;
    },
    async compact() {
      return this.compactResult;
    },
    async abortCurrent() {
      return this.stopped;
    },
  };
}

function responses(
  database: AppDatabase,
): Array<{ text: string; reply_markup_json: string | null }> {
  return database.connection
    .prepare("SELECT text,reply_markup_json FROM outbox_messages ORDER BY rowid")
    .all() as Array<{ text: string; reply_markup_json: string | null }>;
}

describe("Telegram local commands", () => {
  it("renders help and status locally, including context and usage", async () => {
    const database = new AppDatabase(":memory:");
    database.migrate();
    const chats = new ChatRepository(database);
    const sessionId = chats.ensure("1", "private");
    const control = fakeControl();
    const handler = new TelegramCommandHandler(chats, new OutboxRepository(database), control);

    await handler.handle(command("1", "start"), sessionId);
    await handler.handle(command("2", "help"), sessionId);
    await handler.handle(command("3", "status"), sessionId);
    control.status = async () => ({
      model: { provider: "openai", id: "gpt" },
      thinkingLevel: "medium",
      stats: {
        sessionFile: undefined,
        sessionId: "session",
        userMessages: 0,
        assistantMessages: 0,
        toolCalls: 0,
        toolResults: 0,
        totalMessages: 0,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        cost: 0,
        contextUsage: { tokens: null, contextWindow: 1000, percent: null },
      },
    });
    await handler.handle(command("4", "status"), sessionId);

    const output = responses(database).map((row) => row.text);
    expect(output[0]).toContain("/new - Start a fresh conversation");
    expect(output[1]).toBe(output[0]);
    expect(output[2]).toContain("Model: openai/gpt");
    expect(output[2]).toContain("Total: 160");
    expect(output[2]).toContain("Context: 400 / 1,000 (40.0%)");
    expect(output[3]).toContain("Context: unknown");
    database.close();
  });

  it("starts a fresh session without changing the chat model preference", async () => {
    const database = new AppDatabase(":memory:");
    database.migrate();
    const chats = new ChatRepository(database);
    const oldSession = chats.ensure("1", "private");
    chats.setModelPreference("1", "openai", "gpt-selected");
    const handler = new TelegramCommandHandler(
      chats,
      new OutboxRepository(database),
      fakeControl(),
    );

    await handler.handle(command("1", "new"), oldSession);

    expect(chats.activeSession("1")).not.toBe(oldSession);
    expect(chats.modelPreference("1")).toEqual({ provider: "openai", modelId: "gpt-selected" });
    expect(responses(database)[0]?.text).toBe("Started a fresh conversation.");
    database.close();
  });

  it("provides paginated model controls and revalidates inline selection", async () => {
    const database = new AppDatabase(":memory:");
    database.migrate();
    const chats = new ChatRepository(database);
    const sessionId = chats.ensure("1", "private");
    const models = Array.from({ length: 10 }, (_, index) => ({
      provider: "backend",
      id: `model-${index}`,
    }));
    const control = fakeControl(models);
    const handler = new TelegramCommandHandler(chats, new OutboxRepository(database), control);

    await handler.handle(command("1", "model"), sessionId);
    const first = responses(database)[0]!;
    const markup = JSON.parse(first.reply_markup_json!) as {
      inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
    };
    expect(first.text).toContain("page 1/2, 10 available");
    expect(first.text).toContain("Reasoning: medium");
    expect(markup.inline_keyboard.flat().some((button) => button.text === "Next")).toBe(true);
    const highThinking = markup.inline_keyboard.flat().find((button) => button.text === "high");
    expect(highThinking).toBeDefined();

    await handler.handle(callback("2", highThinking!.callback_data), sessionId);
    expect(control.thinking).toEqual(["high"]);

    const selectionData = markup.inline_keyboard[0]![0]!.callback_data;
    await handler.handle(callback("2", selectionData), sessionId);
    await handler.handle(command("3", "model", "backend/model-9"), sessionId);
    expect(control.selected).toEqual(["backend/model-0", "backend/model-9"]);

    await handler.handle(callback("4", "k:model:s:stale"), sessionId);
    expect(responses(database).at(-1)?.text).toContain("stale");
    database.close();
  });

  it("handles compaction outcomes and targeted stop acknowledgements", async () => {
    const database = new AppDatabase(":memory:");
    database.migrate();
    const chats = new ChatRepository(database);
    const sessionId = chats.ensure("1", "private");
    const control = fakeControl();
    const handler = new TelegramCommandHandler(chats, new OutboxRepository(database), control);

    control.compactResult = "compacted";
    await handler.handle(command("1", "compact"), sessionId);
    control.stopped = true;
    await handler.stop(command("2", "stop"), sessionId);
    control.stopped = false;
    await handler.stop(command("3", "stop"), sessionId);

    expect(responses(database).map((row) => row.text)).toEqual(
      expect.arrayContaining(["Conversation compacted.", "Stopped.", "Nothing is running."]),
    );
    database.close();
  });

  it("keeps callback payloads bounded and every model reachable", () => {
    const models = Array.from({ length: 17 }, (_, index) => ({
      provider: "provider-with-a-long-name",
      id: `model-${index}-${"x".repeat(80)}`,
    }));
    const callbackData = [0, 1, 2]
      .flatMap((page) => buildModelSelector(models, page)?.replyMarkup.inline_keyboard.flat() ?? [])
      .map((button) => button.callback_data);
    const selectionButtons = callbackData.filter((data) => data.startsWith("k:model:s:"));
    expect(selectionButtons).toHaveLength(17);
    expect(callbackData.every((data) => Buffer.byteLength(data) <= 64)).toBe(true);
  });
});
