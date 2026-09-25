import { describe, expect, it } from "vitest";

import { TurnContextRegistry } from "../src/agent/turn-context.js";
import { enqueueResponse } from "../src/delivery/intents.js";
import { OutboxWorker } from "../src/delivery/outbox-worker.js";
import { AppDatabase } from "../src/persistence/database.js";
import { ImageGenerationProvider } from "../src/image-generation/provider.js";
import { OutboxRepository, ToolAuditRepository } from "../src/persistence/repositories.js";

const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("image generation delivery flow", () => {
  it("delivers the final text before the generated photo after restart-compatible leasing", async () => {
    const database = new AppDatabase(":memory:");
    database.migrate();
    const outbox = new OutboxRepository(database);
    const contexts = new TurnContextRegistry();
    contexts.set("session", {
      chatId: "1",
      messageId: "9",
      updateId: "update-1",
      senderId: "7",
    });
    let generated = 0;
    const provider = new ImageGenerationProvider(
      {
        async generate() {
          generated += 1;
          return { bytes: png, mediaType: "image/png" as const };
        },
      },
      outbox,
      new ToolAuditRepository(database),
      contexts,
      1024,
      1024,
    );
    const tool = provider.tools({ sessionId: "session" })[0]!;
    await tool.execute("call-1", { prompt: "a test image" }, undefined, undefined, {} as never);
    await tool.execute("call-1", { prompt: "a test image" }, undefined, undefined, {} as never);
    expect(generated).toBe(1);
    enqueueResponse(outbox, { updateId: "update-1", chatId: "1", messageId: "9" }, "queued");
    outbox.releasePhotosForUpdate("update-1");

    const delivered: string[] = [];
    const worker = new OutboxWorker(outbox, {
      async sendMessage() {
        delivered.push("text");
        return "text-message";
      },
      async sendPhoto(_chat, bytes) {
        expect(bytes).toEqual(png);
        delivered.push("photo");
        return "photo-message";
      },
    });
    expect(await worker.runOnce(new Date())).toBe(true);
    expect(await worker.runOnce(new Date())).toBe(true);
    expect(delivered).toEqual(["text", "photo"]);
    expect(
      database.connection
        .prepare("SELECT COUNT(*) AS count FROM outbox_messages WHERE state='sent'")
        .get(),
    ).toEqual({ count: 2 });
    database.close();
  });
});
