import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AppDatabase } from "../src/persistence/database.js";
import { MaintenanceRepository } from "../src/persistence/maintenance.js";
import {
  PaperlessUploadReceiptRepository,
  type PaperlessUploadIdentity,
} from "../src/integrations/paperless/receipts.js";

const identity: PaperlessUploadIdentity = {
  updateId: "update-55",
  attachmentKey: "a".repeat(64),
  chatId: "chat-1",
  messageId: "message-9",
  senderId: "sender-1",
};

function database() {
  const value = new AppDatabase(":memory:");
  value.migrate();
  return value;
}

describe("Paperless durable upload receipts", () => {
  it("adds the receipt migration without disturbing an existing database", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperless-receipts-migration-"));
    const path = join(root, "klaus.sqlite");
    const old = new AppDatabase(path);
    old.migrate();
    old.connection
      .prepare(
        `INSERT INTO telegram_updates(update_id,chat_id,sender_id,message_id,text,state,received_at)
         VALUES ('old-update','chat','sender','message','retained','complete','2025-01-01T00:00:00.000Z')`,
      )
      .run();
    old.connection.exec(
      "DROP TABLE paperless_upload_receipts; DELETE FROM schema_migrations WHERE version=(SELECT MAX(version) FROM schema_migrations)",
    );
    old.close();

    const upgraded = new AppDatabase(path);
    upgraded.migrate();
    expect(
      upgraded.connection
        .prepare("SELECT text,state FROM telegram_updates WHERE update_id='old-update'")
        .get(),
    ).toEqual({ text: "retained", state: "complete" });
    expect(
      upgraded.connection
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='paperless_upload_receipts'",
        )
        .get(),
    ).toEqual({ name: "paperless_upload_receipts" });
    upgraded.close();
  });

  it("atomically claims one receipt and deduplicates independently of metadata and tool calls", async () => {
    const db = database();
    const receipts = new PaperlessUploadReceiptRepository(db);
    const results = await Promise.all([
      Promise.resolve().then(() => receipts.claim(identity)),
      Promise.resolve().then(() =>
        receipts.claim({ ...identity, chatId: "forged-chat", messageId: "other-message" }),
      ),
    ]);
    expect(results.filter((result) => result.claimed)).toHaveLength(1);
    expect(results[0].receipt.id).toBe(results[1].receipt.id);
    expect(results[0].receipt.state).toBe("submitting");
    expect(
      db.connection.prepare("SELECT COUNT(*) AS count FROM paperless_upload_receipts").get(),
    ).toMatchObject({ count: 1 });
    expect(receipts.findForChat(results[0].receipt.id, "forged-chat")).toBeUndefined();
    expect(receipts.findForChat(results[0].receipt.id, "chat-1")?.messageId).toBe("message-9");
    db.close();
  });

  it("persists only bounded identifiers and status, never API tokens or attachment bytes", () => {
    const db = database();
    const receipts = new PaperlessUploadReceiptRepository(db);
    const { receipt } = receipts.claim(identity);
    receipts.markAccepted(receipt.id, "f4c3b2a1-1234-4abc-9def-0123456789ab");
    receipts.recordTaskState(receipt.id, "consumed", "task_consumed", [12, 13]);
    const stored = JSON.stringify(
      db.connection.prepare("SELECT * FROM paperless_upload_receipts").get(),
    );
    expect(stored).toContain("f4c3b2a1-1234-4abc-9def-0123456789ab");
    expect(stored).toContain("[12,13]");
    expect(stored).not.toContain("paperless-secret-token");
    expect(stored).not.toContain("%PDF-");
    expect(stored).not.toContain("sensitive document bytes");
    expect(receipts.findForChat(receipt.id, "chat-1")).toMatchObject({
      state: "consumed",
      taskId: "f4c3b2a1-1234-4abc-9def-0123456789ab",
      documentIds: [12, 13],
    });
    expect(() => receipts.markAccepted(receipt.id, "not-a-uuid")).toThrow(
      "Invalid Paperless task identity",
    );
    db.close();
  });

  it("retains replay identity and task references while clearing eligible outcome details", () => {
    const db = database();
    const receipts = new PaperlessUploadReceiptRepository(db);
    const receipt = receipts.claim(identity).receipt;
    receipts.markAccepted(receipt.id, "f4c3b2a1-1234-4abc-9def-0123456789ab");
    new MaintenanceRepository(db).run(new Date(Date.now() + 1000));
    expect(receipts.findForChat(receipt.id, "chat-1")).toMatchObject({
      id: receipt.id,
      updateId: "update-55",
      state: "accepted",
      taskId: "f4c3b2a1-1234-4abc-9def-0123456789ab",
    });
    expect(receipts.findForChat(receipt.id, "chat-1")?.detailCode).toBeUndefined();
    expect(receipts.claim(identity)).toMatchObject({ claimed: false, receipt: { id: receipt.id } });
    db.close();
  });

  it("marks orphaned submissions indeterminate and preserves replay tombstones", () => {
    const db = database();
    const receipts = new PaperlessUploadReceiptRepository(db);
    const first = receipts.claim(identity).receipt;
    const second = receipts.claim({
      ...identity,
      updateId: "update-56",
      attachmentKey: "b".repeat(64),
    }).receipt;
    expect(receipts.markOrphanedSubmittingIndeterminate()).toBe(2);
    expect(receipts.findForChat(first.id, "chat-1")).toMatchObject({
      state: "indeterminate",
      detailCode: "restart_before_task_id_recorded",
    });
    expect(receipts.claim(identity)).toMatchObject({ claimed: false, receipt: { id: first.id } });
    expect(receipts.findForChat(second.id, "chat-1")?.state).toBe("indeterminate");
    db.close();
  });
});
