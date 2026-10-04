import { describe, expect, it, vi } from "vitest";

import { PaperlessProvider } from "../src/integrations/paperless/provider.js";
import type { PaperlessConfig, PaperlessFetch } from "../src/integrations/paperless/client.js";
import { PaperlessUploadReceiptRepository } from "../src/integrations/paperless/receipts.js";
import { AppDatabase } from "../src/persistence/database.js";
import { ToolAuditRepository } from "../src/persistence/repositories.js";
import { SecretRedactor } from "../src/security/secrets.js";
import { TurnContextRegistry } from "../src/agent/turn-context.js";
import { TelegramUploadFileLoader } from "../src/telegram/upload-file.js";
import type { TelegramApi } from "../src/telegram/client.js";
import type { TelegramUploadAttachment } from "../src/telegram/types.js";

const config: PaperlessConfig = {
  baseUrl: "https://paperless.test",
  publicUrl: "https://docs.test/archive",
  apiTokenFile: "/token",
  requestTimeoutMs: 1000,
  uploadTimeoutMs: 5000,
  downloadTimeoutMs: 1000,
  maxResponseBytes: 10000,
  maxResultBytes: 10000,
  maxUploadBytes: 1000,
};
const taskId = "f4c3b2a1-1234-4abc-9def-0123456789ab";
const pdfBytes = new TextEncoder().encode("%PDF-1.7\nprivate household file");

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "X-Api-Version": "10", "X-Version": "3.2.1" },
  });
}

const attachment: TelegramUploadAttachment = {
  kind: "document",
  document: {
    file_id: "telegram-current-file-id",
    file_name: "../../electricity.pdf",
    mime_type: "application/pdf",
    file_size: pdfBytes.byteLength,
  },
};

function providerFixture(
  fetcher: PaperlessFetch,
  options: { chatId?: string; attachment?: TelegramUploadAttachment } = {},
) {
  const database = new AppDatabase(":memory:");
  database.migrate();
  const receipts = new PaperlessUploadReceiptRepository(database);
  const contexts = new TurnContextRegistry();
  const chatId = options.chatId ?? "chat-1";
  contexts.set("session", {
    chatId,
    chatType: chatId === "chat-1" ? "private" : "group",
    messageId: "telegram-message-44",
    updateId: "telegram-update-77",
    senderId: "sender-1",
    ...(options.attachment === undefined
      ? { uploadAttachment: attachment }
      : { uploadAttachment: options.attachment }),
  });
  const downloadResults: Uint8Array[] = [];
  const getFile = vi.fn(async () => ({
    file_path: "telegram/private/file",
    file_size: pdfBytes.byteLength,
  }));
  const downloadFile = vi.fn(async () => {
    const bytes = new Uint8Array(pdfBytes);
    downloadResults.push(bytes);
    return bytes;
  });
  const telegramApi = { getFile, downloadFile } as unknown as TelegramApi;
  const loader = new TelegramUploadFileLoader(
    telegramApi,
    config.maxUploadBytes,
    config.downloadTimeoutMs,
  );
  const provider = new PaperlessProvider(
    config,
    "paperless-test-secret",
    new ToolAuditRepository(database),
    new SecretRedactor(),
    contexts,
    new Set(["chat-1"]),
    new Set(["sender-1"]),
    fetcher,
    receipts,
    loader,
  );
  return {
    provider,
    database,
    receipts,
    contexts,
    telegramApi,
    getFile,
    downloadFile,
    downloadResults,
  };
}

function toolFor(fixture: ReturnType<typeof providerFixture>, name: string) {
  const tool = fixture.provider
    .tools({ sessionId: "session" })
    .find((entry) => entry.name === name);
  if (!tool) throw new Error(`Missing ${name} tool`);
  return tool;
}

function validApi(
  fetches: URL[],
  uploads: FormData[],
  uploadResponse: () => Response = () => response({ task_id: taskId }),
): PaperlessFetch {
  return async (input, init) => {
    const url =
      input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
    fetches.push(url);
    if (url.pathname === "/api/documents/" && url.searchParams.get("fields") === "id") {
      return response({ count: 0, results: [] });
    }
    if (url.pathname === "/api/tags/" && init?.method !== "POST") {
      return response({ count: 1, results: [{ id: 5, name: "Utilities" }] });
    }
    if (url.pathname === "/api/tags/6/") return response({ id: 6, name: "Household" });
    if (url.pathname === "/api/correspondents/8/")
      return response({ id: 8, name: "Power Company" });
    if (url.pathname === "/api/document_types/") {
      return response({ count: 1, results: [{ id: 12, name: "Invoice" }] });
    }
    if (url.pathname === "/api/documents/post_document/") {
      if (!(init?.body instanceof FormData)) throw new Error("Expected multipart form data");
      uploads.push(init.body);
      return uploadResponse();
    }
    throw new Error(`Unexpected Paperless endpoint ${url.pathname}`);
  };
}

