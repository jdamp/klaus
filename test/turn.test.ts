import { describe, expect, it } from "vitest";

import { AgentTurnHandler, UserCancelledTurnError } from "../src/agent/turn.js";
import { AppDatabase } from "../src/persistence/database.js";
import { OutboxRepository } from "../src/persistence/repositories.js";
import type { AcceptedTelegramInput } from "../src/telegram/types.js";
import type { TelegramVisualInputLoader } from "../src/telegram/visual-input.js";

const input: AcceptedTelegramInput = {
  kind: "message",
  updateId: "1",
  chatId: "10",
  chatType: "private",
  senderId: "10",
  messageId: "2",
  text: "turn on the light",
};

describe("agent turn translation", () => {
  it("persists a completed turn and enqueues its final response", async () => {
    const database = new AppDatabase(":memory:");
    database.migrate();
    let persisted = false;
    const session = {
      prompt: async () => undefined,
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Done" }],
        },
      ],
    };
    const registry = {
      consumeUserCancellation: () => false,
      get: async () => ({
        session,
        persist: () => {
          persisted = true;
        },
        dispose: () => undefined,
      }),
    };
    const handler = new AgentTurnHandler(registry as never, new OutboxRepository(database));
    await handler.handle(input, "session");
    expect(persisted).toBe(true);
    const row = database.connection
      .prepare("SELECT chat_id,text,parse_mode FROM outbox_messages")
      .get() as { chat_id: string; text: string; parse_mode: string | null };
    expect(row).toEqual({ chat_id: "10", text: "Done", parse_mode: "HTML" });
    database.close();
  });

  it("passes a validated image and attributed caption to an image-capable model", async () => {
    const database = new AppDatabase(":memory:");
    database.migrate();
    let promptText = "";
    let promptOptions: unknown;
    const handler = new AgentTurnHandler(
      {
        consumeUserCancellation: () => false,
        get: async () => ({
          session: {
            model: { input: ["text", "image"] },
            prompt: async (text: string, options: unknown) => {
              promptText = text;
              promptOptions = options;
            },
            messages: [{ role: "assistant", content: [{ type: "text", text: "Seen" }] }],
          },
          persist: () => undefined,
          dispose: () => undefined,
        }),
      } as never,
      new OutboxRepository(database),
      undefined,
      undefined,
      {
        load: async () => ({ type: "image", mimeType: "image/png", data: "cG5n" }),
      } as unknown as TelegramVisualInputLoader,
    );
    const visualInput: AcceptedTelegramInput = {
      ...input,
      text: "describe this",
      visual: { kind: "photo", variants: [{ file_id: "photo", width: 1, height: 1 }] },
    };

    await handler.handle(visualInput, "session");
    expect(promptText).toContain("describe this");
    expect(promptOptions).toEqual({
      images: [{ type: "image", mimeType: "image/png", data: "cG5n" }],
    });
    database.close();
  });

  it("rejects visual input before the model when the selected model is text-only", async () => {
    const database = new AppDatabase(":memory:");
    database.migrate();
    let loaded = false;
    const handler = new AgentTurnHandler(
      {
        consumeUserCancellation: () => false,
        get: async () => ({
          session: {
            model: { input: ["text"] },
            prompt: async () => {
              throw new Error("must not prompt");
            },
            messages: [],
          },
          persist: () => undefined,
          dispose: () => undefined,
        }),
      } as never,
      new OutboxRepository(database),
      undefined,
      undefined,
      {
        load: async () => {
          loaded = true;
          return { type: "image", mimeType: "image/png", data: "cG5n" };
        },
      } as unknown as TelegramVisualInputLoader,
    );
    await expect(
      handler.handle(
        {
          ...input,
          visual: { kind: "photo", variants: [{ file_id: "photo", width: 1, height: 1 }] },
        },
        "session",
      ),
    ).rejects.toThrow("does not support image input");
    expect(loaded).toBe(false);
    const row = database.connection.prepare("SELECT text FROM outbox_messages").get() as
      { text: string } | undefined;
    expect(row?.text).toContain("does not support image input");
    database.close();
  });

  it("persists but does not answer a user-cancelled turn", async () => {
    const database = new AppDatabase(":memory:");
    database.migrate();
    let persisted = false;
    const registry = {
      consumeUserCancellation: () => true,
      get: async () => ({
        session: {
          prompt: async () => undefined,
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "partial" }],
              stopReason: "aborted",
            },
          ],
        },
        persist: () => {
          persisted = true;
        },
        dispose: () => undefined,
      }),
    };
    const handler = new AgentTurnHandler(registry as never, new OutboxRepository(database));

    await expect(handler.handle(input, "session")).rejects.toBeInstanceOf(UserCancelledTurnError);
    expect(persisted).toBe(true);
    expect(
      database.connection.prepare("SELECT COUNT(*) AS count FROM outbox_messages").get(),
    ).toMatchObject({ count: 0 });
    database.close();
  });

  it("queues a safe error without recording a successful turn", async () => {
    const database = new AppDatabase(":memory:");
    database.migrate();
    let persisted = false;
    const registry = {
      consumeUserCancellation: () => false,
      get: async () => ({
        session: {
          prompt: async () => {
            throw new Error("provider secret detail");
          },
          messages: [],
        },
        persist: () => {
          persisted = true;
        },
        dispose: () => undefined,
      }),
    };
    const handler = new AgentTurnHandler(registry as never, new OutboxRepository(database));
    await expect(handler.handle(input, "session")).rejects.toThrow("Agent turn failed");
    expect(persisted).toBe(false);
    const row = database.connection
      .prepare("SELECT text,parse_mode FROM outbox_messages")
      .get() as { text: string; parse_mode: string | null };
    expect(row.text).not.toContain("provider secret detail");
    expect(row.parse_mode).toBeNull();
    database.close();
  });
});
