import { describe, expect, it } from "vitest";

import { AgentToolCatalog } from "../src/capabilities/catalog.js";
import { MealieProvider } from "../src/integrations/mealie/provider.js";
import type { MealieFetch } from "../src/integrations/mealie/client.js";
import { AppDatabase } from "../src/persistence/database.js";
import { ToolAuditRepository } from "../src/persistence/repositories.js";
import { SecretRedactor } from "../src/security/secrets.js";
import { parseConfig, publicConfig } from "../src/config.js";

function configYaml(root: string, mealie = ""): string {
  return `
telegram:
  tokenFile: ${root}/telegram
  allowedUsers: ["1"]
  allowedChats: ["1"]
model:
  provider: openai-codex
  id: gpt-5.4
  authPath: ${root}/auth.json
${mealie}
data:
  directory: ${root}/data
mcp: []
skills:
  paths: []
health: {}
`;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function streamResponse(value: string): Response {
  return new Response(value, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("native Mealie capability", () => {
  it("parses optional configuration and keeps the key location private", () => {
    const config = parseConfig(
      configYaml(
        "/tmp/mealie",
        "mealie:\n    baseUrl: https://mealie.test/\n    apiKeyFile: /tmp/mealie/key",
      ),
    );
    expect(config.mealie?.baseUrl).toBe("https://mealie.test");
    expect(JSON.stringify(publicConfig(config))).not.toContain("/tmp/mealie/key");
    expect(() =>
      parseConfig(
        configYaml(
          "/tmp/mealie",
          "mealie:\n    baseUrl: https://user:pass@mealie.test\n    apiKeyFile: /tmp/mealie/key",
        ),
      ),
    ).toThrow();
  });

  it("health-checks the supported version and exposes only the recipe surface", async () => {
    const database = new AppDatabase(":memory:");
    database.migrate();
    const fetcher: MealieFetch = async () => jsonResponse({ version: "3.23.1" });
    const provider = new MealieProvider(
      {
        baseUrl: "https://mealie.test",
        apiKeyFile: "/tmp/key",
        requestTimeoutMs: 1000,
        importTimeoutMs: 1000,
        maxResponseBytes: 10000,
        maxResultBytes: 10000,
      },
      "secret-key",
      new ToolAuditRepository(database),
      new SecretRedactor(),
      fetcher,
    );
    await provider.start(new AbortController().signal);
    expect(provider.health().service?.status).toBe("healthy");
    expect(
      provider
        .tools()
        .map((tool) => tool.name)
        .sort(),
    ).toEqual([
      "mealie_create_organizer",
      "mealie_get_recipe",
      "mealie_import_recipe_url",
      "mealie_list_organizers",
      "mealie_rename_organizer",
      "mealie_reparse_recipe_ingredients",
      "mealie_search_recipes",
      "mealie_set_recipe_organizers",
    ]);
    expect(
      provider
        .tools()
        .map((tool) => tool.name)
        .join(" "),
    ).not.toMatch(/delete|shopping|meal.?plan|upload/);
    await new AgentToolCatalog([provider]).start(new AbortController().signal);
    database.close();
  });

  it("uses the AI streaming path and preserves ingredient references during normalization", async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    const detail = {
      slug: "tomato-pasta",
      name: "Tomato Pasta",
      recipeIngredient: [
        { referenceId: "ingredient-1", title: "Sauce", originalText: "2 tomatoes" },
      ],
      recipeInstructions: [],
      categories: [],
      tags: [],
    };
    let updated: Record<string, unknown> | undefined;
    const fetcher: MealieFetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? "GET";
      let body: string | undefined;
      if (typeof init?.body === "string") body = init.body;
      calls.push({ url, method, ...(body ? { body } : {}) });
      if (url.endsWith("/api/app/about")) return jsonResponse({ version: "3.23.0" });
      if (url.endsWith("/api/recipes/create/ai/stream"))
        return streamResponse(["event: done", 'data: {"slug":"tomato-pasta"}', "", ""].join("\n"));
      if (url.endsWith("/api/recipes/tomato-pasta") && method === "GET")
        return jsonResponse(updated ?? detail);
      if (url.endsWith("/api/parser/ingredients"))
        return jsonResponse([{ quantity: 2, food: { name: "tomato" } }]);
      if (url.endsWith("/api/recipes/tomato-pasta") && method === "PUT") {
        updated = JSON.parse(body ?? "{}") as Record<string, unknown>;
        return jsonResponse(updated);
      }
      throw new Error(`Unexpected request ${method} ${url}`);
    };
    const database = new AppDatabase(":memory:");
    database.migrate();
    const provider = new MealieProvider(
      {
        baseUrl: "https://mealie.test",
        apiKeyFile: "/tmp/key",
        requestTimeoutMs: 1000,
        importTimeoutMs: 1000,
        maxResponseBytes: 10000,
        maxResultBytes: 10000,
      },
      "secret-key",
      new ToolAuditRepository(database),
      new SecretRedactor(),
      fetcher,
    );
    await provider.start(new AbortController().signal);
    const tool = provider
      .tools()
      .find((candidate) => candidate.name === "mealie_import_recipe_url");
    if (!tool) throw new Error("missing import tool");
    const result = await tool.execute(
      "call",
      {
        url: "https://recipes.test/pasta",
        sourceStrategy: "ai",
        ingredientStrategy: "openai",
      },
      undefined,
      undefined,
      {} as never,
    );
    expect(JSON.stringify(result)).toContain("tomato-pasta");
    const put = updated?.recipeIngredient as Array<Record<string, unknown>> | undefined;
    expect(put?.[0]?.referenceId).toBe("ingredient-1");
    expect(calls.some((call) => call.url.endsWith("/api/recipes/create/ai/stream"))).toBe(true);
    expect(calls.some((call) => call.url.endsWith("/api/parser/ingredients"))).toBe(true);
    database.close();
  });
});
