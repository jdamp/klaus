import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { AgentTurnHandler } from "../src/agent/turn.js";
import { TurnContextRegistry } from "../src/agent/turn-context.js";
import { PaperlessProvider } from "../src/integrations/paperless/provider.js";
import type { PaperlessConfig, PaperlessFetch } from "../src/integrations/paperless/client.js";
import { PaperlessUploadReceiptRepository } from "../src/integrations/paperless/receipts.js";
import { AppDatabase } from "../src/persistence/database.js";
import {
  ChatRepository,
  OutboxRepository,
  ToolAuditRepository,
  UpdateRepository,
} from "../src/persistence/repositories.js";
import { SecretRedactor } from "../src/security/secrets.js";
import { KeyedQueue } from "../src/dispatch/keyed-queue.js";
import { admitUpdate } from "../src/telegram/admission.js";
import { TelegramUploadFileLoader } from "../src/telegram/upload-file.js";
import { TelegramRouter } from "../src/telegram/router.js";
import type { TelegramApi } from "../src/telegram/client.js";
import type { TelegramUpdate } from "../src/telegram/types.js";
import { TelegramTypingActivity } from "../src/telegram/typing-activity.js";

const token = "paperless-e2e-token";
const taskId = "f4c3b2a1-1234-4abc-9def-0123456789ab";
const pdf = new TextEncoder().encode("%PDF-1.7\nnever send these bytes to the model");
const bot = { id: "99", username: "klaus_bot" };
const config: PaperlessConfig = {
  baseUrl: "https://paperless.test",
  publicUrl: "https://docs.test/paperless",
  apiTokenFile: "/secret",
  requestTimeoutMs: 1000,
  uploadTimeoutMs: 5000,
  downloadTimeoutMs: 1000,
  maxResponseBytes: 10000,
  maxResultBytes: 10000,
  maxUploadBytes: 1000,
};

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "X-Api-Version": "10", "X-Version": "3.2.1" },
  });
}

function toolText(result: unknown): string {
  if (!result || typeof result !== "object" || !("content" in result))
    throw new Error("Missing tool output");
  const content = result.content;
  if (!Array.isArray(content) || !content[0] || typeof content[0] !== "object")
    throw new Error("Malformed tool output");
  const text = (content[0] as { text?: unknown }).text;
  if (typeof text !== "string") throw new Error("Missing tool text");
  return text;
}

