import { describe, expect, it } from "vitest";

import { MealieClient, type MealieFetch } from "../src/integrations/mealie/client.js";
import { RecipeService } from "../src/integrations/mealie/recipes/service.js";
import type { NativeToolError } from "../src/capabilities/execution.js";
import { parseConfig } from "../src/config.js";

const config = {
  baseUrl: "https://mealie.test",
  apiKeyFile: "/tmp/mealie-key",
  requestTimeoutMs: 1_000,
  importTimeoutMs: 1_000,
  maxResponseBytes: 50_000,
  maxResultBytes: 50_000,
};
const done = new Response('event: done\ndata: {"slug":"lentils"}\n\n', {
  headers: { "content-type": "text/event-stream" },
});
const detail = {
  slug: "lentils",
  name: "Lentils",
  recipeCategory: [{ id: "category-id", name: "Dinner" }],
  recipeIngredient: [{ referenceId: "ref-1", note: "100 g lentils" }],
};

describe("Mealie 3.28 recipe regression", () => {
  it("sends JSON with camelCase keys to scraper stream, not multipart", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher: MealieFetch = async (url, init) => {
      const address = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      calls.push({ url: address, ...(init ? { init } : {}) });
      return address.includes("/stream") ? done.clone() : new Response(JSON.stringify(detail));
    };
    const service = new RecipeService(
      new MealieClient(config, "fixture-key", fetcher),
      "https://mealie.test",
      () => "home",
    );
    const result = await service.import(
      {
        url: "https://source.test/lentils",
        sourceStrategy: "scraper",
        ingredientStrategy: "imported",
        includeTags: true,
      },
      new AbortController().signal,
    );
    expect(result.recipeUrl).toBe("https://mealie.test/g/home/r/lentils");
    expect(result.categories).toEqual([{ id: "category-id", name: "Dinner" }]);
    expect(calls[0]?.init?.headers).toMatchObject({ "content-type": "application/json" });
    expect(JSON.parse(calls[0]?.init?.body as string)).toEqual({
      url: "https://source.test/lentils",
      includeTags: true,
      includeCategories: false,
    });
    expect(calls).toHaveLength(2);
  });

  it("does not claim a successful import when Mealie created empty ingredient slots", async () => {
    const fetcher: MealieFetch = async (url) =>
      (typeof url === "string" ? url : url instanceof URL ? url.href : url.url).includes("/stream")
        ? done.clone()
        : new Response(
            JSON.stringify({
              ...detail,
              recipeIngredient: [{ title: "Sauce", referenceId: "ref-1" }],
            }),
          );
    const service = new RecipeService(
      new MealieClient(config, "fixture-key", fetcher),
      "https://mealie.test",
      () => "home",
    );
    await expect(
      service.import(
        { url: "https://source.test/lentils", sourceStrategy: "ai", ingredientStrategy: "openai" },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      outcome: "partial",
      result: {
        slug: "lentils",
        stage: "ingredient_verification",
        recipeUrl: "https://mealie.test/g/home/r/lentils",
      },
    } satisfies Partial<NativeToolError>);
  });

  it("rejects a public URL with a path, credentials, query, or fragment", () => {
    const yaml = (url: string) =>
      `telegram:\n  tokenFile: /tmp/telegram\n  allowedUsers: ["1"]\n  allowedChats: ["1"]\nmodel:\n  provider: openai-codex\n  id: gpt-5.4\n  authPath: /tmp/auth.json\ndata:\n  directory: /tmp/data\nmcp: []\nskills:\n  paths: []\nhealth: {}\nmealie:\n  baseUrl: https://mealie.test\n  publicUrl: ${url}\n  apiKeyFile: /tmp/mealie-key\n`;
    for (const url of [
      "https://host.test/g/home",
      "https://a:b@host.test",
      "https://host.test/?x=y",
      "https://host.test/#fragment",
    ]) {
      expect(() => parseConfig(yaml(url))).toThrow();
    }
  });
});
