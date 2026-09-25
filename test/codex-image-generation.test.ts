import { describe, expect, it } from "vitest";

import { CodexImageGenerator } from "../src/image-generation/codex.js";
import type { AppConfig } from "../src/config.js";

const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const token = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account-1" } })).toString("base64url")}.signature`;
const config: NonNullable<AppConfig["imageGeneration"]> = {
  backend: { type: "openai-codex" },
  promptMaxBytes: 1024,
  requestTimeoutMs: 10_000,
  maxResponseBytes: 1024 * 1024,
  maxImageBytes: 1024,
};

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

describe("Codex image generator", () => {
  it("uses Pi auth and keeps provider details inside the adapter", async () => {
    let request: { url: string; init: RequestInit } | undefined;
    const generator = new CodexImageGenerator(
      { getAuth: async () => ({ auth: { apiKey: token }, source: "OAuth" }) },
      config,
      async (input, init) => {
        request = {
          url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
          init: init!,
        };
        return response({ data: [{ b64_json: Buffer.from(png).toString("base64") }] });
      },
    );

    await expect(
      generator.generate({ prompt: "a safe test image" }, new AbortController().signal),
    ).resolves.toEqual({
      bytes: png,
      mediaType: "image/png",
    });
    expect(request?.url).toBe("https://chatgpt.com/backend-api/codex/images/generations");
    expect(request?.init.body).toBe(
      JSON.stringify({
        prompt: "a safe test image",
        model: "gpt-image-2",
        background: "auto",
        quality: "auto",
        size: "auto",
      }),
    );
    expect((request?.init.headers as Record<string, string>)["chatgpt-account-id"]).toBe(
      "account-1",
    );
    expect((request?.init.headers as Record<string, string>).authorization).toBe(`Bearer ${token}`);
  });

  it("checks authentication without generating media and exposes only safe health", async () => {
    let calls = 0;
    const generator = new CodexImageGenerator(
      {
        getAuth: async () => {
          calls += 1;
          return { auth: { apiKey: token }, source: "OAuth" };
        },
      },
      config,
      async () => {
        throw new Error("must not generate during auth check");
      },
    );
    await generator.checkAuth();
    expect(calls).toBe(1);
    expect(generator.health()).toEqual({ status: "healthy" });

    const unavailable = new CodexImageGenerator(
      { getAuth: async () => undefined },
      config,
      async () => response({ data: [] }),
    );
    await unavailable.checkAuth();
    expect(unavailable.health()).toEqual({
      status: "degraded",
      detail: "Image provider authentication unavailable",
    });
  });

  it("rejects multiple images and oversized response data without exposing response content", async () => {
    const generator = new CodexImageGenerator(
      { getAuth: async () => ({ auth: { apiKey: token }, source: "OAuth" }) },
      config,
      async () => response({ data: [{ b64_json: "AAAA" }, { b64_json: "AAAA" }] }),
    );
    await expect(
      generator.generate({ prompt: "private prompt" }, new AbortController().signal),
    ).rejects.toThrow("unexpected image count");
    await expect(
      generator.generate({ prompt: "private prompt" }, new AbortController().signal),
    ).rejects.not.toThrow("private prompt");
  });
});
