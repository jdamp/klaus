import { describe, expect, it } from "vitest";

import { MealieClient, type MealieFetch } from "../src/integrations/mealie/client.js";
import { OrganizerService } from "../src/integrations/mealie/organizers/service.js";
import { RecipeService } from "../src/integrations/mealie/recipes/service.js";

const config = {
  baseUrl: "https://mealie.test",
  apiKeyFile: "/tmp/mealie-key",
  requestTimeoutMs: 1_000,
  importTimeoutMs: 1_000,
  maxResponseBytes: 50_000,
  maxResultBytes: 50_000,
};

function response(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
}

describe("Mealie 3.28 recipe organizers", () => {
  it("assigns and clears recipeCategory and tags while preserving the rest of the recipe", async () => {
    const category = { id: "category-id", name: "Test category" };
    const tag = { id: "tag-id", name: "Test tag" };
    const original = {
      slug: "lentils",
      recipeCategory: [] as (typeof category)[],
      tags: [] as (typeof tag)[],
      recipeIngredient: [{ referenceId: "ref-1", note: "100 g lentils" }],
      recipeInstructions: [{ text: "Cook" }],
    };
    let recipe = original;
    const puts: Record<string, unknown>[] = [];
    const fetcher: MealieFetch = async (input, init) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      );
      const method = init?.method ?? "GET";
      if (url.pathname === "/api/recipes/lentils") {
        if (method === "GET") return response(recipe);
        if (method === "PUT") {
          const body = JSON.parse(init?.body as string) as Record<string, unknown>;
          puts.push(body);
          // Mealie reads recipeCategory, not categories, on recipe updates.
          recipe = {
            ...recipe,
            recipeCategory: (body.recipeCategory ?? recipe.recipeCategory) as (typeof category)[],
            tags: (body.tags ?? recipe.tags) as (typeof tag)[],
          };
          return response(recipe);
        }
      }
      if (url.pathname === "/api/organizers/categories/category-id") return response(category);
      if (url.pathname === "/api/organizers/tags/tag-id") return response(tag);
      throw new Error(`Unexpected ${method} ${url.pathname}`);
    };
    const service = new OrganizerService(new MealieClient(config, "fixture-key", fetcher));
    const signal = new AbortController().signal;
    const assigned = await service.assign("lentils", [category.id], [tag.id], signal);
    expect(assigned.categories).toEqual([category]);
    expect(assigned.tags).toEqual([tag]);
    expect(puts[0]?.recipeCategory).toEqual([category]);
    expect(puts[0]).not.toHaveProperty("categories");

    const categoriesOnly = await service.assign("lentils", [], undefined, signal);
    expect(categoriesOnly.categories).toEqual([]);
    expect(categoriesOnly.tags).toEqual([tag]);
    const cleared = await service.assign("lentils", undefined, [], signal);
    expect(cleared.categories).toEqual([]);
    expect(cleared.tags).toEqual([]);
    expect(recipe.recipeIngredient).toEqual(original.recipeIngredient);
    expect(recipe.recipeInstructions).toEqual(original.recipeInstructions);
  });

  it("rejects ambiguous recipe filters before querying recipes", async () => {
    let recipeSearches = 0;
    const fetcher: MealieFetch = async (input) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      );
      if (url.pathname === "/api/recipes") recipeSearches += 1;
      if (url.pathname === "/api/organizers/categories" || url.pathname === "/api/foods") {
        return response({
          items: [
            { id: "one", name: "Same" },
            { id: "two", name: "Same" },
          ],
        });
      }
      throw new Error("Unexpected request");
    };
    const service = new RecipeService(new MealieClient(config, "fixture-key", fetcher));
    for (const filters of [{ categories: ["Same"] }, { ingredients: ["Same"] }]) {
      await expect(service.search(filters, new AbortController().signal)).rejects.toThrow(
        "ambiguous",
      );
    }
    expect(recipeSearches).toBe(0);
  });

  it("rejects ambiguous category names before writing a recipe", async () => {
    let updates = 0;
    const fetcher: MealieFetch = async (input, init) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      );
      if (url.pathname === "/api/recipes/lentils" && init?.method === "PUT") updates += 1;
      if (url.pathname === "/api/recipes/lentils")
        return response({ slug: "lentils", recipeCategory: [], tags: [] });
      if (url.pathname === "/api/organizers/categories") {
        return response({
          items: [
            { id: "one", name: "Same" },
            { id: "two", name: "Same" },
          ],
        });
      }
      throw new Error("Unexpected request");
    };
    const service = new OrganizerService(new MealieClient(config, "fixture-key", fetcher));
    await expect(
      service.assign("lentils", ["Same"], [], new AbortController().signal),
    ).rejects.toThrow("ambiguous");
    expect(updates).toBe(0);
  });
});
