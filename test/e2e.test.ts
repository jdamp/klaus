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
import { TelegramRouter } from "../src/telegram/router.js";
import type { TelegramUpdate } from "../src/telegram/types.js";

describe("reactive home-agent flow", () => {
  it("authorizes, invokes a model/tool facade, persists, delivers, and suppresses redelivery", async () => {
    const database = new AppDatabase(":memory:");
    database.migrate();
    const outbox = new OutboxRepository(database);
    let toolCalls = 0;
    let persisted = 0;
    const sessions = {
      get: async () => ({
        session: {
          prompt: async () => {
            toolCalls += 1;
          },
          messages: [{ role: "assistant", content: [{ type: "text", text: "Light is on" }] }],
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

    const sent: Array<{ chat: string; text: string }> = [];
    const worker = new OutboxWorker(outbox, {
      sendMessage: async (chat, text) => {
        sent.push({ chat, text });
        return "10";
      },
    });
    await worker.runOnce();
    expect({ toolCalls, persisted, sent }).toEqual({
      toolCalls: 1,
      persisted: 1,
      sent: [{ chat: "-100", text: "Light is on" }],
    });
    database.close();
  });
});
