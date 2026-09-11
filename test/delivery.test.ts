import { describe, expect, it } from "vitest";

import { enqueueResponse } from "../src/delivery/intents.js";
import { OutboxWorker } from "../src/delivery/outbox-worker.js";
import { splitTelegramText } from "../src/delivery/render.js";
import { AppDatabase } from "../src/persistence/database.js";
import { OutboxRepository } from "../src/persistence/repositories.js";

describe("Telegram delivery", () => {
  it("splits safely and reconstructs the original text", () => {
    const text = "one two\n" + "🙂".repeat(20);
    const chunks = splitTelegramText(text, 10);
    expect(chunks.every((chunk) => Array.from(chunk).length <= 10)).toBe(true);
    expect(chunks.join("")).toBe(text);
  });

  it("queues ordered reply intents only for the originating chat", () => {
    const database = new AppDatabase(":memory:");
    database.migrate();
    const outbox = new OutboxRepository(database);
    enqueueResponse(outbox, { updateId: "1", chatId: "-100", messageId: "7" }, "hello");
    const row = database.connection
      .prepare("SELECT chat_id,reply_to_message_id,text FROM outbox_messages")
      .get() as Record<string, string>;
    expect(row).toEqual({ chat_id: "-100", reply_to_message_id: "7", text: "hello" });
    database.close();
  });

  it("retries transient failures without recreating work", async () => {
    const database = new AppDatabase(":memory:");
    database.migrate();
    const outbox = new OutboxRepository(database);
    const now = new Date("2026-01-01T00:00:00Z");
    outbox.enqueue({
      id: "m",
      dedupeKey: "d",
      chatId: "1",
      sequence: 0,
      text: "hello",
      availableAt: now,
    });
    let calls = 0;
    const worker = new OutboxWorker(outbox, {
      async sendMessage() {
        calls += 1;
        if (calls === 1) throw new Error("temporary");
        return "77";
      },
    });
    await worker.runOnce(now);
    await worker.runOnce(new Date(now.getTime() + 1_000));
    const row = database.connection
      .prepare("SELECT state,attempts,telegram_message_id FROM outbox_messages WHERE id='m'")
      .get() as Record<string, unknown>;
    expect(row).toMatchObject({ state: "sent", attempts: 2, telegram_message_id: "77" });
    database.close();
  });
});
