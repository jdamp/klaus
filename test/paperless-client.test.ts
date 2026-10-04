import { describe, expect, it } from "vitest";

import {
  PaperlessClient,
  PaperlessHttpError,
  type PaperlessConfig,
  type PaperlessFetch,
} from "../src/integrations/paperless/client.js";

function urlOf(input: RequestInfo | URL): URL {
  if (input instanceof URL) return input;
  return new URL(typeof input === "string" ? input : input.url);
}

const config: PaperlessConfig = {
  baseUrl: "https://paperless.example.invalid/base",
  apiTokenFile: "/run/secrets/paperless/token",
  requestTimeoutMs: 30_000,
  uploadTimeoutMs: 60_000,
  downloadTimeoutMs: 15_000,
  maxResponseBytes: 1024,
  maxResultBytes: 1024,
  maxUploadBytes: 1024,
};

function json(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("Paperless API v10 client", () => {
  it("uses token auth, explicit API v10, configured subpaths, and bounded local query parameters", async () => {
    let receivedUrl: URL | undefined;
    let received: RequestInit | undefined;
    const fetcher: PaperlessFetch = async (input, init) => {
      receivedUrl = urlOf(input);
      received = init;
      return json({ count: 1, results: [{ id: 4 }], next: "https://attacker.example/steal" });
    };
    const client = new PaperlessClient(config, "private-token", fetcher);
    const result = await client.list("documents", { page: 2, page_size: 10, text: "water" });
    expect(receivedUrl?.origin).toBe("https://paperless.example.invalid");
    expect(receivedUrl?.pathname).toBe("/base/api/documents/");
    expect(receivedUrl?.searchParams.get("page")).toBe("2");
    expect(receivedUrl?.searchParams.get("text")).toBe("water");
    expect(received?.headers).toEqual({
      Authorization: "Token private-token",
      Accept: "application/json; version=10",
    });
    expect(received?.redirect).toBe("error");
    expect(result.body).toMatchObject({ count: 1 });
    expect(result.apiVersion).toBeUndefined();
  });

  it("returns compatibility headers and rejects HTTP errors without their private body", async () => {
    const success = new PaperlessClient(config, "secret", async () =>
      json({ count: 0, results: [] }, { "X-Api-Version": "10", "X-Version": "3.2.1" }),
    );
    expect(await success.probe()).toMatchObject({ apiVersion: "10", serverVersion: "3.2.1" });
    const failure = new PaperlessClient(
      config,
      "secret",
      async () => new Response("private upstream detail", { status: 403 }),
    );
    await expect(failure.probe()).rejects.toMatchObject({
      name: "PaperlessHttpError",
      status: 403,
      message: "Paperless HTTP 403",
    });
    await expect(failure.probe()).rejects.not.toThrow("private upstream detail");
  });

  it("does not follow response-provided pagination URLs and constrains task identities", async () => {
    const urls: string[] = [];
    const client = new PaperlessClient(config, "secret", async (input) => {
      urls.push(urlOf(input).href);
      return json({ count: 0, next: "https://attacker.example/" });
    });
    await client.list("documents", { page: 1, page_size: 1 });
    await client.findTask("f4c3b2a1-1234-4abc-9def-0123456789ab", 2);
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain("/base/api/documents/");
    expect(new URL(urls[1]!).searchParams.get("page")).toBe("2");
    expect(urls[1]).toContain("/base/api/tasks/");
    expect(() => client.findTask("https://attacker.example")).toThrow("Invalid Paperless task");
    expect(() => client.findTask("f4c3b2a1-1234-4abc-9def-0123456789ab", 11)).toThrow(
      "Invalid Paperless task page",
    );
  });

  it("cancels an oversized response stream and rejects invalid JSON", async () => {
    let cancelled = false;
    const oversized = new PaperlessClient(
      config,
      "secret",
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(1100));
            },
            cancel() {
              cancelled = true;
            },
          }),
        ),
    );
    await expect(oversized.probe()).rejects.toThrow("exceeded the configured limit");
    expect(cancelled).toBe(true);
    const malformed = new PaperlessClient(config, "secret", async () => new Response("not json"));
    await expect(malformed.probe()).rejects.toThrow("invalid JSON");
  });

  it("submits multipart uploads with bounded bytes and forwards cancellation", async () => {
    let received: RequestInit | undefined;
    const fetcher: PaperlessFetch = async (_input, init) => {
      received = init;
      return json({ task_id: "a1b2c3d4-e5f6-7890-abcd-ef0123456789" });
    };
    const client = new PaperlessClient(config, "secret", fetcher);
    const controller = new AbortController();
    await client.uploadDocument(
      {
        bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
        name: "invoice.pdf",
        mediaType: "application/pdf",
      },
      { title: "Invoice", tags: [3, 4] },
      controller.signal,
    );
    expect(received?.signal).toBe(controller.signal);
    expect(received?.redirect).toBe("error");
    expect(received?.headers).toEqual({
      Authorization: "Token secret",
      Accept: "application/json; version=10",
    });
    const form = received?.body as FormData;
    expect(form.get("title")).toBe("Invoice");
    expect(form.getAll("tags")).toEqual(["3", "4"]);
    expect(form.get("document")).toBeInstanceOf(Blob);
    await expect(
      client.uploadDocument(
        { bytes: new Uint8Array(1025), name: "large.pdf", mediaType: "application/pdf" },
        {},
      ),
    ).rejects.toThrow("attachment limit");
  });

  it("sanitizes transport failures that contain the configured token", async () => {
    const token = "highly-sensitive-token";
    const client = new PaperlessClient(config, token, async () => {
      throw new Error(`fetch failed with Authorization: Token ${token}`);
    });
    await expect(client.probe()).rejects.toThrow(
      "Paperless request failed before a response was received",
    );
    await expect(client.probe()).rejects.not.toThrow(token);
  });

  it("rejects a failed request with a typed status error", async () => {
    const client = new PaperlessClient(
      config,
      "secret",
      async () => new Response("forbidden", { status: 401 }),
    );
    await expect(client.list("tags", {})).rejects.toBeInstanceOf(PaperlessHttpError);
  });
});
