import { describe, expect, it } from "vitest";

import type { NativeToolError } from "../src/capabilities/execution.js";
import { PaperlessClient, type PaperlessConfig } from "../src/integrations/paperless/client.js";
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

function json(body: unknown): Response {
  return new Response(JSON.stringify(body));
}

function urlOf(input: RequestInfo | URL): URL {
  return input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
}

describe("Paperless organizer mutations", () => {
  it("rechecks exact names and creates only missing records with safe fields, including numeric names", async () => {
    let creates = 0;
    let detailReads = 0;
    let submitted: Record<string, unknown> | undefined;
    const service = new PaperlessOrganizerService(
      new PaperlessClient(config, "secret", async (input, init) => {
        const url = urlOf(input);
        if (url.pathname === "/api/tags/" && url.searchParams.get("name__icontains") === "123") {
          return json({
            count: creates > 0 ? 1 : 0,
            results: creates > 0 ? [{ id: 9, name: "123" }] : [],
          });
        }
        if (url.pathname === "/api/tags/" && init?.method === "POST") {
          creates += 1;
          submitted = JSON.parse(init.body as string) as Record<string, unknown>;
          return json({ id: 9, name: "123" });
        }
        if (url.pathname === "/api/tags/9/") {
          detailReads += 1;
          return json({ id: 9, name: "123" });
        }
        throw new Error(`Unexpected request: ${init?.method} ${url.pathname}`);
      }),
    );
    expect(await service.create("tag", " 123 ")).toEqual({ id: 9, name: "123" });
    expect(await service.create("tag", "123")).toEqual({ id: 9, name: "123" });
    expect(creates).toBe(1);
    expect(detailReads).toBe(1);
    expect(submitted).toEqual({ name: "123" });
  });

  it("renames only the name and verifies current identity", async () => {
    let name = "Old";
    let patch: Record<string, unknown> | undefined;
    const service = new PaperlessOrganizerService(
      new PaperlessClient(config, "secret", async (input, init) => {
        const url = urlOf(input);
        if (url.pathname === "/api/tags/4/" && init?.method === "PATCH") {
          patch = JSON.parse(init.body as string) as Record<string, unknown>;
          name = String(patch.name);
          return json({ id: 4, name });
        }
        if (url.pathname === "/api/tags/4/") return json({ id: 4, name });
        throw new Error(`Unexpected request: ${init?.method} ${url.pathname}`);
      }),
    );
    expect(await service.rename("tag", 4, "Renamed")).toEqual({ id: 4, name: "Renamed" });
    expect(patch).toEqual({ name: "Renamed" });
  });

  it("reports partial outcomes when created or renamed organizers cannot be verified", async () => {
    let post = false;
    const create = new PaperlessOrganizerService(
      new PaperlessClient(config, "secret", async (input, init) => {
        const url = urlOf(input);
        if (url.pathname === "/api/tags/" && init?.method === "POST") {
          post = true;
          return json({ id: 10, name: "New" });
        }
        if (url.pathname === "/api/tags/" && url.searchParams.has("name__icontains")) {
          return json({ count: 0, results: [] });
        }
        if (url.pathname === "/api/tags/10/") return new Response("hidden", { status: 403 });
        throw new Error(`Unexpected request: ${url.pathname}`);
      }),
    );
    await expect(create.create("tag", "New")).rejects.toMatchObject({
      name: "NativeToolError",
      outcome: "partial",
      result: { status: "partial", id: 10, stage: "creation_verification" },
    } satisfies Partial<NativeToolError>);
    expect(post).toBe(true);

    const rename = new PaperlessOrganizerService(
      new PaperlessClient(config, "secret", async (input, init) => {
        const url = urlOf(input);
        if (url.pathname === "/api/tags/10/" && init?.method === "PATCH")
          return json({ id: 10, name: "Renamed" });
        if (url.pathname === "/api/tags/10/") return json({ id: 10, name: "Old" });
        throw new Error(`Unexpected request: ${url.pathname}`);
      }),
    );
    await expect(rename.rename("tag", 10, "Renamed")).rejects.toMatchObject({
      name: "NativeToolError",
      outcome: "partial",
      result: { id: 10, stage: "rename_verification" },
    });
  });
});
