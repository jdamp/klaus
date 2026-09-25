import { describe, expect, it } from "vitest";

import { TurnContextRegistry } from "../src/agent/turn-context.js";
import { AppDatabase } from "../src/persistence/database.js";
import { ImageGenerationProvider } from "../src/image-generation/provider.js";
import { OutboxRepository, ToolAuditRepository } from "../src/persistence/repositories.js";

const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("image-generation capability", () => {
  it("publishes only to trusted turn context and returns queue state", async () => {
    const database = new AppDatabase(":memory:");
    database.migrate();
    const contexts = new TurnContextRegistry();
    contexts.set("session", {
      chatId: "-100",
      messageId: "42",
      updateId: "update-1",
      senderId: "7",
    });
    let calls = 0;
    const provider = new ImageGenerationProvider(
      {
        async generate() {
          calls += 1;
          return { bytes: png, mediaType: "image/png" as const };
        },
        health: () => ({ status: "healthy" as const }),
      },
      new OutboxRepository(database),
      new ToolAuditRepository(database),
      contexts,
      1024,
      1024,
    );
    const tool = provider.tools({ sessionId: "session" })[0]!;
    expect(tool.name).toBe("generate_image");
    expect(JSON.stringify(tool.parameters)).not.toContain("provider");
    const result = await tool.execute(
      "call-1",
      { prompt: "a small house" },
      new AbortController().signal,
      undefined,
      {} as never,
    );
    expect((result.content[0] as { text: string }).text).toContain('"status":"queued"');
    const duplicate = await tool.execute(
      "call-1",
      { prompt: "a small house" },
      new AbortController().signal,
      undefined,
      {} as never,
    );
    expect((duplicate.content[0] as { text: string }).text).toContain('"status":"already_queued"');
    expect(calls).toBe(1);
    const row = database.connection
      .prepare("SELECT chat_id,reply_to_message_id,delivery_kind FROM outbox_messages")
      .get();
    expect(row).toEqual({ chat_id: "-100", reply_to_message_id: "42", delivery_kind: "photo" });
    const audit = database.connection
      .prepare("SELECT arguments_json,result_json,tool_call_id,update_id FROM tool_executions")
      .get() as {
      arguments_json: string;
      result_json: string;
      tool_call_id: string;
      update_id: string;
    };
    expect(audit).toMatchObject({ tool_call_id: "call-1", update_id: "update-1" });
    expect(audit.arguments_json).not.toContain(Buffer.from(png).toString("base64"));
    expect(audit.result_json).not.toContain(Buffer.from(png).toString("base64"));
    database.close();
  });

  it("does not publish when cancellation wins before generation", async () => {
    const database = new AppDatabase(":memory:");
    database.migrate();
    const contexts = new TurnContextRegistry();
    contexts.set("session", { chatId: "1", messageId: "2", updateId: "3", senderId: "4" });
    const provider = new ImageGenerationProvider(
      {
        async generate() {
          throw new Error("generator must not run");
        },
      },
      new OutboxRepository(database),
      new ToolAuditRepository(database),
      contexts,
      1024,
      1024,
    );
    const controller = new AbortController();
    controller.abort();
    await expect(
      provider
        .tools({ sessionId: "session" })[0]!
        .execute("call", { prompt: "x" }, controller.signal, undefined, {} as never),
    ).rejects.toThrow("cancelled");
    expect(
      database.connection.prepare("SELECT COUNT(*) AS count FROM outbox_messages").get(),
    ).toEqual({ count: 0 });
    database.close();
  });

  it("does not expose the tool without a session binding", () => {
    const database = new AppDatabase(":memory:");
    database.migrate();
    const provider = new ImageGenerationProvider(
      {
        async generate() {
          return { bytes: png, mediaType: "image/png" as const };
        },
      },
      new OutboxRepository(database),
      new ToolAuditRepository(database),
      new TurnContextRegistry(),
      1024,
      1024,
    );
    expect(provider.tools()).toEqual([]);
    database.close();
  });
});
