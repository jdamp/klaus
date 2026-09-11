import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { backupDatabase, restoreDatabase } from "../src/persistence/backup.js";
import { AppDatabase } from "../src/persistence/database.js";
import {
  ChatRepository,
  OutboxRepository,
  SessionEntryRepository,
  ToolAuditRepository,
} from "../src/persistence/repositories.js";

describe("SQLite backup and restore", () => {
  it("recovers sessions, outbox state, and tool audit state into a fresh runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "klaus-backup-"));
    const sourcePath = join(root, "source", "klaus.sqlite");
    const backupPath = join(root, "backups", "klaus.sqlite");
    const restoredPath = join(root, "restored", "klaus.sqlite");
    const source = new AppDatabase(sourcePath);
    source.migrate();
    const sessionId = new ChatRepository(source).ensure("1", "private");
    new SessionEntryRepository(source).replace(sessionId, [
      {
        type: "custom",
        customType: "memory",
        id: "remember",
        parentId: null,
        timestamp: new Date(0).toISOString(),
        data: { summary: "family context" },
      },
    ]);
    const outbox = new OutboxRepository(source);
    outbox.enqueue({
      id: "pending",
      dedupeKey: "pending:0",
      chatId: "1",
      sequence: 0,
      text: "pending response",
      availableAt: new Date(0),
    });
    outbox.enqueue({
      id: "sent",
      dedupeKey: "sent:0",
      chatId: "1",
      sequence: 0,
      text: "sent response",
      availableAt: new Date(0),
    });
    const leased = outbox.lease(new Date(), 1_000);
    expect(leased?.id).toBe("pending");
    outbox.retry("pending", new Date(Date.now() + 60_000), "later");
    const sentLease = outbox.lease(new Date(), 1_000);
    expect(sentLease?.id).toBe("sent");
    outbox.sent("sent", "telegram-2");
    const audits = new ToolAuditRepository(source);
    const completedAudit = audits.start("home", "light", { on: true });
    audits.finish(completedAudit, "success", { ok: true });
    audits.start("home", "vacuum", { start: true });

    expect(await backupDatabase(sourcePath, backupPath)).toBeGreaterThan(0);
    source.close();
    await restoreDatabase(backupPath, restoredPath);

    const restored = new AppDatabase(restoredPath);
    restored.migrate();
    expect(new SessionEntryRepository(restored).load(sessionId)).toHaveLength(1);
    expect(
      restored.connection
        .prepare("SELECT id,state,telegram_message_id FROM outbox_messages ORDER BY id")
        .all(),
    ).toEqual([
      { id: "pending", state: "pending", telegram_message_id: null },
      { id: "sent", state: "sent", telegram_message_id: "telegram-2" },
    ]);
    expect(
      restored.connection
        .prepare("SELECT tool_name,status FROM tool_executions ORDER BY tool_name")
        .all(),
    ).toEqual([
      { tool_name: "light", status: "success" },
      { tool_name: "vacuum", status: "started" },
    ]);
    expect(new ToolAuditRepository(restored).markInterruptedIndeterminate()).toBe(1);
    restored.close();
  });

  it("refuses to overwrite a database during backup or restore", async () => {
    const root = await mkdtemp(join(tmpdir(), "klaus-backup-safe-"));
    const databasePath = join(root, "klaus.sqlite");
    const database = new AppDatabase(databasePath);
    database.migrate();
    await expect(backupDatabase(databasePath, databasePath)).rejects.toThrow("must differ");
    await expect(restoreDatabase(databasePath, databasePath)).rejects.toThrow("must differ");
    database.close();
  });
});