async function execute(
  tool: ReturnType<typeof toolFor>,
  callId: string,
  args: unknown,
  signal?: AbortSignal,
) {
  return tool.execute(callId, args, signal, undefined, {} as never);
}

function toolText(result: unknown): string {
  if (!result || typeof result !== "object" || !("content" in result)) {
    throw new Error("Native tool returned no content");
  }
  const content = result.content;
  if (!Array.isArray(content) || !content[0] || typeof content[0] !== "object") {
    throw new Error("Native tool returned malformed content");
  }
  const text = (content[0] as { text?: unknown }).text;
  if (typeof text !== "string") throw new Error("Native tool returned no text");
  return text;
}

function receiptBody(result: unknown): Record<string, unknown> {
  return JSON.parse(toolText(result)) as Record<string, unknown>;
}

function acceptedReceipt(fixture: ReturnType<typeof providerFixture>, chatId = "chat-1") {
  const receipt = fixture.receipts.claim({
    updateId: "prior-upload-update",
    attachmentKey: "e".repeat(64),
    chatId,
    messageId: "prior-upload-message",
    senderId: "sender-1",
  }).receipt;
  fixture.receipts.markAccepted(receipt.id, taskId);
  return receipt;
}

describe("Paperless trusted attachment upload", () => {
  it("submits only the current PDF with resolved repeated metadata and a durable accepted receipt", async () => {
    const urls: URL[] = [];
    const forms: FormData[] = [];
    const fixture = providerFixture(
      validApi(urls, forms, () =>
        response({ task_id: taskId, detail: "paperless-test-secret private upstream text" }),
      ),
    );
    const tool = toolFor(fixture, "paperless_upload_document");
    const result = await execute(tool, "tool-call-1", {
      title: "May electricity bill",
      created: "2025-05-01",
      tags: ["Utilities", 6],
      correspondent: 8,
      documentType: "Invoice",
    });

    expect(receiptBody(result)).toMatchObject({ state: "accepted", taskId });
    expect(toolText(result)).toContain("does not mean document processing is complete");
    expect(toolText(result)).not.toContain("private upstream text");
    expect(toolText(result)).not.toContain("paperless-test-secret");
    expect(urls.some((url) => url.pathname === "/api/documents/post_document/")).toBe(true);
    expect(forms).toHaveLength(1);
    const form = forms[0]!;
    expect(form.getAll("tags")).toEqual(["5", "6"]);
    expect(form.get("created")).toBe("2025-05-01");
    expect(form.get("correspondent")).toBe("8");
    expect(form.get("document_type")).toBe("12");
    expect(form.get("title")).toBe("May electricity bill");
    const part = form.get("document");
    expect(part).toBeInstanceOf(Blob);
    const documentFile = part as File;
    expect(documentFile.type).toBe("application/pdf");
    expect(documentFile.name).toBe("_.._electricity.pdf");
    expect(new TextDecoder().decode(await documentFile.arrayBuffer())).toBe(
      "%PDF-1.7\nprivate household file",
    );
    expect(fixture.downloadResults[0]?.every((byte) => byte === 0)).toBe(true);

    const audit = fixture.database.connection
      .prepare(
        "SELECT update_id,tool_call_id,status,arguments_json,result_json FROM tool_executions WHERE tool_name='paperless_upload_document'",
      )
      .get() as {
      update_id: string;
      tool_call_id: string;
      status: string;
      arguments_json: string;
      result_json: string;
    };
    expect(audit).toMatchObject({
      update_id: "telegram-update-77",
      tool_call_id: "tool-call-1",
      status: "success",
    });
    expect(audit.arguments_json).not.toContain("file_id");
    expect(audit.result_json).not.toContain("private household file");
    expect(audit.result_json).not.toContain("paperless-test-secret");
    fixture.database.close();
  });

  it("deduplicates repeated and concurrent calls independently of upload metadata", async () => {
    const urls: URL[] = [];
    const forms: FormData[] = [];
    const fixture = providerFixture(validApi(urls, forms));
    const tool = toolFor(fixture, "paperless_upload_document");
    const [first, second] = await Promise.all([
      execute(tool, "call-a", { title: "First title" }),
      execute(tool, "call-b", { title: "Different metadata" }),
    ]);
    const firstReceipt = receiptBody(first);
    const secondReceipt = receiptBody(second);
    expect([firstReceipt.state, secondReceipt.state]).toContain("accepted");
    expect(["accepted", "submitting"]).toContain(secondReceipt.state);
    expect(firstReceipt.receiptId).toBe(secondReceipt.receiptId);
    const repeated = receiptBody(await execute(tool, "call-c", { title: "A third title" }));
    expect(repeated).toMatchObject({ state: "accepted", receiptId: firstReceipt.receiptId });
    expect(forms).toHaveLength(1);
    expect(
      fixture.database.connection
        .prepare("SELECT COUNT(*) AS count FROM paperless_upload_receipts")
        .get(),
    ).toMatchObject({ count: 1 });
    fixture.database.close();
  });

  it("rejects arbitrary sources, absent trusted attachments, and unresolved metadata before POST", async () => {
    const urls: URL[] = [];
    const forms: FormData[] = [];
    const fixture = providerFixture(validApi(urls, forms));
    const upload = toolFor(fixture, "paperless_upload_document");
    await expect(
      execute(upload, "call-source", {
        fileId: "other",
        path: "/etc/passwd",
        url: "https://attacker.test",
        destinationChatId: "another-chat",
      }),
    ).rejects.toThrow("Unexpected tool argument");
    expect(fixture.getFile).not.toHaveBeenCalled();

    fixture.contexts.set("session", {
      chatId: "chat-1",
      chatType: "private",
      messageId: "m",
      updateId: "u",
      senderId: "sender-1",
    });
    await expect(execute(upload, "call-empty", {})).rejects.toThrow("No supported attachment");
    expect(fixture.getFile).not.toHaveBeenCalled();

    fixture.contexts.set("session", {
      chatId: "chat-1",
      chatType: "private",
      messageId: "m",
      updateId: "u",
      senderId: "sender-1",
      uploadAttachment: attachment,
    });
    await expect(execute(upload, "call-invalid-reference", { tags: ["missing"] })).rejects.toThrow(
      "not found",
    );
    expect(fixture.getFile).not.toHaveBeenCalled();
    expect(forms).toHaveLength(0);
    expect(urls.some((url) => url.pathname === "/api/documents/post_document/")).toBe(false);
    expect(
      fixture.database.connection
        .prepare("SELECT COUNT(*) AS count FROM paperless_upload_receipts")
        .get(),
    ).toMatchObject({ count: 0 });
    fixture.database.close();
  });

  it.each([
    ["pending", "pending"],
    ["started", "started"],
    ["failure", "failed"],
    ["revoked", "revoked"],
  ] as const)("maps Paperless task state %s to receipt state %s", async (taskStatus, state) => {
    const fetches: URL[] = [];
    const fixture = providerFixture(async (input) => {
      const url =
        input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
      fetches.push(url);
      if (url.pathname === "/api/tasks/") {
        return response({
          count: 1,
          results: [{ task_id: taskId, status: taskStatus, related_document_ids: [] }],
        });
      }
      throw new Error(`Unexpected endpoint ${url.pathname}`);
    });
    const receipt = acceptedReceipt(fixture);
    const statusTool = toolFor(fixture, "paperless_get_upload_status");
    const result = receiptBody(await execute(statusTool, "status-call", { receiptId: receipt.id }));
    expect(result.state).toBe(state);
    expect(fetches.map((url) => url.pathname)).toEqual(["/api/tasks/"]);
    expect(fixture.receipts.findForChat(receipt.id, "chat-1")?.state).toBe(state);
    fixture.database.close();
  });

  it("keeps accepted receipts when tasks are empty, not yet visible, duplicated, or temporarily unavailable", async () => {
    const empty = providerFixture(async () => response({ count: 0, results: [] }));
    const emptyReceipt = acceptedReceipt(empty);
    const emptyResult = receiptBody(
      await execute(toolFor(empty, "paperless_get_upload_status"), "empty-status", {
        receiptId: emptyReceipt.id,
      }),
    );
    expect(emptyResult.state).toBe("accepted");
    empty.database.close();

    const duplicate = providerFixture(async () =>
      response({
        count: 2,
        results: [
          { task_id: taskId, status: "pending", related_document_ids: [] },
          { task_id: taskId, status: "pending", related_document_ids: [] },
        ],
      }),
    );
    const duplicateReceipt = acceptedReceipt(duplicate);
    expect(
      receiptBody(
        await execute(toolFor(duplicate, "paperless_get_upload_status"), "duplicate-status", {
          receiptId: duplicateReceipt.id,
        }),
      ).state,
    ).toBe("pending");
    duplicate.database.close();

    const unavailable = providerFixture(async () => {
      throw new Error("paperless-test-secret upstream failure");
    });
    const unavailableReceipt = acceptedReceipt(unavailable);
    const unavailableResult = await execute(
      toolFor(unavailable, "paperless_get_upload_status"),
      "timeout-status",
      { receiptId: unavailableReceipt.id },
    );
    expect(receiptBody(unavailableResult)).toMatchObject({
      state: "accepted",
      statusCheck: "unavailable",
    });
    expect(toolText(unavailableResult)).not.toContain("paperless-test-secret");
    expect(unavailable.receipts.findForChat(unavailableReceipt.id, "chat-1")?.state).toBe(
      "accepted",
    );
    unavailable.database.close();
  });

  it("verifies successful task document identities without returning OCR and handles inaccessible documents", async () => {
    for (const documentStatus of [200, 404] as const) {
      const fixture = providerFixture(async (input) => {
        const url =
          input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
        if (url.pathname === "/api/tasks/") {
          return response({
            count: 1,
            results: [{ task_id: taskId, status: "success", related_document_ids: [22] }],
          });
        }
        if (url.pathname === "/api/documents/22/") {
          return documentStatus === 404
            ? response({ detail: "not found" }, 404)
            : response({ id: 22, title: "Processed bill", content: "secret OCR text" });
        }
        throw new Error(`Unexpected endpoint ${url.pathname}`);
      });
      const receipt = acceptedReceipt(fixture);
      const result = await execute(
        toolFor(fixture, "paperless_get_upload_status"),
        "verify-status",
        { receiptId: receipt.id },
      );
      if (documentStatus === 200) {
        expect(receiptBody(result)).toMatchObject({ state: "consumed", documentIds: [22] });
        expect(toolText(result)).toContain("Processed bill");
        expect(toolText(result)).not.toContain("secret OCR text");
      } else {
        expect(receiptBody(result)).toMatchObject({ state: "indeterminate", documentIds: [22] });
      }
      fixture.database.close();
    }
  });

  it("fails closed on unknown and conflicting task contracts without inventing consumption", async () => {
    const taskBodies = [
      {
        count: 1,
        results: [{ task_id: taskId, status: "future-status", related_document_ids: [] }],
      },
      {
        count: 2,
        results: [
          { task_id: taskId, status: "pending", related_document_ids: [] },
          { task_id: taskId, status: "failure", related_document_ids: [] },
        ],
      },
    ];
    for (const taskBody of taskBodies) {
      const fixture = providerFixture(async () => response(taskBody));
      const receipt = acceptedReceipt(fixture);
      const result = await execute(
        toolFor(fixture, "paperless_get_upload_status"),
        "unknown-task-contract",
        { receiptId: receipt.id },
      );
      expect(receiptBody(result)).toMatchObject({ state: "accepted", statusCheck: "unavailable" });
      expect(fixture.receipts.findForChat(receipt.id, "chat-1")?.state).toBe("accepted");
      fixture.database.close();
    }
  });

  it("distinguishes definite rejection from lost or invalid upload responses and never retries", async () => {
    for (const scenario of [
      "rejected",
      "lost",
      "invalid-json",
      "invalid-task",
      "server-error",
    ] as const) {
      let postCount = 0;
      const urls: URL[] = [];
      const forms: FormData[] = [];
      const base = validApi(urls, forms);
      const fetcher: PaperlessFetch = async (input, init) => {
        const url =
          input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
        if (url.pathname === "/api/documents/post_document/") {
          postCount += 1;
          if (scenario === "lost") throw new Error("paperless-test-secret transport detail");
          if (scenario === "rejected") return response({ detail: "private server body" }, 422);
          if (scenario === "server-error") return response({ detail: "private server body" }, 503);
          if (scenario === "invalid-task") return response({ task_id: "not-a-uuid" });
          return new Response("not-json", {
            status: 200,
            headers: { "X-Api-Version": "10", "X-Version": "3.2.1" },
          });
        }
        return base(input, init);
      };
      const fixture = providerFixture(fetcher);
      const upload = toolFor(fixture, "paperless_upload_document");
      const first = await execute(upload, `call-${scenario}`, {});
      const expectedState = scenario === "rejected" ? "submission_failed" : "indeterminate";
      expect(receiptBody(first)).toMatchObject({ state: expectedState });
      expect(toolText(first)).not.toContain("paperless-test-secret");
      const retry = await execute(upload, `different-call-${scenario}`, { title: "new metadata" });
      expect(receiptBody(retry)).toMatchObject({ state: expectedState });
      expect(postCount).toBe(1);
      expect(fixture.getFile).toHaveBeenCalledTimes(1);
      fixture.database.close();
    }
  });

  it("records post-dispatch cancellation and task-receipt persistence failure as indeterminate", async () => {
    const cancellation = new AbortController();
    const urls: URL[] = [];
    const forms: FormData[] = [];
    const base = validApi(urls, forms);
    const cancellationFetcher: PaperlessFetch = async (input, init) => {
      const url =
        input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
      if (url.pathname === "/api/documents/post_document/") {
        cancellation.abort();
        throw new Error("aborted after possible dispatch");
      }
      return base(input, init);
    };
    const cancelled = providerFixture(cancellationFetcher);
    const cancelledResult = await execute(
      toolFor(cancelled, "paperless_upload_document"),
      "cancel-after-post",
      {},
      cancellation.signal,
    );
    expect(receiptBody(cancelledResult)).toMatchObject({ state: "indeterminate" });
    expect(
      cancelled.database.connection.prepare("SELECT state FROM paperless_upload_receipts").get(),
    ).toEqual({ state: "indeterminate" });
    cancelled.database.close();

    const persistenceUrls: URL[] = [];
    const persistenceForms: FormData[] = [];
    const persistence = providerFixture(validApi(persistenceUrls, persistenceForms));
    vi.spyOn(persistence.receipts, "markAccepted").mockImplementationOnce(() => {
      throw new Error("sqlite write failed");
    });
    const persistenceResult = await execute(
      toolFor(persistence, "paperless_upload_document"),
      "receipt-write-failure",
      {},
    );
    expect(receiptBody(persistenceResult)).toMatchObject({
      state: "indeterminate",
      taskId,
      detailCode: "submission_outcome_unknown",
    });
    expect(
      persistence.receipts.findForChat(
        receiptBody(persistenceResult).receiptId as string,
        "chat-1",
      ),
    ).toMatchObject({
      state: "indeterminate",
      taskId,
    });
    expect(persistenceForms).toHaveLength(1);
    persistence.database.close();
  });

  it("constructs bounded local pages for task lookup instead of following remote pagination URLs", async () => {
    const requests: URL[] = [];
    const fixture = providerFixture(async (input) => {
      const url =
        input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
      requests.push(url);
      if (url.pathname === "/api/tasks/" && url.searchParams.get("page") === "1") {
        return response({
          count: 11,
          next: "https://attacker.test/api/tasks/?page=2",
          results: Array.from({ length: 10 }, (_, index) => ({
            task_id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
            status: "pending",
            related_document_ids: [],
          })),
        });
      }
      if (url.pathname === "/api/tasks/" && url.searchParams.get("page") === "2") {
        return response({
          count: 11,
          next: null,
          results: [{ task_id: taskId, status: "success", related_document_ids: [22] }],
        });
      }
      if (url.pathname === "/api/documents/22/") {
        return response({ id: 22, title: "Paged document" });
      }
      throw new Error(`Unexpected endpoint ${url.pathname}`);
    });
    const receipt = acceptedReceipt(fixture);
    const result = receiptBody(
      await execute(toolFor(fixture, "paperless_get_upload_status"), "paged-status", {
        receiptId: receipt.id,
      }),
    );
    expect(result.state).toBe("consumed");
    expect(requests.map((url) => url.searchParams.get("page"))).toEqual(["1", "2", null]);
    expect(requests.some((url) => url.hostname === "attacker.test")).toBe(false);
    fixture.database.close();
  });

  it("denies status receipts from another chat before any Paperless request", async () => {
    const requests: URL[] = [];
    const fixture = providerFixture(async (input) => {
      const url =
        input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
      requests.push(url);
      return response({ count: 0, results: [] });
    });
    const receipt = acceptedReceipt(fixture, "chat-2");
    const statusTool = toolFor(fixture, "paperless_get_upload_status");
    await expect(execute(statusTool, "cross-chat", { receiptId: receipt.id })).rejects.toThrow(
      "not found in this chat",
    );
    expect(requests).toHaveLength(0);
    fixture.database.close();
  });
});
