import { describe, expect, it } from "vitest";

import {
  PaperlessClient,
  PaperlessHttpError,
  type PaperlessConfig,
  type PaperlessFetch,
} from "../src/integrations/paperless/client.js";
import { PaperlessDocumentService } from "../src/integrations/paperless/documents.js";
import { PaperlessOrganizerService } from "../src/integrations/paperless/organizers.js";

const config: PaperlessConfig = {
  baseUrl: "https://paperless.test/records",
  publicUrl: "https://docs.test/archive",
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

function service(fetcher: PaperlessFetch, publicUrl?: string) {
  const client = new PaperlessClient(config, "secret", fetcher);
  return new PaperlessDocumentService(client, new PaperlessOrganizerService(client), publicUrl);
}

function asUrl(input: RequestInfo | URL): URL {
  return input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
}

const detail = {
  id: 12,
  title: "Invoice",
  created: "2025-01-05",
  correspondent: { id: 2, name: "Power" },
  document_type: { id: 4, name: "Invoice" },
  tags: [{ id: 3, name: "Utilities" }],
  content: "A🙂β",
  custom_fields: [
    { field: { id: 5, name: "Account" }, value: "123456" },
    { field: { id: 6, name: "Hidden payload" }, value: { unsafe: { tooDeep: { data: "x" } } } },
  ],
};

describe("Paperless document retrieval", () => {
  it("reads latest and selected historical content in UTF-8-safe chunks with metadata", async () => {
    const urls: URL[] = [];
    const documents = service(async (input) => {
      const url = asUrl(input);
      urls.push(url);
      return json({
        ...detail,
        content: url.searchParams.get("version") ? "old version" : detail.content,
      });
    }, config.publicUrl);
    const first = await documents.get(12, { maxBytes: 5 });
    expect(first).toMatchObject({
      id: 12,
      title: "Invoice",
      correspondent: { id: 2, name: "Power" },
      documentType: { id: 4, name: "Invoice" },
      tags: [{ id: 3, name: "Utilities" }],
      customFields: [
        { id: 5, name: "Account", value: "123456" },
        { id: 6, name: "Hidden payload" },
      ],
      ocr: "A🙂",
      hasOcr: true,
      truncated: true,
      nextOffset: 2,
      browserUrl: "https://docs.test/archive/documents/12",
    });
    expect(urls[0]?.pathname).toBe("/records/api/documents/12/");
    expect(urls[0]?.searchParams.has("version")).toBe(false);
    const rest = await documents.get(12, { offset: 2, maxBytes: 5 });
    expect(rest).toMatchObject({ ocr: "β", truncated: false });
    const historical = await documents.get(12, { versionId: 9, maxBytes: 5 });
    expect(historical).toMatchObject({ versionId: 9, ocr: "old v", truncated: true });
    expect(urls[2]?.searchParams.get("version")).toBe("9");
    expect(JSON.stringify(first)).not.toContain("tooDeep");
  });

  it("reports missing OCR distinctly and omits guessed browser links", async () => {
    const documents = service(
      async () => json({ id: 8, title: "Empty", content: null }),
      undefined,
    );
    const result = await documents.get(8);
    expect(result).toMatchObject({ hasOcr: false, ocr: "", truncated: false });
    expect(result).not.toHaveProperty("browserUrl");
    await expect(documents.get(8, { offset: -1 })).rejects.toThrow("text offset");
  });

  it.each([403, 404])("preserves the inaccessible document status %s", async (status) => {
    const documents = service(async () => new Response("private body", { status }));
    await expect(documents.get(42)).rejects.toBeInstanceOf(PaperlessHttpError);
    await expect(documents.get(42)).rejects.toMatchObject({ status });
    await expect(documents.get(42)).rejects.not.toThrow("private body");
  });
});
