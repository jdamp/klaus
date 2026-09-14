import { describe, expect, it } from "vitest";

import { AgentTurnHandler, UserCancelledTurnError } from "../src/agent/turn.js";
import { AppDatabase } from "../src/persistence/database.js";
import { OutboxRepository } from "../src/persistence/repositories.js";
import type { AcceptedTelegramInput } from "../src/telegram/types.js";

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
    const row = database.connection.prepare("SELECT chat_id,text FROM outbox_messages").get() as {
      chat_id: string;
      text: string;
    };
    expect(row).toEqual({ chat_id: "10", text: "Done" });
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
    const row = database.connection.prepare("SELECT text FROM outbox_messages").get() as {
      text: string;
    };
    expect(row.text).not.toContain("provider secret detail");
    database.close();
  });
});
