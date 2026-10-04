import { describe, expect, it } from "vitest";

import { AgentToolCatalog } from "../src/capabilities/catalog.js";
import { AppDatabase } from "../src/persistence/database.js";
import { ToolAuditRepository } from "../src/persistence/repositories.js";
import { PaperlessProvider } from "../src/integrations/paperless/provider.js";
import type { PaperlessConfig, PaperlessFetch } from "../src/integrations/paperless/client.js";
import { SecretRedactor } from "../src/security/secrets.js";
import { TurnContextRegistry } from "../src/agent/turn-context.js";

const config: PaperlessConfig = {
  baseUrl: "https://paperless.test",
  publicUrl: "https://docs.test/archive",
  apiTokenFile: "/token",
  requestTimeoutMs: 1000,
  uploadTimeoutMs: 1000,
  downloadTimeoutMs: 1000,
  maxResponseBytes: 10000,
  maxResultBytes: 10000,
  maxUploadBytes: 10000,
};

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "X-Api-Version": "10", "X-Version": "3.2.1" },
  });
}

describe("Paperless native agent tools", () => {
  it("exposes only bounded safe operations in session-bound catalogs", async () => {
    const database = new AppDatabase(":memory:");
    database.migrate();
    const provider = new PaperlessProvider(
      config,
      "private-token",
      new ToolAuditRepository(database),
      new SecretRedactor(),
      new TurnContextRegistry(),
      new Set(["chat-1"]),
      new Set(["sender-1"]),
      async () => response({ count: 0, results: [] }),
    );
    const catalog = new AgentToolCatalog([provider]);
    expect(catalog.tools()).toEqual([]);
    const names = catalog
      .tools({ sessionId: "session" })
      .map((tool) => tool.name)
      .sort();
    expect(names).toEqual([
      "paperless_create_organizer",
      "paperless_get_document",
      "paperless_list_organizers",
      "paperless_rename_organizer",
      "paperless_search_documents",
      "paperless_update_document",
    ]);
    expect(names.join(" ")).not.toMatch(/delete|share|bulk|http|upload/);
    await catalog.start(new AbortController().signal);
    database.close();
  });

  it("rejects missing trusted context before any Paperless HTTP request", async () => {
    let requests = 0;
    const database = new AppDatabase(":memory:");
    database.migrate();
    const provider = new PaperlessProvider(
      config,
      "private-token",
      new ToolAuditRepository(database),
      new SecretRedactor(),
      new TurnContextRegistry(),
      new Set(["chat-1"]),
      new Set(["sender-1"]),
      async () => {
        requests += 1;
        return response({ count: 0, results: [] });
      },
    );
    await provider.start(new AbortController().signal);
    const before = requests;
    const tool = provider
      .tools({ sessionId: "session" })
      .find((entry) => entry.name === "paperless_search_documents");
    if (!tool) throw new Error("missing search tool");
    await expect(
      tool.execute("call", { searchText: "invoice" }, undefined, undefined, {} as never),
    ).rejects.toThrow("Trusted turn context is unavailable");
    expect(requests).toBe(before);
    database.close();
  });

  it("authorizes before probing, returns bounded summaries, and audits the accepted Telegram update", async () => {
    const calls: URL[] = [];
    const fetcher: PaperlessFetch = async (input) => {
      const url =
        input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
      calls.push(url);
      if (url.pathname === "/api/documents/" && url.searchParams.get("fields") === "id") {
        return response({ count: 0, results: [] });
      }
      if (url.pathname === "/api/documents/") {
        return response({
          count: 1,
          results: [
            {
              id: 22,
              title: "Utility invoice private-token",
              created: "2025-02-02",
              tags: [{ id: 5, name: "Utilities" }],
              content: "private full OCR must not be returned in search",
              __search_hit__: { highlights: '<span class="match">Utility</span> &amp; invoice' },
            },
          ],
        });
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    };
    const database = new AppDatabase(":memory:");
    database.migrate();
    const contexts = new TurnContextRegistry();
    const provider = new PaperlessProvider(
      config,
      "private-token",
      new ToolAuditRepository(database),
      new SecretRedactor(),
      contexts,
      new Set(["chat-1"]),
      new Set(["sender-1"]),
      fetcher,
    );
    await provider.start(new AbortController().signal);
    contexts.set("session", {
      chatId: "chat-1",
      senderId: "sender-1",
      updateId: "update-77",
      messageId: "message-3",
    });
    const tool = provider
      .tools({ sessionId: "session" })
      .find((entry) => entry.name === "paperless_search_documents");
    if (!tool) throw new Error("missing search tool");
    const result = await tool.execute(
      "call-7",
      { searchMode: "text", searchText: "utility" },
      undefined,
      undefined,
      {} as never,
    );
    expect(JSON.stringify(result)).toContain("Utility invoice");
    expect(JSON.stringify(result)).toContain("https://docs.test/archive/documents/22");
    expect(JSON.stringify(result)).toContain("Utility & invoice");
    expect(JSON.stringify(result)).not.toContain("private full OCR");
    expect(JSON.stringify(result)).not.toContain("private-token");
    expect(calls).toHaveLength(3);
    const audit = database.connection
      .prepare("SELECT update_id,tool_call_id,status,result_json FROM tool_executions")
      .get() as { update_id: string; tool_call_id: string; status: string; result_json: string };
    expect(audit).toMatchObject({
      update_id: "update-77",
      tool_call_id: "call-7",
      status: "success",
    });
    expect(audit.result_json).not.toContain("private-token");
    database.close();
  });

  it("rejects arbitrary source arguments before any Paperless or Telegram I/O", async () => {
    let requests = 0;
    const database = new AppDatabase(":memory:");
    database.migrate();
    const contexts = new TurnContextRegistry();
    contexts.set("session", {
      chatId: "chat-1",
      senderId: "sender-1",
      updateId: "u",
      messageId: "m",
    });
    const provider = new PaperlessProvider(
      config,
      "private-token",
      new ToolAuditRepository(database),
      new SecretRedactor(),
      contexts,
      new Set(["chat-1"]),
      new Set(["sender-1"]),
      async () => {
        requests += 1;
        return response({ count: 0, results: [] });
      },
    );
    const tool = provider
      .tools({ sessionId: "session" })
      .find((entry) => entry.name === "paperless_search_documents");
    if (!tool) throw new Error("missing search tool");
    await expect(
      tool.execute(
        "call",
        { searchText: "invoice", url: "https://attacker.test/file", fileId: "other" },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow("Unexpected tool argument");
    expect(requests).toBe(0);
    database.close();
  });
});
