import { describe, expect, it } from "vitest";

import type { NativeToolError } from "../src/capabilities/execution.js";
import {
  PaperlessClient,
  type PaperlessConfig,
  type PaperlessFetch,
} from "../src/integrations/paperless/client.js";
import { PaperlessDocumentService } from "../src/integrations/paperless/documents.js";
import { PaperlessOrganizerService } from "../src/integrations/paperless/organizers.js";

const config: PaperlessConfig = {
  baseUrl: "https://paperless.test",
  apiTokenFile: "/token",
  requestTimeoutMs: 1000,
  uploadTimeoutMs: 1000,
  downloadTimeoutMs: 1000,
  maxResponseBytes: 10000,
  maxResultBytes: 10000,
  maxUploadBytes: 10000,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function service(fetcher: PaperlessFetch) {
  const client = new PaperlessClient(config, "secret", fetcher);
  return new PaperlessDocumentService(client, new PaperlessOrganizerService(client));
}

function urlOf(input: RequestInfo | URL): URL {
  return input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
}

describe("Paperless document updates", () => {
  it("patches only supplied fields and verifies explicit clearing semantics", async () => {
    const patches: Record<string, unknown>[] = [];
    let state: Record<string, unknown> = {
      id: 7,
      title: "Original",
      created: "2024-02-01",
      correspondent: 3,
      document_type: 4,
      tags: [{ id: 2, name: "Old" }],
      content: "OCR must remain untouched",
    };
    const documents = service(async (input, init) => {
      const url = urlOf(input);
      if (url.pathname === "/api/documents/7/" && init?.method === "PATCH") {
        const patch = JSON.parse(init.body as string) as Record<string, unknown>;
        patches.push(patch);
        state = {
          ...state,
          ...patch,
          tags:
            patch.tags === undefined ? state.tags : (patch.tags as number[]).map((id) => ({ id })),
        };
        return json({});
      }
      if (url.pathname === "/api/documents/7/") return json(state);
      throw new Error(`Unexpected endpoint ${url.pathname}`);
    });
    const result = await documents.update({
      id: 7,
      title: " New title ",
      created: "2025-03-04",
      tags: [],
      correspondent: null,
    });
    expect(patches).toEqual([
      { title: "New title", created: "2025-03-04", tags: [], correspondent: null },
    ]);
    expect(result).toMatchObject({
      title: "New title",
      created: "2025-03-04",
      tags: [],
      correspondent: null,
      documentType: 4,
    });
    expect(JSON.stringify(patches)).not.toContain("content");
  });

  it("resolves every organizer before patching and rejects ambiguous references", async () => {
    let patches = 0;
    const documents = service(async (input, init) => {
      const url = urlOf(input);
      if (url.pathname === "/api/tags/" && url.searchParams.get("name__icontains") === "Same") {
        return json({
          count: 2,
          results: [
            { id: 1, name: "Same" },
            { id: 2, name: "Same" },
          ],
        });
      }
      if (url.pathname === "/api/correspondents/3/") return json({ id: 3, name: "Known" });
      if (url.pathname === "/api/documents/9/" && init?.method === "PATCH") patches += 1;
      return json({ id: 9, title: "Document", tags: [], correspondent: 3 });
    });
    await expect(documents.update({ id: 9, title: "Change", tags: ["Same"] })).rejects.toThrow(
      "ambiguous",
    );
    expect(patches).toBe(0);
  });

  it("reports unverifiable post-PATCH outcomes as partial with a known document identity", async () => {
    const documents = service(async (input, init) => {
      const url = urlOf(input);
      if (url.pathname === "/api/documents/5/" && init?.method === "PATCH") return json({});
      if (url.pathname === "/api/documents/5/") return new Response("denied", { status: 403 });
      throw new Error("Unexpected request");
    });
    await expect(documents.update({ id: 5, title: "New" })).rejects.toMatchObject({
      name: "NativeToolError",
      outcome: "partial",
      result: { status: "partial", documentId: 5, stage: "verification" },
    });
  });

  it("reports uncertain transport failures and rejects invalid updates before dispatch", async () => {
    let calls = 0;
    const failing = service(async () => {
      calls += 1;
      throw new Error("connection reset after write");
    });
    await expect(failing.update({ id: 1, title: "New" })).rejects.toMatchObject({
      name: "NativeToolError",
      outcome: "indeterminate",
    } satisfies Partial<NativeToolError>);

    const invalid = service(async () => {
      calls += 1;
      return json({ count: 0, results: [] });
    });
    const before = calls;
    await expect(invalid.update({ id: 1, created: "2025-02-30" })).rejects.toThrow(
      "real calendar date",
    );
    await expect(invalid.update({ id: 1 })).rejects.toThrow("At least one document field");
    expect(calls).toBe(before);
  });
});
