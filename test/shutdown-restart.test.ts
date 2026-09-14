import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { composeApplication } from "../src/app/compose.js";
import type { ServiceComponent } from "../src/app/lifecycle.js";
import { OutboxWorker } from "../src/delivery/outbox-worker.js";
import { KeyedQueue } from "../src/dispatch/keyed-queue.js";
import { AppDatabase } from "../src/persistence/database.js";
import {
  ChatRepository,
  OutboxRepository,
  SessionEntryRepository,
  ToolAuditRepository,
  UpdateRepository,
} from "../src/persistence/repositories.js";
import { PersistenceComponent, TelegramRuntimeComponent } from "../src/runtime/services.js";
import { TelegramRouter } from "../src/telegram/router.js";
import type { TelegramUpdate } from "../src/telegram/types.js";
import { TelegramTypingActivity } from "../src/telegram/typing-activity.js";

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
} {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

function passive(name: string, events: string[]): ServiceComponent {
  return {
    name,
    start() {
      events.push(`start:${name}`);
      return Promise.resolve();
    },
    stop() {
      events.push(`stop:${name}`);
      return Promise.resolve();
    },
  };
}

describe("shutdown and restart recovery", () => {
  it("aborts active work, drains it, closes integrations, and leaves durable non-replay state", async () => {
    const root = await mkdtemp(join(tmpdir(), "klaus-shutdown-"));
    const databasePath = join(root, "klaus.sqlite");
    const database = new AppDatabase(databasePath);
    database.migrate();
    const updates = new UpdateRepository(database);
    const outbox = new OutboxRepository(database);
    outbox.enqueue({
      id: "delivery",
      dedupeKey: "delivery:0",
      chatId: "1",
      sequence: 0,
      text: "pending response",
      availableAt: new Date(0),
    });

    const events: string[] = [];
    const deliveryStarted = deferred();
    const turnStarted = deferred();
    const typingStarted = deferred();
    let typingAborted = false;
    const worker = new OutboxWorker(
      outbox,
      {
        async sendMessage(_chat, _text, _reply, signal) {
          deliveryStarted.resolve();
          await new Promise<void>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(new Error("delivery aborted")), {
              once: true,
            });
          });
          return "unreachable";
        },
      },
      5,
      100,
    );
    const queue = new KeyedQueue();
    const router = new TelegramRouter(
      { allowedUsers: new Set(["1"]), allowedChats: new Set(["1"]) },
      updates,
      new ChatRepository(database),
      queue,
      new TelegramTypingActivity({
        async sendChatAction(_chatId, _action, signal) {
          typingStarted.resolve();
          await new Promise<void>((resolve) => {
            signal?.addEventListener(
              "abort",
              () => {
                typingAborted = true;
                resolve();
              },
              { once: true },
            );
          });
        },
      }),
      async () => {
        turnStarted.resolve();
        await new Promise<void>((_resolve, reject) => {
          application.signal.addEventListener("abort", () => reject(new Error("turn aborted")), {
            once: true,
          });
        });
      },
    );
    const accepted: TelegramUpdate = {
      update_id: 42,
      message: {
        message_id: 7,
        from: { id: 1 },
        chat: { id: 1, type: "private" },
        text: "start work",
      },
    };
    const fakePoller = {
      start(signal: AbortSignal) {
        events.push("poller:start");
        signal.addEventListener("abort", () => events.push("poller:abort"), { once: true });
        return router.route(accepted, { id: "99", username: "klaus_bot" }).then(() => undefined);
      },
      stop() {
        events.push("poller:stop");
        return Promise.resolve();
      },
      health() {
        return { status: "healthy" as const };
      },
    };
    const sessions: ServiceComponent = {
      name: "sessions",
      start(signal) {
        events.push("start:sessions");
        signal.addEventListener("abort", () => events.push("session:abort"), { once: true });
        return Promise.resolve();
      },
      stop() {
        events.push("stop:sessions");
        return Promise.resolve();
      },
    };
    const application = composeApplication({
      persistence: new PersistenceComponent(database),
      capabilities: passive("capabilities", events),
      sessions,
      delivery: worker,
      telegram: new TelegramRuntimeComponent(fakePoller as never, queue),
      health: passive("health", events),
    });

    await application.start();
    await Promise.all([turnStarted.promise, deliveryStarted.promise, typingStarted.promise]);
    await application.stop();
    expect(typingAborted).toBe(true);

    expect(events).toEqual(
      expect.arrayContaining([
        "poller:abort",
        "poller:stop",
        "session:abort",
        "stop:sessions",
        "stop:capabilities",
      ]),
    );
    const reopened = new AppDatabase(databasePath);
    reopened.migrate();
    expect(
      reopened.connection.prepare("SELECT state FROM telegram_updates WHERE update_id='42'").get(),
    ).toMatchObject({ state: "indeterminate" });
    expect(
      reopened.connection.prepare("SELECT state FROM outbox_messages WHERE id='delivery'").get(),
    ).toMatchObject({ state: "pending" });
    reopened.close();
  });

  it("recovers completed agent output and ambiguous MCP work without replaying either", async () => {
    const root = await mkdtemp(join(tmpdir(), "klaus-restart-"));
    const databasePath = join(root, "klaus.sqlite");
    const first = new AppDatabase(databasePath);
    first.migrate();
    const updates = new UpdateRepository(first);
    const chats = new ChatRepository(first);
    const sessionId = chats.ensure("1", "private");
    updates.claim({
      updateId: "9",
      chatId: "1",
      senderId: "1",
      messageId: "8",
      text: "turn on light",
    });
    new SessionEntryRepository(first).replace(sessionId, [
      {
        type: "custom",
        customType: "completed-turn",
        id: "entry",
        parentId: null,
        timestamp: new Date(0).toISOString(),
        data: { response: "Light is on" },
      },
    ]);
    new OutboxRepository(first).enqueue({
      id: "response",
      dedupeKey: "turn:9:0",
      chatId: "1",
      sequence: 0,
      text: "Light is on",
      availableAt: new Date(0),
    });
    new ToolAuditRepository(first).start("home", "light", { on: true }, "9");
    first.close();

    const second = new AppDatabase(databasePath);
    const persistence = new PersistenceComponent(second);
    await persistence.start();
    let repeatedTurns = 0;
    const queue = new KeyedQueue();
    const router = new TelegramRouter(
      { allowedUsers: new Set(["1"]), allowedChats: new Set(["1"]) },
      new UpdateRepository(second),
      new ChatRepository(second),
      queue,
      new TelegramTypingActivity({ sendChatAction: async () => undefined }),
      async () => {
        repeatedTurns += 1;
      },
    );
    expect(
      await router.route(
        {
          update_id: 9,
          message: {
            message_id: 8,
            from: { id: 1 },
            chat: { id: 1, type: "private" },
            text: "turn on light",
          },
        },
        { id: "99", username: "klaus_bot" },
      ),
    ).toBe(false);
    await queue.close();
    const sent: string[] = [];
    const worker = new OutboxWorker(new OutboxRepository(second), {
      sendMessage: async (_chat, text) => {
        sent.push(text);
        return "telegram-10";
      },
    });
    await worker.runOnce(new Date());

    expect(repeatedTurns).toBe(0);
    expect(sent).toEqual(["Light is on"]);
    expect(new SessionEntryRepository(second).load(sessionId)).toHaveLength(1);
    expect(
      second.connection.prepare("SELECT state FROM telegram_updates WHERE update_id='9'").get(),
    ).toMatchObject({ state: "indeterminate" });
    expect(second.connection.prepare("SELECT status FROM tool_executions").get()).toMatchObject({
      status: "indeterminate",
    });
    expect(
      second.connection.prepare("SELECT state FROM outbox_messages WHERE id='response'").get(),
    ).toMatchObject({ state: "sent" });
    await persistence.stop();
  });
});
