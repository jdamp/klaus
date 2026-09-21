import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import { nativeTool, type NativeToolExecutor } from "../../../capabilities/execution.js";
import type { RecipeService, RecipeImportInput, RecipeSearchInput } from "./service.js";

const searchParameters = {
  type: "object",
  additionalProperties: false,
  properties: {
    text: { type: "string", minLength: 1 },
    categories: { type: "array", items: { type: "string", minLength: 1 }, maxItems: 20 },
    tags: { type: "array", items: { type: "string", minLength: 1 }, maxItems: 20 },
    ingredients: { type: "array", items: { type: "string", minLength: 1 }, maxItems: 20 },
    requireAllCategories: { type: "boolean" },
    requireAllTags: { type: "boolean" },
    requireAllIngredients: { type: "boolean" },
    page: { type: "integer", minimum: 1 },
    perPage: { type: "integer", minimum: 1, maximum: 100 },
  },
};

const importParameters = {
  type: "object",
  additionalProperties: false,
  required: ["url", "sourceStrategy", "ingredientStrategy"],
  properties: {
    url: { type: "string", format: "uri" },
    sourceStrategy: { type: "string", enum: ["scraper", "ai"] },
    ingredientStrategy: { type: "string", enum: ["imported", "openai"] },
    includeTags: { type: "boolean" },
    includeCategories: { type: "boolean" },
    translate: { type: "boolean" },
  },
};

export function recipeTools(
  service: RecipeService,
  executor: NativeToolExecutor,
  importTimeoutMs: number,
): ToolDefinition[] {
  return [
    nativeTool({
      executor,
      name: "mealie_search_recipes",
      description: "Search Mealie recipes by text, categories, tags, or ingredients.",
      parameters: searchParameters,
      parse: parseSearch,
      execute: (args, signal) => service.search(args, signal),
    }),
    nativeTool({
      executor,
      name: "mealie_get_recipe",
      description: "Retrieve bounded details for one Mealie recipe by slug.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["slug"],
        properties: { slug: { type: "string", minLength: 1, maxLength: 200 } },
      },
      parse: (value) => {
        const object = objectValue(value);
        return { slug: stringValue(object.slug, "slug") };
      },
      execute: ({ slug }, signal) => service.get(slug, signal),
    }),
    nativeTool({
      executor,
      name: "mealie_import_recipe_url",
      description: "Import a recipe URL into Mealie using the selected scraper or AI workflow.",
      parameters: importParameters,
      parse: parseImport,
      execute: (args, signal) => service.import(args, signal),
      timeoutMs: importTimeoutMs,
    }),
    nativeTool({
      executor,
      name: "mealie_reparse_recipe_ingredients",
      description: "Normalize an existing Mealie recipe's ingredients with the OpenAI parser.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["slug"],
        properties: { slug: { type: "string", minLength: 1, maxLength: 200 } },
      },
      parse: (value) => {
        const object = objectValue(value);
        return { slug: stringValue(object.slug, "slug") };
      },
      execute: ({ slug }, signal) => service.reparse(slug, signal),
    }),
  ];
}

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Tool arguments must be an object");
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Invalid ${name}`);
  return value.trim();
}

function stringsValue(value: unknown, name: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim()))
    throw new Error(`Invalid ${name}`);
  return value.map((entry) => (entry as string).trim());
}

function parseSearch(value: unknown): RecipeSearchInput {
  const object = objectValue(value);
  const categories = stringsValue(object.categories, "categories");
  const tags = stringsValue(object.tags, "tags");
  const ingredients = stringsValue(object.ingredients, "ingredients");
  return {
    ...(object.text === undefined ? {} : { text: stringValue(object.text, "text") }),
    ...(categories ? { categories } : {}),
    ...(tags ? { tags } : {}),
    ...(ingredients ? { ingredients } : {}),
    ...(typeof object.requireAllCategories === "boolean"
      ? { requireAllCategories: object.requireAllCategories }
      : {}),
    ...(typeof object.requireAllTags === "boolean"
      ? { requireAllTags: object.requireAllTags }
      : {}),
    ...(typeof object.requireAllIngredients === "boolean"
      ? { requireAllIngredients: object.requireAllIngredients }
      : {}),
    ...(typeof object.page === "number" ? { page: object.page } : {}),
    ...(typeof object.perPage === "number" ? { perPage: object.perPage } : {}),
  };
}

function parseImport(value: unknown): RecipeImportInput {
  const object = objectValue(value);
  const url = stringValue(object.url, "url");
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password)
    throw new Error("Recipe URL must use HTTP(S) without embedded credentials");
  if (object.sourceStrategy !== "scraper" && object.sourceStrategy !== "ai")
    throw new Error("Invalid sourceStrategy");
  if (object.ingredientStrategy !== "imported" && object.ingredientStrategy !== "openai")
    throw new Error("Invalid ingredientStrategy");
  if (object.sourceStrategy === "scraper" && object.translate !== undefined)
    throw new Error("translate is only valid for the AI source strategy");
  return {
    url,
    sourceStrategy: object.sourceStrategy,
    ingredientStrategy: object.ingredientStrategy,
    ...(typeof object.includeTags === "boolean" ? { includeTags: object.includeTags } : {}),
    ...(typeof object.includeCategories === "boolean"
      ? { includeCategories: object.includeCategories }
      : {}),
    ...(typeof object.translate === "boolean" ? { translate: object.translate } : {}),
  };
}
