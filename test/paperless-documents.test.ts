import { describe, expect, it } from "vitest";

import {
  PaperlessClient,
  type PaperlessConfig,
  type PaperlessFetch,
} from "../src/integrations/paperless/client.js";
import { PaperlessDocumentService } from "../src/integrations/paperless/documents.js";
import { PaperlessOrganizerService } from "../src/integrations/paperless/organizers.js";

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

function json(body: unknown): Response {
  return new Response(JSON.stringify(body));
}

function service(fetcher: PaperlessFetch, publicUrl?: string) {
  const client = new PaperlessClient(config, "secret", fetcher);
  return new PaperlessDocumentService(client, new PaperlessOrganizerService(client), publicUrl);
}

function asUrl(input: RequestInfo | URL): URL {
  return input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
}

describe("Paperless document search", () => {
  it("combines official search, date, all-tag, organizer, and pagination filters with summaries", async () => {
    const urls: URL[] = [];
    const documents = service(async (input) => {
      const url = asUrl(input);
      urls.push(url);
      if (url.pathname === "/api/tags/") {
        return url.searchParams.get("name__icontains") === "Paid"
          ? json({ count: 1, results: [{ id: 3, name: "Paid" }] })
          : json({ count: 1, results: [{ id: 2, name: "Utilities" }] });
      }
      if (url.pathname === "/api/correspondents/4/") return json({ id: 4, name: "Power Co" });
      if (url.pathname === "/api/document_types/5/") return json({ id: 5, name: "Invoice" });
      if (url.pathname === "/api/documents/") {
        return json({
          count: 31,
          results: [
            {
              id: 8,
              title: "Invoice",
              created: "2025-03-04",
              tags: [{ id: 2, name: "Utilities" }],
              correspondent: { id: 4, name: "Power Co" },
              document_type: 5,
              content: "must not be returned in a search summary",
              __search_hit__: { highlights: '<span class="match">power</span> &amp; light' },
            },
          ],
        });
      }
      throw new Error(`Unexpected endpoint ${url.pathname}`);
    }, config.publicUrl);
    const result = await documents.search({
      searchMode: "text",
      searchText: "power",
      dateFrom: "2025-01-01",
      dateTo: "2025-12-31",
      tags: ["Utilities", "Paid"],
      tagMatch: "all",
      correspondent: 4,
      documentType: "5",
      page: 2,
      perPage: 10,
      orderBy: "created",
      orderDirection: "desc",
    });
    const query = urls.find((url) => url.pathname === "/api/documents/")!;
    expect(query.searchParams.get("text")).toBe("power");
    expect(query.searchParams.get("created__gte")).toBe("2025-01-01");
    expect(query.searchParams.get("created__lte")).toBe("2025-12-31");
    expect(query.searchParams.get("tags__id__all")).toBe("2,3");
    expect(query.searchParams.get("correspondent__id")).toBe("4");
    expect(query.searchParams.get("document_type__id")).toBe("5");
    expect(query.searchParams.get("ordering")).toBe("-created");
    expect(query.searchParams.get("page")).toBe("2");
    expect(result).toMatchObject({
      total: 31,
      page: 2,
      hasNextPage: true,
      items: [
        {
          id: 8,
          title: "Invoice",
          created: "2025-03-04",
          correspondent: { id: 4, name: "Power Co" },
          documentType: 5,
          highlight: "power & light",
          browserUrl: "https://docs.test/archive/documents/8",
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("must not be returned");
  });

  it("uses any-tag matching, permits text-free filters, and omits invented public URLs", async () => {
    const urls: URL[] = [];
    const documents = service(async (input) => {
      const url = asUrl(input);
      urls.push(url);
      if (url.pathname === "/api/tags/2/") return json({ id: 2, name: "Paid" });
      return json({ count: 0, results: [] });
    });
    const result = await documents.search({ tags: [2], tagMatch: "any" });
    expect(urls.at(-1)?.searchParams.get("tags__id__in")).toBe("2");
    expect(urls.at(-1)?.searchParams.has("tags__id__all")).toBe(false);
    expect(result.items).toEqual([]);

    const noPublicUrl = service(async () =>
      json({ count: 1, results: [{ id: 12, title: "Tax" }] }),
    );
    const one = await noPublicUrl.search({});
    expect(one.items[0]).not.toHaveProperty("browserUrl");
  });

  it("rejects conflicting, oversized, malformed, or reversed search criteria before document search", async () => {
    let documentQueries = 0;
    const documents = service(async (input) => {
      if (asUrl(input).pathname === "/api/documents/") documentQueries += 1;
      return json({ count: 0, results: [] });
    });
    await expect(documents.search({ searchMode: "query" })).rejects.toThrow("requires search text");
    await expect(documents.search({ searchMode: "text", searchText: "   " })).rejects.toThrow(
      "must not be empty",
    );
    await expect(documents.search({ searchText: "a".repeat(4097) })).rejects.toThrow("query limit");
    await expect(documents.search({ dateFrom: "2025-02-30" })).rejects.toThrow(
      "real calendar date",
    );
    await expect(
      documents.search({ dateFrom: "2025-05-01", dateTo: "2025-04-01" }),
    ).rejects.toThrow("after dateTo");
    expect(documentQueries).toBe(0);
  });
});
