import { describe, expect, it } from "vitest";

import { UserCancelledTurnError } from "../src/agent/turn.js";
import { KeyedQueue } from "../src/dispatch/keyed-queue.js";
import { AppDatabase } from "../src/persistence/database.js";
import {
  ChatRepository,
  StateRepository,
  UpdateRepository,
} from "../src/persistence/repositories.js";
import { admitUpdate } from "../src/telegram/admission.js";
import { TelegramHttpClient, type TelegramApi } from "../src/telegram/client.js";
import { TelegramPoller } from "../src/telegram/poller.js";
import { TelegramRouter } from "../src/telegram/router.js";
import type { TelegramUpdate } from "../src/telegram/types.js";
import { TelegramTypingActivity } from "../src/telegram/typing-activity.js";

const bot = { id: "99", username: "klaus_bot" };
const policy = { allowedUsers: new Set(["1", "2"]), allowedChats: new Set(["1", "-100"]) };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function typing(actions: string[] = []): TelegramTypingActivity {
  return new TelegramTypingActivity({
    sendChatAction: async (chatId, action) => {
      actions.push(`${chatId}:${action}`);
    },
  });
}

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

describe("Telegram HTTP client", () => {
  it("sends native typing actions with the supplied abort signal", async () => {
    const controller = new AbortController();
    let request: { url: string; body: unknown; signal?: AbortSignal } | undefined;
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      if (typeof init?.body !== "string") throw new Error("Expected a JSON request body");
      request = {
        url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        body: JSON.parse(init.body),
        ...(init.signal ? { signal: init.signal } : {}),
      };
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    await new TelegramHttpClient("token", fetcher).sendChatAction(
      "-100",
      "typing",
      controller.signal,
    );

    expect(request).toEqual({
      url: "https://api.telegram.org/bottoken/sendChatAction",
      body: { chat_id: "-100", action: "typing" },
      signal: controller.signal,
    });
  });

  it("registers commands, answers callbacks, and sends inline keyboards", async () => {
    const requests: Array<{ method: string; body: Record<string, unknown> }> = [];
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      if (typeof init?.body !== "string") throw new Error("Expected a JSON request body");
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const method = url.split("/").pop()!;
      requests.push({ method, body: JSON.parse(init.body) as Record<string, unknown> });
      const result =
        method === "sendMessage" ? { message_id: 7 } : method === "getUpdates" ? [] : true;
      return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
    }) as typeof fetch;
    const client = new TelegramHttpClient("token", fetcher);
    const keyboard = {
      inline_keyboard: [[{ text: "Model", callback_data: "k:model:s:test" }]],
    };

    await client.setMyCommands([{ command: "status", description: "Show status" }], {
      type: "all_private_chats",
    });
    await client.answerCallbackQuery("callback", "Selected");
    expect(await client.sendMessage("1", "Choose", "5", undefined, keyboard)).toBe("7");
    await client.getUpdates(10, 30);

    expect(requests).toEqual([
      {
        method: "setMyCommands",
        body: {
          commands: [{ command: "status", description: "Show status" }],
          scope: { type: "all_private_chats" },
        },
      },
      {
        method: "answerCallbackQuery",
        body: { callback_query_id: "callback", text: "Selected" },
      },
      {
        method: "sendMessage",
        body: {
          chat_id: "1",
          text: "Choose",
          reply_parameters: { message_id: "5" },
          reply_markup: keyboard,
        },
      },
      {
        method: "getUpdates",
        body: {
          offset: 10,
          timeout: 30,
          allowed_updates: ["message", "callback_query"],
        },
      },
    ]);
  });
});

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
      ),
    ).toMatchObject({ kind: "command", command: { name: "new" } });
  });

  it("parses private commands and rejects commands addressed to another bot", () => {
    const privateCommand = admitUpdate(
      update({
        message: {
          ...update().message!,
          text: "/MODEL OpenAI/GPT",
          entities: [{ type: "bot_command", offset: 0, length: 6 }],
        },
      }),
      policy,
      bot,
    );
    expect(privateCommand).toMatchObject({
      kind: "command",
      command: { name: "model", arguments: "OpenAI/GPT" },
    });
    expect(
      admitUpdate(
        update({
          message: {
            message_id: 5,
            from: { id: 1 },
            chat: { id: -100, type: "group" },
            text: "/status@other_bot",
            entities: [{ type: "bot_command", offset: 0, length: 17 }],
          },
        }),
        policy,
        bot,
      ),
    ).toBeUndefined();
    expect(
      admitUpdate(
        update({
          message: {
            ...update().message!,
            text: "/missing",
            entities: [{ type: "bot_command", offset: 0, length: 8 }],
          },
        }),
        policy,
        bot,
      ),
    ).toMatchObject({ kind: "command", command: { name: "unknown", rawName: "missing" } });
  });

  it("authorizes only valid callbacks from this bot", () => {
    const callback = {
      update_id: 30,
      callback_query: {
        id: "callback",
        from: { id: 1 },
        data: "k:model:p:1",
        message: {
          message_id: 8,
          from: { id: 99, is_bot: true },
          chat: { id: -100, type: "group" as const },
          text: "models",
        },
      },
    };
    expect(admitUpdate(callback, policy, bot)).toMatchObject({
      kind: "callback",
      callbackQueryId: "callback",
      chatId: "-100",
    });
    expect(
      admitUpdate(
        {
          ...callback,
          callback_query: { ...callback.callback_query, from: { id: 3 } },
        },
        policy,
        bot,
      ),
    ).toBeUndefined();
    expect(
      admitUpdate(
        {
          ...callback,
          callback_query: {
            ...callback.callback_query,
            message: { ...callback.callback_query.message, from: { id: 98, is_bot: true } },
          },
        },
        policy,
        bot,
      ),
    ).toBeUndefined();
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
    const router = new TelegramRouter(
      policy,
      updates,
      chats,
      queue,
      typing(),
      async (input, sessionId) => {
        seen.push(`${input.updateId}:${sessionId}`);
      },
    );

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
    const nextRouter = new TelegramRouter(
      policy,
      updates,
      chats,
      nextQueue,
      typing(),
      async () => undefined,
      {
        handle: async (input) => {
          if (input.kind === "command" && input.command.name === "new") {
            chats.newSession(input.chatId);
          }
        },
        stop: async () => undefined,
      },
    );
    await nextRouter.route(newCommand, bot);
    await nextQueue.close();
    expect(chats.activeSession("1")).not.toBe(old);
    expect(seen).toHaveLength(1);
    database.close();
  });

  it("starts typing only at the queue front and supports concurrent chats", async () => {
    const database = new AppDatabase(":memory:");
    database.migrate();
    const queue = new KeyedQueue();
    const actions: string[] = [];
    const firstStarted = deferred();
    const secondStarted = deferred();
    const otherStarted = deferred();
    const releaseFirst = deferred();
    const releaseOther = deferred();
    const router = new TelegramRouter(
      policy,
      new UpdateRepository(database),
      new ChatRepository(database),
      queue,
      typing(actions),
      async (input) => {
        if (input.updateId === "10") {
          firstStarted.resolve();
          await releaseFirst.promise;
        } else if (input.updateId === "11") {
          secondStarted.resolve();
        } else {
          otherStarted.resolve();
          await releaseOther.promise;
        }
      },
    );

    await router.route(update(), bot);
    await firstStarted.promise;
    await router.route(update({ update_id: 11 }), bot);
    await Promise.resolve();
    expect(actions).toEqual(["1:typing"]);

    await router.route(
      update({
        update_id: 12,
        message: {
          message_id: 6,
          from: { id: 2 },
          chat: { id: -100, type: "group" },
          text: "@klaus_bot hello",
          entities: [{ type: "mention", offset: 0, length: 10 }],
        },
      }),
      bot,
    );
    await otherStarted.promise;
    expect(actions).toEqual(["1:typing", "-100:typing"]);

    releaseFirst.resolve();
    await secondStarted.promise;
    expect(actions).toEqual(["1:typing", "-100:typing", "1:typing"]);
    releaseOther.resolve();
    await queue.close();
    database.close();
  });

  it("deduplicates authorized callbacks while acknowledging redelivery", async () => {
    const database = new AppDatabase(":memory:");
    database.migrate();
    const queue = new KeyedQueue();
    let handled = 0;
    let acknowledged = 0;
    const router = new TelegramRouter(
      policy,
      new UpdateRepository(database),
      new ChatRepository(database),
      queue,
      typing(),
      async () => undefined,
      {
        handle: async () => {
          handled += 1;
        },
        stop: async () => undefined,
      },
      async () => {
        acknowledged += 1;
      },
    );
    const callback: TelegramUpdate = {
      update_id: 31,
      callback_query: {
        id: "query",
        from: { id: 1 },
        data: "k:model:p:0",
        message: {
          message_id: 9,
          from: { id: 99, is_bot: true },
          chat: { id: -100, type: "group" },
          text: "models",
        },
      },
    };

    expect(await router.route(callback, bot)).toBe(true);
    expect(await router.route(callback, bot)).toBe(false);
    await queue.close();
    await Promise.resolve();
    expect({ handled, acknowledged }).toEqual({ handled: 1, acknowledged: 2 });
    database.close();
  });

  it("routes stop immediately outside queued work and records user cancellation", async () => {
    const database = new AppDatabase(":memory:");
    database.migrate();
    const updates = new UpdateRepository(database);
    const chats = new ChatRepository(database);
    const queue = new KeyedQueue();
    const started = deferred();
    const release = deferred();
    let stopped = false;
    const router = new TelegramRouter(
      policy,
      updates,
      chats,
      queue,
      typing(),
      async () => {
        started.resolve();
        await release.promise;
        throw new UserCancelledTurnError();
      },
      {
        handle: async () => undefined,
        stop: async () => {
          stopped = true;
          release.resolve();
        },
      },
    );

    await router.route(update(), bot);
    await started.promise;
    await router.route(
      update({
        update_id: 11,
        message: {
          ...update().message!,
          text: "/stop",
          entities: [{ type: "bot_command", offset: 0, length: 5 }],
        },
      }),
      bot,
    );
    expect(stopped).toBe(true);
    await queue.close();
    expect(
      database.connection.prepare("SELECT state FROM telegram_updates WHERE update_id='10'").get(),
    ).toMatchObject({ state: "cancelled" });
    expect(
      database.connection.prepare("SELECT state FROM telegram_updates WHERE update_id='11'").get(),
    ).toMatchObject({ state: "complete" });
    database.close();
  });

  it("resolves the active session after a queued new command", async () => {
    const database = new AppDatabase(":memory:");
    database.migrate();
    const chats = new ChatRepository(database);
    const oldSession = chats.ensure("1", "private");
    const queue = new KeyedQueue();
    const seen: string[] = [];
    const router = new TelegramRouter(
      policy,
      new UpdateRepository(database),
      chats,
      queue,
      typing(),
      async (_input, sessionId) => {
        seen.push(sessionId);
      },
      {
        handle: async (input) => {
          if (input.kind === "command" && input.command.name === "new")
            chats.newSession(input.chatId);
        },
        stop: async () => undefined,
      },
    );
    await router.route(
      update({
        update_id: 20,
        message: {
          ...update().message!,
          text: "/new",
          entities: [{ type: "bot_command", offset: 0, length: 4 }],
        },
      }),
      bot,
    );
    await router.route(update({ update_id: 21 }), bot);
    await queue.close();
    expect(seen).toEqual([chats.activeSession("1")]);
    expect(seen[0]).not.toBe(oldSession);
    database.close();
  });

  it("does not type for ignored or duplicate updates and isolates turn failures", async () => {
    const database = new AppDatabase(":memory:");
    database.migrate();
    const queue = new KeyedQueue();
    const actions: string[] = [];
    const router = new TelegramRouter(
      policy,
      new UpdateRepository(database),
      new ChatRepository(database),
      queue,
      typing(actions),
      async () => {
        throw new Error("turn failed");
      },
    );
    const message = update().message!;

    expect(
      await router.route(
        update({ message: { ...message, from: { id: 3 }, text: "unauthorized" } }),
        bot,
      ),
    ).toBe(false);
    expect(
      await router.route({ update_id: 20, edited_message: { ...message, text: "edited" } }, bot),
    ).toBe(false);
    expect(
      await router.route(
        update({
          update_id: 21,
          message: { ...message, from: { id: 1, is_bot: true }, text: "automated" },
        }),
        bot,
      ),
    ).toBe(false);
    expect(
      await router.route(
        update({
          update_id: 22,
          message: {
            message_id: 7,
            from: { id: 1 },
            chat: { id: -100, type: "group" },
            text: "ambient",
          },
        }),
        bot,
      ),
    ).toBe(false);
    expect(actions).toEqual([]);

    expect(await router.route(update(), bot)).toBe(true);
    expect(await router.route(update(), bot)).toBe(false);
    await queue.close();
    expect(actions).toEqual(["1:typing"]);
    expect(
      database.connection.prepare("SELECT state FROM telegram_updates WHERE update_id='10'").get(),
    ).toMatchObject({ state: "indeterminate" });
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
  it("synchronizes all command scopes before polling", async () => {
    const database = new AppDatabase(":memory:");
    database.migrate();
    const scopes: string[] = [];
    const external = new AbortController();
    const api: TelegramApi = {
      getMe: async () => bot,
      setMyCommands: async (commands, scope) => {
        expect(commands.map((command) => command.command)).toEqual([
          "start",
          "status",
          "model",
          "compact",
          "stop",
          "new",
        ]);
        scopes.push(scope.type);
      },
      getUpdates: async (_offset, _timeout, signal) => {
        await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve()));
        return [];
      },
      sendMessage: async () => "1",
      sendChatAction: async () => undefined,
      answerCallbackQuery: async () => undefined,
    };
    const poller = new TelegramPoller(api, new StateRepository(database), 1, async () => undefined);
    await poller.start(external.signal);
    external.abort();
    await poller.stop();
    expect(scopes).toEqual(["default", "all_private_chats", "all_group_chats"]);
    database.close();
  });

  it("fails startup visibly when command synchronization fails", async () => {
    const database = new AppDatabase(":memory:");
    database.migrate();
    let polls = 0;
    const api: TelegramApi = {
      getMe: async () => bot,
      setMyCommands: async (_commands, scope) => {
        if (scope.type === "all_private_chats") throw new Error("registration failed");
      },
      getUpdates: async () => {
        polls += 1;
        return [];
      },
      sendMessage: async () => "1",
      sendChatAction: async () => undefined,
      answerCallbackQuery: async () => undefined,
    };
    const poller = new TelegramPoller(api, new StateRepository(database), 1, async () => undefined);
    await expect(poller.start(new AbortController().signal)).rejects.toThrow("registration failed");
    expect(polls).toBe(0);
    database.close();
  });

  it("resumes from and advances the durable offset", async () => {
    const database = new AppDatabase(":memory:");
    database.migrate();
    const state = new StateRepository(database);
    state.set("telegram.offset", "7");
    const offsets: number[] = [];
    const api: TelegramApi = {
      getMe: async () => bot,
      setMyCommands: async () => undefined,
      getUpdates: async (offset) => {
        offsets.push(offset);
        return [update({ update_id: 9 })];
      },
      sendMessage: async () => "1",
      sendChatAction: async () => undefined,
      answerCallbackQuery: async () => undefined,
    };
    const poller = new TelegramPoller(api, state, 1, async () => undefined);
    expect(await poller.pollOnce()).toBe(1);
    expect(offsets).toEqual([7]);
    expect(state.get("telegram.offset")).toBe("10");
    database.close();
  });
});
