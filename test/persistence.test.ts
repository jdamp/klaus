import { describe, expect, it } from "vitest";

import { AppDatabase } from "../src/persistence/database.js";
import {
  ChatRepository,
  OutboxRepository,
  SessionEntryRepository,
  ToolAuditRepository,
  UpdateRepository,
} from "../src/persistence/repositories.js";

function updatesForCancellation(database: AppDatabase): void {
  const updates = new UpdateRepository(database);
  expect(
    updates.claim({
      updateId: "cancelled-update",
      chatId: "1",
      senderId: "1",
      messageId: "8",
      text: "/stop",
    }),
  ).toBe(true);
  updates.finish("cancelled-update", "cancelled", "stopped by user");
  expect(
    database.connection
      .prepare("SELECT state FROM telegram_updates WHERE update_id='cancelled-update'")
      .get(),
  ).toMatchObject({ state: "cancelled" });
  expect(
    updates.claim({
      updateId: "cancelled-update",
      chatId: "1",
      senderId: "1",
      messageId: "8",
      text: "/stop",
    }),
  ).toBe(false);
}

describe("SQLite persistence", () => {
  it("migrates idempotently in WAL mode", () => {
    const database = new AppDatabase(":memory:");
    database.migrate();
    database.migrate();
    const tables = database.connection
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    expect(tables.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        "chats",
        "chat_model_preferences",
        "telegram_updates",
        "session_entries",
        "tool_executions",
        "outbox_messages",
      ]),
    );
    database.close();
  });

  it("upgrades the original schema without losing update or outbox rows", () => {
    const database = new AppDatabase(":memory:");
    database.connection.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations VALUES (1, 'old');
      CREATE TABLE chats (
        chat_id TEXT PRIMARY KEY, chat_type TEXT NOT NULL, active_session_id TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE telegram_updates (
        update_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, sender_id TEXT NOT NULL,
        message_id TEXT NOT NULL, text TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('claimed','complete','failed','indeterminate')),
        failure TEXT, received_at TEXT NOT NULL, completed_at TEXT
      );
      CREATE TABLE outbox_messages (
        id TEXT PRIMARY KEY, dedupe_key TEXT NOT NULL UNIQUE, chat_id TEXT NOT NULL,
        reply_to_message_id TEXT, sequence INTEGER NOT NULL, text TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending','leased','sent','cancelled')),
        attempts INTEGER NOT NULL DEFAULT 0, available_at TEXT NOT NULL, lease_until TEXT,
        telegram_message_id TEXT, last_error TEXT, created_at TEXT NOT NULL, sent_at TEXT
      );
      CREATE INDEX outbox_ready_idx ON outbox_messages(state, available_at, sequence);
      INSERT INTO chats VALUES ('1','private','session','old','old');
      INSERT INTO telegram_updates VALUES ('u','1','1','1','hello','complete',NULL,'old','old');
      INSERT INTO outbox_messages(
        id,dedupe_key,chat_id,sequence,text,state,available_at,created_at
      ) VALUES ('o','d','1',0,'reply','pending','old','old');
    `);

    database.migrate();

    expect(
      database.connection
        .prepare("SELECT text,state FROM telegram_updates WHERE update_id='u'")
        .get(),
    ).toEqual({ text: "hello", state: "complete" });
    expect(
      database.connection
        .prepare("SELECT text,reply_markup_json FROM outbox_messages WHERE id='o'")
        .get(),
    ).toEqual({ text: "reply", reply_markup_json: null });
    expect(
      database.connection
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='outbox_ready_idx'")
        .get(),
    ).toBeDefined();
    database.close();
  });

  it("deduplicates updates and isolates ordered session entries", () => {
    const database = new AppDatabase(":memory:");
    database.migrate();
    const chats = new ChatRepository(database);
    const updates = new UpdateRepository(database);
    const sessions = new SessionEntryRepository(database);
    const sessionId = chats.ensure("1", "private");

    expect(
      updates.claim({ updateId: "10", chatId: "1", senderId: "1", messageId: "5", text: "hello" }),
    ).toBe(true);
    expect(
      updates.claim({ updateId: "10", chatId: "1", senderId: "1", messageId: "5", text: "hello" }),
    ).toBe(false);

    const entries = [
      {
        type: "custom",
        customType: "test",
        id: "a",
        parentId: null,
        timestamp: new Date(0).toISOString(),
        data: { order: 1 },
      },
      {
        type: "custom",
        customType: "test",
        id: "b",
        parentId: "a",
        timestamp: new Date(1).toISOString(),
        data: { order: 2 },
      },
    ] as const;
    sessions.replace(sessionId, entries);
    expect(sessions.load(sessionId).map((entry) => entry.id)).toEqual(["a", "b"]);
    chats.setModelPreference("1", "openai", "gpt-test");
    chats.ensure("2", "private");
    chats.setModelPreference("2", "anthropic", "claude-test");
    expect(chats.modelPreference("1")).toEqual({ provider: "openai", modelId: "gpt-test" });
    expect(chats.modelPreference("2")).toEqual({
      provider: "anthropic",
      modelId: "claude-test",
    });
    expect(chats.newSession("1")).not.toBe(sessionId);
    expect(chats.modelPreference("1")).toEqual({ provider: "openai", modelId: "gpt-test" });
    database.close();
  });

  it("leases, retries, sends, cancels, deduplicates, and audits outbox work", () => {
    const database = new AppDatabase(":memory:");
    database.migrate();
    const outbox = new OutboxRepository(database);
    const audits = new ToolAuditRepository(database);
    const now = new Date("2026-01-01T00:00:00Z");

    expect(
      outbox.enqueue({
        id: "one",
        dedupeKey: "turn:1:0",
        chatId: "1",
        sequence: 0,
        text: "x",
        replyMarkup: {
          inline_keyboard: [[{ text: "Select", callback_data: "k:model:s:test" }]],
        },
        availableAt: now,
      }),
    ).toBe(true);
    expect(
      outbox.enqueue({
        id: "two",
        dedupeKey: "turn:1:0",
        chatId: "1",
        sequence: 0,
        text: "x",
        availableAt: now,
      }),
    ).toBe(false);
    const firstLease = outbox.lease(now, 1_000);
    expect(firstLease).toMatchObject({
      attempts: 1,
      replyMarkup: {
        inline_keyboard: [[{ text: "Select", callback_data: "k:model:s:test" }]],
      },
    });
    outbox.retry("one", now, "temporary");
    expect(outbox.lease(now, 1_000)?.attempts).toBe(2);
    outbox.sent("one", "99");

    outbox.enqueue({
      id: "cancel",
      dedupeKey: "turn:2:0",
      chatId: "1",
      sequence: 0,
      text: "y",
      availableAt: now,
    });
    outbox.cancel("cancel");
    expect(outbox.lease(now, 1_000)).toBeUndefined();
    expect(() =>
      outbox.enqueue({
        dedupeKey: "invalid-keyboard",
        chatId: "1",
        sequence: 0,
        text: "invalid",
        replyMarkup: { inline_keyboard: [] },
      }),
    ).toThrow("Invalid Telegram inline keyboard");

    updatesForCancellation(database);

    const outcomes = ["success", "failure", "timeout", "cancelled"] as const;
    for (const outcome of outcomes) {
      const auditId = audits.start("home", "light", { token: "[REDACTED]" });
      audits.finish(auditId, outcome, { ok: outcome === "success" });
    }
    const interrupted = audits.start("home", "vacuum", {});
    expect(audits.markInterruptedIndeterminate()).toBe(1);
    const rows = database.connection
      .prepare("SELECT status FROM tool_executions ORDER BY status")
      .all() as Array<{ status: string }>;
    expect(rows.map((row) => row.status).sort()).toEqual(
      ["success", "failure", "timeout", "cancelled", "indeterminate"].sort(),
    );
    const row = database.connection
      .prepare("SELECT status FROM tool_executions WHERE id=?")
      .get(interrupted) as { status: string };
    expect(row.status).toBe("indeterminate");
    database.close();
  });
});
