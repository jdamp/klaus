import { describe, expect, it } from "vitest";

import { AppDatabase } from "../src/persistence/database.js";
import { ToolAuditRepository } from "../src/persistence/repositories.js";
import { PaperlessProvider } from "../src/integrations/paperless/provider.js";
import type { PaperlessConfig, PaperlessFetch } from "../src/integrations/paperless/client.js";
import { SecretRedactor } from "../src/security/secrets.js";
import { TurnContextRegistry } from "../src/agent/turn-context.js";

const config: PaperlessConfig = {
  baseUrl: "https://paperless.example.invalid",
  apiTokenFile: "/run/secrets/paperless/token",
  requestTimeoutMs: 1000,
  uploadTimeoutMs: 1000,
  downloadTimeoutMs: 1000,
  maxResponseBytes: 10000,
  maxResultBytes: 10000,
  maxUploadBytes: 10000,
};

function response(
  body: unknown,
  status = 200,
  headers: Record<string, string> = { "X-Api-Version": "10", "X-Version": "3.2.1" },
): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

function provider(fetcher: PaperlessFetch) {
  const database = new AppDatabase(":memory:");
  database.migrate();
  const redactor = new SecretRedactor();
  const contexts = new TurnContextRegistry();
  const instance = new PaperlessProvider(
    config,
    "paperless-test-token",
    new ToolAuditRepository(database),
    redactor,
    contexts,
    new Set(["chat-1"]),
    new Set(["sender-1"]),
    fetcher,
  );
  return { instance, database, contexts };
}

describe("Paperless provider health and authorization", () => {
  it("accepts a compatible v10 response and recovers after an outage", async () => {
    let down = false;
    const { instance, database } = provider(async () =>
      down
        ? new Response("sensitive upstream detail", { status: 503 })
        : response({ count: 0, results: [] }),
    );
    await instance.start(new AbortController().signal);
    expect(instance.health().service?.status).toBe("healthy");
    down = true;
    await instance.start(new AbortController().signal);
    expect(instance.health().service?.detail).toBe(
      "Paperless is unavailable or returned an invalid response",
    );
    down = false;
    await instance.start(new AbortController().signal);
    expect(instance.health().service?.status).toBe("healthy");
    expect(JSON.stringify(instance.health())).not.toContain("sensitive upstream detail");
    database.close();
  });

  it.each([401, 403])("reports HTTP %s as an authentication/access issue", async (status) => {
    const { instance, database } = provider(async () => new Response("private body", { status }));
    await instance.start(new AbortController().signal);
    expect(instance.health().service?.detail).toBe(
      "Paperless rejected the configured token or document access",
    );
    expect(JSON.stringify(instance.health())).not.toContain("private body");
    database.close();
  });

  it("reports unsupported API and malformed or unversioned contracts", async () => {
    const unsupported = provider(async () => new Response("private", { status: 406 }));
    await unsupported.instance.start(new AbortController().signal);
    expect(unsupported.instance.health().service?.detail).toContain("does not support API v10");
    unsupported.database.close();

    const missingHeaders = provider(async () => response({ count: 0, results: [] }, 200, {}));
    await missingHeaders.instance.start(new AbortController().signal);
    expect(missingHeaders.instance.health().service?.detail).toContain("could not be verified");
    missingHeaders.database.close();

    const wrongShape = provider(async () => response({ items: [] }));
    await wrongShape.instance.start(new AbortController().signal);
    expect(wrongShape.instance.health().service?.detail).toContain("response is incompatible");
    wrongShape.database.close();
  });

  it("requires the immutable trusted active sender and chat context", () => {
    const { instance, contexts, database } = provider(async () =>
      response({ count: 0, results: [] }),
    );
    expect(() => instance.authorize("session")).toThrow("Trusted turn context is unavailable");
    const token = contexts.set("session", {
      chatId: "other-chat",
      senderId: "sender-1",
      messageId: "1",
      updateId: "1",
    });
    expect(() => instance.authorize("session")).toThrow("authorized active Telegram turn");
    contexts.set("session", {
      chatId: "chat-1",
      senderId: "sender-1",
      messageId: "2",
      updateId: "2",
    });
    expect(instance.authorize("session").chatId).toBe("chat-1");
    contexts.clear("session", token);
    expect(instance.authorize("session").messageId).toBe("2");
    database.close();
  });
});
