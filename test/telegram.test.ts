import { describe, expect, it } from "vitest";

import { KeyedQueue } from "../src/dispatch/keyed-queue.js";
import { AppDatabase } from "../src/persistence/database.js";
import {
  ChatRepository,
  StateRepository,
  UpdateRepository,
} from "../src/persistence/repositories.js";
import { admitUpdate } from "../src/telegram/admission.js";
import type { TelegramApi } from "../src/telegram/client.js";
import { TelegramPoller } from "../src/telegram/poller.js";
import { TelegramRouter } from "../src/telegram/router.js";
import type { TelegramUpdate } from "../src/telegram/types.js";

const bot = { id: "99", username: "klaus_bot" };
const policy = { allowedUsers: new Set(["1", "2"]), allowedChats: new Set(["1", "-100"]) };

function update(overrides: Partial<TelegramUpdate> = {}): TelegramUpdate {
  return {
    update_id: 10,
    message: {
      message_id: 5,
      from: { id: 1 },
      chat: { id: 1, type: "private" },
      text: "hello",
    },
    ...overrides,
  };
}

describe("Telegram admission", () => {
  it("requires both sender and chat allowlists before exposing content", () => {
    expect(admitUpdate(update(), policy, bot)?.text).toBe("hello");
    expect(
      admitUpdate(
        update({
          message: {
            message_id: 5,
            from: { id: 3 },
            chat: { id: 1, type: "private" },
            text: "secret",
          },
        }),
        policy,
        bot,
      ),
    ).toBeUndefined();
  });

  it("requires actual mention entities, bot replies, or commands in groups", () => {
    const base = { message_id: 5, from: { id: 1 }, chat: { id: -100, type: "group" as const } };
    expect(
      admitUpdate(update({ message: { ...base, text: "@klaus_bot hi" } }), policy, bot),
    ).toBeUndefined();
    expect(
      admitUpdate(
        update({
          message: {
            ...base,
            text: "@klaus_bot hi",
            entities: [{ type: "mention", offset: 0, length: 10 }],
          },
        }),
        policy,
        bot,
      )?.text,
    ).toBe("hi");
    expect(
      admitUpdate(
        update({
          message: {
            ...base,
            text: "Klaus hi",
            entities: [{ type: "text_mention", offset: 0, length: 5, user: { id: 99 } }],
          },
        }),
        policy,
        bot,
      )?.text,
    ).toBe("hi");
    expect(
      admitUpdate(
        update({
          message: { ...base, text: "hi", reply_to_message: { from: { id: 99, is_bot: true } } },
        }),
        policy,
        bot,
      ),
    ).toBeDefined();
    expect(
      admitUpdate(
        update({
          message: {
            ...base,
            text: "/new@klaus_bot",
            entities: [{ type: "bot_command", offset: 0, length: 14 }],
          },
        }),
        policy,
        bot,
      )?.command,
    ).toBe("new");
  });

  it("ignores edited and bot-authored updates", () => {
    expect(
      admitUpdate({ update_id: 1, edited_message: update().message! }, policy, bot),
    ).toBeUndefined();
    const message = update().message!;
    expect(
      admitUpdate(update({ message: { ...message, from: { id: 1, is_bot: true } } }), policy, bot),
    ).toBeUndefined();
  });
});

describe("Telegram dispatch", () => {
  it("deduplicates, serializes a chat, and resets only the invoking chat", async () => {
    const database = new AppDatabase(":memory:");
    database.migrate();
    const chats = new ChatRepository(database);
    const updates = new UpdateRepository(database);
    const queue = new KeyedQueue();
    const seen: string[] = [];
    const router = new TelegramRouter(policy, updates, chats, queue, async (input, sessionId) => {
      seen.push(`${input.updateId}:${sessionId}`);
    });

    expect(await router.route(update(), bot)).toBe(true);
    expect(await router.route(update(), bot)).toBe(false);
    await queue.close();
    const old = chats.activeSession("1");

    const newCommand = update({
      update_id: 11,
      message: {
        ...update().message!,
        text: "/new",
        entities: [{ type: "bot_command", offset: 0, length: 4 }],
      },
    });
    const nextQueue = new KeyedQueue();
    const nextRouter = new TelegramRouter(policy, updates, chats, nextQueue, async () => undefined);
    await nextRouter.route(newCommand, bot);
    await nextQueue.close();
    expect(chats.activeSession("1")).not.toBe(old);
    expect(seen).toHaveLength(1);
    database.close();
  });

  it("allows different keys to progress concurrently while preserving same-key order", async () => {
    const queue = new KeyedQueue();
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = queue.enqueue("a", async () => {
      events.push("a1-start");
      await gate;
      events.push("a1-end");
    });
    const second = queue.enqueue("a", async () => {
      events.push("a2");
    });
    const other = queue.enqueue("b", async () => {
      events.push("b");
    });
    await other;
    expect(events).toEqual(["a1-start", "b"]);
    release();
    await Promise.all([first, second]);
    expect(events).toEqual(["a1-start", "b", "a1-end", "a2"]);
  });
});

describe("Telegram long polling", () => {
  it("resumes from and advances the durable offset", async () => {
    const database = new AppDatabase(":memory:");
    database.migrate();
    const state = new StateRepository(database);
    state.set("telegram.offset", "7");
    const offsets: number[] = [];
    const api: TelegramApi = {
      getMe: async () => bot,
      getUpdates: async (offset) => {
        offsets.push(offset);
        return [update({ update_id: 9 })];
      },
      sendMessage: async () => "1",
    };
    const poller = new TelegramPoller(api, state, 1, async () => undefined);
    expect(await poller.pollOnce()).toBe(1);
    expect(offsets).toEqual([7]);
    expect(state.get("telegram.offset")).toBe("10");
    database.close();
  });
});
