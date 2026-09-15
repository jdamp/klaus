import { describe, expect, it } from "vitest";

import { AgentTurnHandler } from "../src/agent/turn.js";
import { KeyedQueue } from "../src/dispatch/keyed-queue.js";
import { OutboxWorker } from "../src/delivery/outbox-worker.js";
import { AppDatabase } from "../src/persistence/database.js";
import {
  ChatRepository,
  OutboxRepository,
  UpdateRepository,
} from "../src/persistence/repositories.js";
import { TelegramCommandHandler } from "../src/telegram/command-handler.js";
import { TelegramRouter } from "../src/telegram/router.js";
import type { TelegramUpdate } from "../src/telegram/types.js";
import { TelegramTypingActivity } from "../src/telegram/typing-activity.js";

describe("reactive home-agent flow", () => {
  it("authorizes, invokes a model/tool facade, persists, delivers, and suppresses redelivery", async () => {
    const database = new AppDatabase(":memory:");
    database.migrate();
    const outbox = new OutboxRepository(database);
    let toolCalls = 0;
    let persisted = 0;
    const sessions = {
      consumeUserCancellation: () => false,
      get: async () => ({
        session: {
          prompt: async () => {
            toolCalls += 1;
          },
          messages: [{ role: "assistant", content: [{ type: "text", text: "**Light is on**" }] }],
        },
        persist: () => {
          persisted += 1;
        },
        dispose: () => undefined,
      }),
    };
    const turns = new AgentTurnHandler(sessions as never, outbox);
    const queue = new KeyedQueue();
    const router = new TelegramRouter(
      { allowedUsers: new Set(["1"]), allowedChats: new Set(["-100"]) },
      new UpdateRepository(database),
      new ChatRepository(database),
      queue,
      new TelegramTypingActivity({ sendChatAction: async () => undefined }),
      (input, sessionId) => turns.handle(input, sessionId),
    );
    const accepted: TelegramUpdate = {
      update_id: 8,
      message: {
        message_id: 9,
        from: { id: 1 },
        chat: { id: -100, type: "group" },
        text: "@klaus_bot turn on light",
        entities: [{ type: "mention", offset: 0, length: 10 }],
      },
    };
    const ambient: TelegramUpdate = {
      update_id: 7,
      message: {
        message_id: 8,
        from: { id: 1 },
        chat: { id: -100, type: "group" },
        text: "family chat",
      },
    };
    expect(await router.route(ambient, { id: "99", username: "klaus_bot" })).toBe(false);
    expect(await router.route(accepted, { id: "99", username: "klaus_bot" })).toBe(true);
    expect(await router.route(accepted, { id: "99", username: "klaus_bot" })).toBe(false);
    await queue.close();

    const sent: Array<{ chat: string; text: string; parseMode?: string }> = [];
    const worker = new OutboxWorker(outbox, {
      sendMessage: async (chat, text, _reply, _signal, _markup, parseMode) => {
        sent.push({ chat, text, ...(parseMode ? { parseMode } : {}) });
        return "10";
      },
    });
    await worker.runOnce();
    expect({ toolCalls, persisted, sent }).toEqual({
      toolCalls: 1,
      persisted: 1,
      sent: [{ chat: "-100", text: "<b>Light is on</b>", parseMode: "HTML" }],
    });
    database.close();
  });

  it("handles equivalent private and group controls locally with per-chat model preferences", async () => {
    const database = new AppDatabase(":memory:");
    database.migrate();
    const outbox = new OutboxRepository(database);
    const chats = new ChatRepository(database);
    const queue = new KeyedQueue();
    let agentCalls = 0;
    const models = [
      { provider: "backend", id: "one" },
      { provider: "backend", id: "two" },
    ];
    const control = {
      status: async (_chatId: string, sessionId: string) => ({
        model: models[0]!,
        thinkingLevel: "medium" as const,
        availableThinkingLevels: [
          "off",
          "minimal",
          "low",
          "medium",
          "high",
          "xhigh",
          "max",
        ] as const,
        stats: {
          sessionFile: undefined,
          sessionId,
          userMessages: 1,
          assistantMessages: 1,
          toolCalls: 0,
          toolResults: 0,
          totalMessages: 2,
          tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
          cost: 0.01,
          contextUsage: { tokens: 20, contextWindow: 100, percent: 20 },
        },
      }),
      availableModels: async () => ({ models }),
      selectModel: async (chatId: string, _sessionId: string, reference: string) => {
        const selected = models.find((model) => `${model.provider}/${model.id}` === reference);
        if (!selected) throw new Error("unavailable");
        chats.setModelPreference(chatId, selected.provider, selected.id);
        return selected;
      },
      setThinkingLevel: async (
        _chatId: string,
        _sessionId: string,
        level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
      ) => level,
      compact: async () => "nothing" as const,
      abortCurrent: async () => false,
    };
    const commands = new TelegramCommandHandler(chats, outbox, control);
    const router = new TelegramRouter(
      { allowedUsers: new Set(["1"]), allowedChats: new Set(["1", "-100"]) },
      new UpdateRepository(database),
      chats,
      queue,
      new TelegramTypingActivity({ sendChatAction: async () => undefined }),
      async () => {
        agentCalls += 1;
      },
      commands,
    );
    const privateCommand = (id: number, text: string, length: number): TelegramUpdate => ({
      update_id: id,
      message: {
        message_id: id,
        from: { id: 1 },
        chat: { id: 1, type: "private" },
        text,
        entities: [{ type: "bot_command", offset: 0, length }],
      },
    });
    const groupCommand = (id: number, text: string, length: number): TelegramUpdate => ({
      update_id: id,
      message: {
        message_id: id,
        from: { id: 1 },
        chat: { id: -100, type: "group" },
        text,
        entities: [{ type: "bot_command", offset: 0, length }],
      },
    });

    await router.route(privateCommand(20, "/status", 7), { id: "99", username: "klaus_bot" });
    await router.route(groupCommand(21, "/status@klaus_bot", 17), {
      id: "99",
      username: "klaus_bot",
    });
    await router.route(privateCommand(22, "/model backend/one", 6), {
      id: "99",
      username: "klaus_bot",
    });
    await router.route(groupCommand(23, "/model@klaus_bot backend/two", 16), {
      id: "99",
      username: "klaus_bot",
    });
    await queue.close();
    const beforeNew = chats.activeSession("1");
    const newQueue = new KeyedQueue();
    const newRouter = new TelegramRouter(
      { allowedUsers: new Set(["1"]), allowedChats: new Set(["1", "-100"]) },
      new UpdateRepository(database),
      chats,
      newQueue,
      new TelegramTypingActivity({ sendChatAction: async () => undefined }),
      async () => {
        agentCalls += 1;
      },
      commands,
    );
    await newRouter.route(privateCommand(24, "/new", 4), { id: "99", username: "klaus_bot" });
    await newQueue.close();

    expect(agentCalls).toBe(0);
    expect(chats.activeSession("1")).not.toBe(beforeNew);
    expect(chats.modelPreference("1")).toEqual({ provider: "backend", modelId: "one" });
    expect(chats.modelPreference("-100")).toEqual({ provider: "backend", modelId: "two" });
    expect(
      database.connection.prepare("SELECT COUNT(*) AS count FROM outbox_messages").get(),
    ).toMatchObject({ count: 5 });
    database.close();
  });
});