describe("Paperless Telegram end-to-end", () => {
  it("admits private/group turns, uploads only the current explicitly requested file, and restores its origin-scoped receipt", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperless-e2e-"));
    const databasePath = join(root, "klaus.sqlite");
    let database = new AppDatabase(databasePath);
    database.migrate();
    let postCount = 0;
    let statusReads = 0;
    const fetcher: PaperlessFetch = async (input, init) => {
      const url =
        input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
      if (url.pathname === "/api/documents/" && url.searchParams.get("fields") === "id") {
        return response({ count: 0, results: [] });
      }
      if (url.pathname === "/api/documents/post_document/") {
        postCount += 1;
        expect(new Headers(init?.headers).get("authorization")).toBe(`Token ${token}`);
        expect(init?.body).toBeInstanceOf(FormData);
        return response({ task_id: taskId });
      }
      if (url.pathname === "/api/tasks/") {
        statusReads += 1;
        return response({
          count: 1,
          results: [{ task_id: taskId, status: "success", related_document_ids: [42] }],
        });
      }
      if (url.pathname === "/api/documents/42/") {
        return response({ id: 42, title: "Household invoice", content: "private OCR body" });
      }
      throw new Error(`Unexpected Paperless request ${url.pathname}`);
    };
    const apiCalls = {
      getFile: vi.fn(async () => ({ file_path: "telegram/file", file_size: pdf.length })),
    };
    const telegramApi = {
      ...apiCalls,
      downloadFile: vi.fn(async () => new Uint8Array(pdf)),
    } as unknown as TelegramApi;
    const contexts = new TurnContextRegistry();
    let provider: PaperlessProvider;
    let activeReceiptId = "";
    const promptOptions: unknown[] = [];

    const createProvider = (db: AppDatabase, registry: TurnContextRegistry) =>
      new PaperlessProvider(
        config,
        token,
        new ToolAuditRepository(db),
        new SecretRedactor(),
        registry,
        new Set(["1", "-100"]),
        new Set(["1"]),
        fetcher,
        new PaperlessUploadReceiptRepository(db),
        new TelegramUploadFileLoader(telegramApi, config.maxUploadBytes, config.downloadTimeoutMs),
      );
    provider = createProvider(database, contexts);
    await provider.start(new AbortController().signal);

    const sessions = {
      consumeUserCancellation: () => false,
      get: async (sessionId: string) => {
        const messages: Array<{ role: string; content: Array<{ type: string; text?: string }> }> =
          [];
        const session = {
          prompt: async (text: string, options?: unknown) => {
            promptOptions.push(options);
            let answer: string;
            if (text.includes("upload this bill")) {
              const tool = provider
                .tools({ sessionId })
                .find((candidate) => candidate.name === "paperless_upload_document");
              if (!tool) throw new Error("Missing upload tool");
              const result = await tool.execute(
                `upload-${activeReceiptId || "first"}`,
                {},
                new AbortController().signal,
                undefined,
                {} as never,
              );
              const output = toolText(result);
              const match = output.match(/"receiptId":"([0-9a-f-]{36})"/u);
              if (!match) throw new Error("Upload tool returned no receipt identity");
              activeReceiptId = match[1]!;
              answer = `Paperless accepted the request. Receipt ${activeReceiptId}.`;
            } else if (text.includes("check receipt") || text.includes("check the group receipt")) {
              const tool = provider
                .tools({ sessionId })
                .find((candidate) => candidate.name === "paperless_get_upload_status");
              if (!tool) throw new Error("Missing status tool");
              const result = await tool.execute(
                "status-check",
                { receiptId: activeReceiptId },
                new AbortController().signal,
                undefined,
                {} as never,
              );
              answer = `Receipt status: ${toolText(result)}`;
            } else {
              answer = "I can help with the document; I will not archive it unless you ask.";
            }
            messages.push({ role: "assistant", content: [{ type: "text", text: answer }] });
          },
          messages,
        };
        return { session, persist: () => undefined, dispose: () => undefined };
      },
    };
    const outbox = new OutboxRepository(database);
    const handler = new AgentTurnHandler(
      sessions as never,
      outbox,
      undefined,
      undefined,
      undefined,
      contexts,
    );
    const chats = new ChatRepository(database);
    const updates = new UpdateRepository(database);
    const queue = new KeyedQueue();
    const router = new TelegramRouter(
      {
        allowedUsers: new Set(["1"]),
        allowedChats: new Set(["1", "-100"]),
        paperlessEnabled: true,
      },
      updates,
      chats,
      queue,
      new TelegramTypingActivity({ sendChatAction: async () => undefined }),
      (input, sessionId) => handler.handle(input, sessionId),
    );
    const waitForChat = (chatId: string) => queue.enqueue(chatId, async () => undefined);
    const pdfMessage = (
      updateId: number,
      chatId: number,
      caption: string,
      mention = false,
    ): TelegramUpdate => ({
      update_id: updateId,
      message: {
        message_id: updateId,
        from: { id: 1 },
        chat: { id: chatId, type: chatId === -100 ? "group" : "private" },
        document: {
          file_id: `telegram-file-${updateId}`,
          file_name: "../../invoice.pdf",
          mime_type: "application/pdf",
          file_size: pdf.length,
        },
        caption,
        ...(mention ? { caption_entities: [{ type: "mention", offset: 0, length: 10 }] } : {}),
      },
    });

    const privateQuestion = pdfMessage(10, 1, "What kind of bill is this?");
    expect(
      admitUpdate(
        privateQuestion,
        {
          allowedUsers: new Set(["1"]),
          allowedChats: new Set(["1", "-100"]),
          paperlessEnabled: true,
        },
        bot,
      )?.uploadAttachment,
    ).toBeDefined();
    expect(await router.route(privateQuestion, bot)).toBe(true);
    await waitForChat("1");
    expect(apiCalls.getFile).not.toHaveBeenCalled();

    const ambient = pdfMessage(11, -100, "upload this bill");
    expect(await router.route(ambient, bot)).toBe(false);
    const unauthorized = pdfMessage(12, -100, "@klaus_bot upload this bill", true);
    unauthorized.message!.from = { id: 2 };
    expect(await router.route(unauthorized, bot)).toBe(false);
    expect(apiCalls.getFile).not.toHaveBeenCalled();

    const groupUpload = pdfMessage(13, -100, "@klaus_bot upload this bill", true);
    expect(await router.route(groupUpload, bot)).toBe(true);
    await waitForChat("-100");
    expect(postCount).toBe(1);
    expect(apiCalls.getFile).toHaveBeenCalledOnce();
    expect(promptOptions.every((options) => options === undefined)).toBe(true);
    expect(await router.route(groupUpload, bot)).toBe(false);
    expect(postCount).toBe(1);

    const groupReplyStatus: TelegramUpdate = {
      update_id: 14,
      message: {
        message_id: 14,
        from: { id: 1 },
        chat: { id: -100, type: "group" },
        text: "check receipt",
        reply_to_message: { from: { id: 99, is_bot: true } },
      },
    };

    database.close();
    database = new AppDatabase(databasePath);
    database.migrate();
    const restoredReceipt = new PaperlessUploadReceiptRepository(database).findForChat(
      activeReceiptId,
      "-100",
    );
    expect(restoredReceipt).toMatchObject({ state: "accepted", taskId });

    const restartedContexts = new TurnContextRegistry();
    provider = createProvider(database, restartedContexts);
    await provider.start(new AbortController().signal);
    const restartedHandler = new AgentTurnHandler(
      sessions as never,
      new OutboxRepository(database),
      undefined,
      undefined,
      undefined,
      restartedContexts,
    );
    const restartedQueue = new KeyedQueue();
    const restartedRouter = new TelegramRouter(
      {
        allowedUsers: new Set(["1"]),
        allowedChats: new Set(["1", "-100"]),
        paperlessEnabled: true,
      },
      new UpdateRepository(database),
      new ChatRepository(database),
      restartedQueue,
      new TelegramTypingActivity({ sendChatAction: async () => undefined }),
      (input, sessionId) => restartedHandler.handle(input, sessionId),
    );
    const privateStatus: TelegramUpdate = {
      update_id: 15,
      message: {
        message_id: 15,
        from: { id: 1 },
        chat: { id: 1, type: "private" },
        text: "check the group receipt",
      },
    };
    expect(await restartedRouter.route(privateStatus, bot)).toBe(true);
    await restartedQueue.enqueue("1", async () => undefined);
    expect(statusReads).toBe(0);

    const statusAccepted = await restartedRouter.route(groupReplyStatus, bot);
    expect(statusAccepted).toBe(true);
    await restartedQueue.enqueue("-100", async () => undefined);
    expect(statusReads).toBe(1);

    const rows = database.connection
      .prepare(
        "SELECT chat_id,reply_to_message_id,text FROM outbox_messages ORDER BY created_at,sequence",
      )
      .all() as Array<{ chat_id: string; reply_to_message_id: string | null; text: string }>;
    expect(rows.some((row) => row.chat_id === "1" && row.text.includes("will not archive"))).toBe(
      true,
    );
    expect(
      rows.some(
        (row) =>
          row.chat_id === "-100" &&
          row.reply_to_message_id === "13" &&
          row.text.includes(activeReceiptId),
      ),
    ).toBe(true);
    expect(
      rows.some(
        (row) =>
          row.chat_id === "1" &&
          row.reply_to_message_id === "15" &&
          row.text.includes("could not complete"),
      ),
    ).toBe(true);
    expect(
      rows.filter((row) => row.chat_id === "1").every((row) => !row.text.includes(activeReceiptId)),
    ).toBe(true);
    expect(
      rows.some(
        (row) =>
          row.chat_id === "-100" &&
          row.reply_to_message_id === "14" &&
          row.text.includes("consumed"),
      ),
    ).toBe(true);
    expect(rows.map((row) => row.text).join(" ")).not.toContain(
      "never send these bytes to the model",
    );
    expect(rows.map((row) => row.text).join(" ")).not.toContain(token);
    expect(statusReads).toBe(1);
    expect(postCount).toBe(1);
    await queue.close();
    await restartedQueue.close();
    database.close();
  });
});
