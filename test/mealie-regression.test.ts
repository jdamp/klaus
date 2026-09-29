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

  it("resolves ingredient names through /api/foods and filters recipes", async () => {
    const paths: string[] = [];
    const fetcher: MealieFetch = async (input) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      );
      paths.push(url.pathname);
      if (url.pathname === "/api/foods") {
        expect(url.searchParams.get("search")).toBe("lentils");
        return new Response(JSON.stringify({ items: [{ id: "food-id", name: "lentils" }] }));
      }
      if (url.pathname === "/api/recipes") {
        expect(url.searchParams.get("foods")).toBe("food-id");
        return new Response(JSON.stringify({ total: 1, items: [detail] }));
      }
      throw new Error("Unexpected endpoint");
    };
    const service = new RecipeService(new MealieClient(config, "fixture-key", fetcher));
    const result = await service.search({ ingredients: ["lentils"] }, new AbortController().signal);
    expect(result.items.map((item) => item.slug)).toEqual(["lentils"]);
    expect(paths).toEqual(["/api/foods", "/api/recipes"]);
  });

  it("rejects a 200 HTML fallback rather than treating it as JSON", async () => {
    const client = new MealieClient(
      config,
      "fixture-key",
      async () => new Response("<html>Not an API</html>"),
    );
    await expect(client.listOrganizers("food", { search: "lentils" })).rejects.toThrow("non-JSON");
  });

  it("never sends an id-less parser food to recipe update", async () => {
    const paths: string[] = [];
    const fetcher: MealieFetch = async (input, init) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      );
      paths.push(`${init?.method ?? "GET"} ${url.pathname}`);
      if (url.pathname === "/api/recipes/lentils" && init?.method !== "PUT") {
        return new Response(JSON.stringify(detail));
      }
      if (url.pathname === "/api/parser/ingredients") {
        return new Response(
          JSON.stringify([{ ingredient: { food: { name: "unregistered-food" } } }]),
        );
      }
      if (url.pathname === "/api/foods") {
        return new Response(JSON.stringify({ items: [], total_pages: 1 }));
      }
      throw new Error("Recipe must not be updated with an unknown food");
    };
    const service = new RecipeService(new MealieClient(config, "fixture-key", fetcher));
    await expect(service.reparse("lentils", new AbortController().signal)).rejects.toMatchObject({
      outcome: "partial",
      result: { slug: "lentils", stage: "ingredient_normalization" },
    } satisfies Partial<NativeToolError>);
    expect(paths).not.toContain("PUT /api/recipes/lentils");
  });

  it("preflights ambiguous references before any opt-in catalogue creation", async () => {
    const mutations: string[] = [];
    const fetcher: MealieFetch = async (input, init) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      );
      if (init?.method === "POST" && url.pathname !== "/api/parser/ingredients") {
        mutations.push(url.pathname);
      }
      if (url.pathname === "/api/recipes/lentils") return new Response(JSON.stringify(detail));
      if (url.pathname === "/api/parser/ingredients") {
        return new Response(
          JSON.stringify([
            {
              ingredient: { food: { name: "new-food" }, unit: { name: "duplicate-unit" } },
            },
          ]),
        );
      }
      if (url.pathname === "/api/foods") return new Response(JSON.stringify({ items: [] }));
      if (url.pathname === "/api/units")
        return new Response(
          JSON.stringify({
            items: [
              { id: "one", name: "duplicate-unit" },
              { id: "two", name: "duplicate-unit" },
            ],
          }),
        );
      throw new Error("Unexpected mutation");
    };
    const service = new RecipeService(new MealieClient(config, "fixture-key", fetcher));
    await expect(
      service.reparse("lentils", new AbortController().signal, true),
    ).rejects.toMatchObject({
      outcome: "partial",
      result: { stage: "ingredient_normalization" },
    } satisfies Partial<NativeToolError>);
    expect(mutations).toEqual([]);
  });

  it("creates missing foods and units only with explicit opt-in and stable IDs", async () => {
    const calls: string[] = [];
    let recipe: { recipeIngredient: Record<string, unknown>[] } = detail;
    const fetcher: MealieFetch = async (input, init) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      );
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url.pathname}`);
      const kind = url.pathname.startsWith("/api/foods") ? "food" : "unit";
      const name = kind === "food" ? "lentils" : "grams";
      const id = `${kind}-id`;
      if (url.pathname === "/api/recipes/lentils") {
        if (method === "PUT") {
          recipe = JSON.parse(init?.body as string) as typeof recipe;
          return new Response(JSON.stringify(recipe));
        }
        return new Response(JSON.stringify(recipe));
      }
      if (url.pathname === "/api/parser/ingredients") {
        return new Response(
          JSON.stringify([
            {
              ingredient: {
                note: "100 g lentils",
                food: { name: "lentils" },
                unit: { name: "grams" },
              },
            },
          ]),
        );
      }
      if (url.pathname === "/api/foods" || url.pathname === "/api/units") {
        return method === "POST"
          ? new Response(JSON.stringify({ id, name }))
          : new Response(JSON.stringify({ items: [], total_pages: 1 }));
      }
      if (url.pathname === `/api/${kind}s/${id}`) return new Response(JSON.stringify({ id, name }));
      throw new Error("Unexpected endpoint");
    };
    const service = new RecipeService(new MealieClient(config, "fixture-key", fetcher));
    const result = await service.reparse("lentils", new AbortController().signal, true);
    expect(result.ingredients[0]?.food).toMatchObject({ id: "food-id", name: "lentils" });
    expect(calls.filter((call) => ["POST /api/foods", "POST /api/units"].includes(call))).toEqual([
      "POST /api/foods",
      "POST /api/units",
    ]);
    expect(calls).toContain("PUT /api/recipes/lentils");
    expect(calls.indexOf("POST /api/foods")).toBeGreaterThan(calls.indexOf("GET /api/units"));
    expect(recipe.recipeIngredient[0]?.referenceId).toBe("ref-1");
    expect(recipe.recipeIngredient[0]?.unit).toMatchObject({ id: "unit-id", name: "grams" });
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
