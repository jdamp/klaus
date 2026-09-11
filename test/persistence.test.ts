import { describe, expect, it } from "vitest";

import { AppDatabase } from "../src/persistence/database.js";
import {
  ChatRepository,
  OutboxRepository,
  SessionEntryRepository,
  ToolAuditRepository,
  UpdateRepository,
} from "../src/persistence/repositories.js";

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
        "telegram_updates",
        "session_entries",
        "tool_executions",
        "outbox_messages",
      ]),
    );
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
    expect(chats.newSession("1")).not.toBe(sessionId);
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
    expect(outbox.lease(now, 1_000)?.attempts).toBe(1);
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
