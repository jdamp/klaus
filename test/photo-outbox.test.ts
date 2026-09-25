import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { backupDatabase, restoreDatabase } from "../src/persistence/backup.js";
import { AppDatabase } from "../src/persistence/database.js";
import { MaintenanceRepository } from "../src/persistence/maintenance.js";
import { OutboxRepository } from "../src/persistence/repositories.js";
import { OutboxWorker } from "../src/delivery/outbox-worker.js";

const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("photo outbox persistence", () => {
  it("keeps legacy text rows and durably deduplicates photo rows", () => {
    const database = new AppDatabase(":memory:");
    database.migrate();
    const outbox = new OutboxRepository(database);
    outbox.enqueue({ dedupeKey: "text", chatId: "1", sequence: 0, text: "hello" });
    expect(
      outbox.enqueuePhoto({
        dedupeKey: "photo",
        chatId: "1",
        replyToMessageId: "9",
        sequence: 1,
        bytes: png,
        mediaType: "image/png",
      }),
    ).toBe(true);
    expect(
      outbox.enqueuePhoto({
        dedupeKey: "photo",
        chatId: "1",
        sequence: 1,
        bytes: png,
        mediaType: "image/png",
      }),
    ).toBe(false);
    const text = outbox.lease(new Date(), 10_000);
    expect(text).toMatchObject({ kind: "text", text: "hello" });
    outbox.sent(text!.id, "text-message");
    const photo = outbox.lease(new Date(), 10_000);
    expect(photo).toMatchObject({
      kind: "photo",
      chatId: "1",
      replyToMessageId: "9",
      mediaType: "image/png",
    });
    expect(photo && photo.kind === "photo" ? photo.bytes : undefined).toEqual(png);
    database.close();
  });

  it("holds generated photos until the turn response is queued", () => {
    const database = new AppDatabase(":memory:");
    database.migrate();
    const outbox = new OutboxRepository(database);
    outbox.enqueuePhoto({
      dedupeKey: "image:update-1:call-1",
      chatId: "1",
      sequence: 0,
      bytes: png,
      mediaType: "image/png",
      holdForResponse: true,
    });
    expect(outbox.lease(new Date(), 10_000)).toBeUndefined();
    outbox.enqueue({
      dedupeKey: "response:update-1:0",
      chatId: "1",
      sequence: 0,
      text: "Queued the image.",
    });
    outbox.releasePhotosForUpdate("update-1");
    const text = outbox.lease(new Date(), 10_000);
    expect(text).toMatchObject({ kind: "text", text: "Queued the image." });
    outbox.sent(text!.id, "text-message");
    expect(outbox.lease(new Date(), 10_000)).toMatchObject({ kind: "photo" });
    database.close();
  });

  it("retries a photo from stored bytes without regenerating it", async () => {
    const database = new AppDatabase(":memory:");
    database.migrate();
    const outbox = new OutboxRepository(database);
    outbox.enqueuePhoto({
      id: "photo",
      dedupeKey: "photo-retry",
      chatId: "1",
      sequence: 0,
      bytes: png,
      mediaType: "image/png",
      availableAt: new Date(0),
    });
    let calls = 0;
    let delivered: Uint8Array | undefined;
    const worker = new OutboxWorker(outbox, {
      async sendMessage() {
        throw new Error("text should not be sent");
      },
      async sendPhoto(_chat, bytes) {
        calls += 1;
        delivered = bytes;
        if (calls === 1) throw new Error("temporary");
        return "photo-message";
      },
    });
    await worker.runOnce(new Date(0));
    await worker.runOnce(new Date(2_000));
    expect(calls).toBe(2);
    expect(delivered).toEqual(png);
    expect(
      database.connection
        .prepare("SELECT state,telegram_message_id FROM outbox_messages WHERE id='photo'")
        .get(),
    ).toEqual({ state: "sent", telegram_message_id: "photo-message" });
    database.close();
  });

  it("backs up and restores pending photo bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "klaus-photo-backup-"));
    const sourcePath = join(root, "source.sqlite");
    const backupPath = join(root, "backup.sqlite");
    const restoredPath = join(root, "restored.sqlite");
    const source = new AppDatabase(sourcePath);
    source.migrate();
    new OutboxRepository(source).enqueuePhoto({
      dedupeKey: "pending-photo",
      chatId: "1",
      sequence: 0,
      bytes: png,
      mediaType: "image/png",
    });
    await backupDatabase(sourcePath, backupPath);
    source.close();
    await restoreDatabase(backupPath, restoredPath);
    const restored = new AppDatabase(restoredPath);
    restored.migrate();
    const row = new OutboxRepository(restored).lease(new Date(), 10_000);
    expect(row?.kind).toBe("photo");
    expect(row && row.kind === "photo" ? row.bytes : undefined).toEqual(png);
    restored.close();
  });

  it("erases sent photo bytes during retention but preserves pending bytes", () => {
    const database = new AppDatabase(":memory:");
    database.migrate();
    const outbox = new OutboxRepository(database);
    outbox.enqueuePhoto({
      id: "sent-photo",
      dedupeKey: "sent-photo",
      chatId: "1",
      sequence: 0,
      bytes: png,
      mediaType: "image/png",
      availableAt: new Date(0),
    });
    outbox.enqueuePhoto({
      id: "pending-photo",
      dedupeKey: "pending-photo",
      chatId: "1",
      sequence: 1,
      bytes: png,
      mediaType: "image/png",
      availableAt: new Date(0),
    });
    const first = outbox.lease(new Date(), 10_000)!;
    outbox.sent(first.id, "telegram-photo");
    new MaintenanceRepository(database).run(new Date(Date.now() + 1));
    expect(
      database.connection
        .prepare("SELECT media_blob FROM outbox_messages WHERE id='sent-photo'")
        .get(),
    ).toEqual({ media_blob: null });
    expect(
      database.connection
        .prepare("SELECT length(media_blob) AS size FROM outbox_messages WHERE id='pending-photo'")
        .get(),
    ).toEqual({ size: png.byteLength });
    database.close();
  });
});
