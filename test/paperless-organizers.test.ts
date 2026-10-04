import { describe, expect, it } from "vitest";

import {
  PaperlessClient,
  PaperlessHttpError,
  type PaperlessConfig,
  type PaperlessFetch,
} from "../src/integrations/paperless/client.js";
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
  return new PaperlessOrganizerService(new PaperlessClient(config, "secret", fetcher));
}

describe("Paperless organizer services", () => {
  it("lists bounded organizer pages and sends query filters to the fixed collection endpoint", async () => {
    let url: URL | undefined;
    const organizers = service(async (input) => {
      url = input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
      return json({ count: 101, results: [{ id: 3, name: "Utilities" }] });
    });
    const result = await organizers.list("tag", { query: "util", page: 2, perPage: 1000 });
    expect(url?.pathname).toBe("/api/tags/");
    expect(url?.searchParams.get("name__icontains")).toBe("util");
    expect(url?.searchParams.get("page_size")).toBe("100");
    expect(result).toMatchObject({
      total: 101,
      totalPages: 2,
      hasNextPage: false,
      items: [{ id: 3, name: "Utilities" }],
    });
  });

  it("resolves exact names across bounded pages and numeric IDs through a fixed detail endpoint", async () => {
    const urls: URL[] = [];
    const organizers = service(async (input) => {
      const url =
        input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
      urls.push(url);
      if (url.pathname === "/api/tags/" && url.searchParams.get("page") === "1") {
        return json({ count: 101, results: [{ id: 1, name: "Electricity Extra" }] });
      }
      if (url.pathname === "/api/tags/" && url.searchParams.get("page") === "2") {
        return json({ count: 101, results: [{ id: 7, name: "Electricity" }] });
      }
      if (url.pathname === "/api/correspondents/7/") return json({ id: 7, name: "Power Company" });
      throw new Error(`Unexpected request: ${url.pathname}`);
    });
    expect(await organizers.resolve("tag", "electricity")).toEqual({ id: 7, name: "Electricity" });
    expect(await organizers.resolve("correspondent", 7)).toEqual({ id: 7, name: "Power Company" });
    expect(urls).toHaveLength(3);
  });

  it("rejects missing, ambiguous, and beyond-bound name resolution instead of broadening filters", async () => {
    const missing = service(async () => json({ count: 0, results: [] }));
    await expect(missing.resolve("tag", "Missing")).rejects.toThrow("not found");

    const ambiguous = service(async () =>
      json({
        count: 2,
        results: [
          { id: 1, name: "Same" },
          { id: 2, name: "Same" },
        ],
      }),
    );
    await expect(ambiguous.resolve("tag", "Same")).rejects.toThrow("ambiguous");

    const bounded = service(async (input) => {
      const url =
        input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
      return json({ count: 1001, results: url.searchParams.get("page") === "1" ? [] : [] });
    });
    await expect(bounded.resolve("tag", "No match")).rejects.toThrow("bounded page limit");
  });

  it("rejects invalid IDs and reports not-found detail responses", async () => {
    const organizers = service(async () => new Response("", { status: 404 }));
    await expect(organizers.resolve("tag", 0)).rejects.toThrow("Invalid tag id");
    await expect(organizers.resolve("tag", 999)).rejects.toThrow("not found");
    const failure = service(async () => new Response("private", { status: 403 }));
    await expect(failure.resolve("tag", 3)).rejects.toBeInstanceOf(PaperlessHttpError);
  });
});
