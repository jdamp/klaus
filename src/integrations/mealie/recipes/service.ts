import { NativeToolError } from "../../../capabilities/execution.js";
import { MealieHttpError, MealieStreamError, type MealieClient } from "../client.js";
import {
  asRecord,
  normalizeName,
  organizer,
  pageItems,
  pageOf,
  recipeDetail,
  recipeSummary,
  type BoundedPage,
  type MealieIngredient,
  type RecipeDetail,
  type RecipeSummary,
} from "../types.js";

const MAX_PAGE = 100;

export type RecipeSearchInput = {
  text?: string;
  categories?: string[];
  tags?: string[];
  ingredients?: string[];
  requireAllCategories?: boolean;
  requireAllTags?: boolean;
  requireAllIngredients?: boolean;
  page?: number;
  perPage?: number;
};

export type RecipeImportInput = {
  url: string;
  sourceStrategy: "scraper" | "ai";
  ingredientStrategy: "imported" | "openai";
  includeTags?: boolean;
  includeCategories?: boolean;
  translate?: boolean;
};

export class RecipeService {
  constructor(private readonly client: MealieClient) {}

  async search(input: RecipeSearchInput, signal: AbortSignal): Promise<BoundedPage<RecipeSummary>> {
    const page = positiveInt(input.page, 1);
    const perPage = Math.min(MAX_PAGE, positiveInt(input.perPage, 25));
    const categories = await this.resolveMany("category", input.categories ?? [], signal);
    const tags = await this.resolveMany("tag", input.tags ?? [], signal);
    const foods = await this.resolveFoods(input.ingredients ?? [], signal);
    const raw = await this.client.searchRecipes(
      {
        search: input.text?.trim() || undefined,
        categories,
        tags,
        foods,
        requireAllCategories: input.requireAllCategories,
        requireAllTags: input.requireAllTags,
        requireAllFoods: input.requireAllIngredients,
        page,
        perPage,
      },
      signal,
    );
    const items = pageItems(raw).slice(0, perPage).map(recipeSummary);
    return pageOf(raw, items, page, perPage);
  }

  async get(slug: string, signal: AbortSignal): Promise<RecipeDetail> {
    try {
      return recipeDetail(await this.client.getRecipe(slug, signal));
    } catch (error) {
      if (error instanceof MealieHttpError && error.status === 404) {
        throw new Error(`Mealie recipe not found: ${slug}`, { cause: error });
      }
      throw error;
    }
  }

  async import(input: RecipeImportInput, signal: AbortSignal): Promise<RecipeDetail> {
    const options: Record<string, string | boolean | undefined> = {
      url: input.url,
      include_tags: input.includeTags,
      include_categories: input.includeCategories,
      createNewOrganizers: false,
      ...(input.sourceStrategy === "ai" ? { translate: input.translate } : {}),
    };
    let events;
    try {
      events = await this.client.importRecipeUrl(input.sourceStrategy, options, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      if (error instanceof MealieStreamError) {
        throw new NativeToolError("Mealie import stream ended unexpectedly", "indeterminate", {
          status: "indeterminate",
          sourceStrategy: input.sourceStrategy,
        });
      }
      throw error;
    }
    const slug = streamSlug(events);
    const streamError = streamFailure(events);
    if (streamError) throw new Error(`Mealie import failed: ${streamError}`);
    if (!slug) {
      throw new NativeToolError("Mealie import ended without a terminal result", "indeterminate", {
        status: "indeterminate",
        sourceStrategy: input.sourceStrategy,
      });
    }
    let detail: RecipeDetail;
    try {
      detail = await this.get(slug, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      throw new NativeToolError("Recipe was created but could not be retrieved", "partial", {
        status: "partial",
        slug,
        stage: "recipe_verification",
        error: safeError(error),
      });
    }
    if (input.ingredientStrategy === "openai") {
      try {
        await this.normalize(slug, detail, signal);
        detail = await this.get(slug, signal);
      } catch (error) {
        if (signal.aborted || error instanceof NativeToolError) throw error;
        throw new NativeToolError(
          "Recipe was created but ingredient normalization failed",
          "partial",
          {
            status: "partial",
            slug,
            stage: "ingredient_normalization",
            error: safeError(error),
          },
        );
      }
    }
    return detail;
  }

  async reparse(slug: string, signal: AbortSignal): Promise<RecipeDetail> {
    const detail = await this.get(slug, signal);
    try {
      await this.normalize(slug, detail, signal);
      return await this.get(slug, signal);
    } catch (error) {
      if (signal.aborted || error instanceof NativeToolError) throw error;
      throw new NativeToolError("Recipe ingredient normalization failed", "partial", {
        status: "partial",
        slug,
        stage: "ingredient_normalization",
        error: safeError(error),
      });
    }
  }

  private async normalize(slug: string, detail: RecipeDetail, signal: AbortSignal): Promise<void> {
    const source = detail.ingredients.map(
      (ingredient) =>
        ingredient.originalText?.trim() || ingredient.display?.trim() || ingredient.note?.trim(),
    );
    if (source.some((value) => !value)) throw new Error("Every ingredient must have source text");
    const parsed = await this.client.parseIngredients(source as string[], signal);
    const parsedValues: unknown = Array.isArray(parsed) ? parsed : asRecord(parsed).ingredients;
    const values: unknown[] = Array.isArray(parsedValues) ? parsedValues : [];
    if (values.length !== detail.ingredients.length) {
      throw new Error("Mealie ingredient parser returned an unexpected number of ingredients");
    }
    const rawRecipe = asRecord(await this.client.getRecipe(slug, signal));
    const recipePayload: Record<string, unknown> = {
      ...rawRecipe,
      recipeIngredient: values.map((value, index) =>
        preserveIngredient(detail.ingredients[index]!, asRecord(value)),
      ),
    };
    await this.client.updateRecipe(slug, recipePayload, signal);
    const verified = recipeDetail(await this.client.getRecipe(slug, signal));
    verifyIngredients(detail.ingredients, verified.ingredients);
  }

  private async resolveMany(
    kind: "category" | "tag",
    values: string[],
    signal: AbortSignal,
  ): Promise<string[]> {
    const resolved: string[] = [];
    for (const value of values) resolved.push(await this.resolveOrganizer(kind, value, signal));
    return resolved;
  }

  private async resolveOrganizer(
    kind: "category" | "tag",
    value: string,
    signal: AbortSignal,
  ): Promise<string> {
    if (looksLikeStableId(value)) return value;
    const raw = await this.client.listOrganizers(
      kind,
      { search: value, page: 1, perPage: MAX_PAGE },
      signal,
    );
    const candidates = pageItems(raw)
      .map(organizer)
      .filter((entry): entry is NonNullable<ReturnType<typeof organizer>> => Boolean(entry));
    const matches = candidates.filter(
      (candidate) =>
        normalizeName(candidate.name) === normalizeName(value) ||
        (candidate.slug && normalizeName(candidate.slug) === normalizeName(value)) ||
        candidate.aliases?.some((alias) => normalizeName(alias) === normalizeName(value)),
    );
    if (matches.length === 1) return matches[0]!.id;
    if (matches.length === 0) throw new Error(`Mealie ${kind} not found: ${value}`);
    throw new Error(
      `Mealie ${kind} name is ambiguous: ${value}; candidates: ${matches
        .slice(0, 10)
        .map((candidate) => `${candidate.name} (${candidate.id})`)
        .join(", ")}`,
    );
  }

  private async resolveFoods(values: string[], signal: AbortSignal): Promise<string[]> {
    const resolved: string[] = [];
    for (const value of values) {
      if (looksLikeStableId(value)) {
        resolved.push(value);
        continue;
      }
      const raw = await this.client.listOrganizers(
        "food",
        { search: value, page: 1, perPage: MAX_PAGE },
        signal,
      );
      const candidates = pageItems(raw)
        .map(organizer)
        .filter((entry): entry is NonNullable<ReturnType<typeof organizer>> => Boolean(entry));
      const matches = candidates.filter(
        (candidate) =>
          normalizeName(candidate.name) === normalizeName(value) ||
          candidate.aliases?.some((alias) => normalizeName(alias) === normalizeName(value)),
      );
      if (matches.length !== 1) {
        throw new Error(
          matches.length === 0
            ? `Mealie ingredient not found: ${value}`
            : `Mealie ingredient name is ambiguous: ${value}; candidates: ${matches
                .slice(0, 10)
                .map((candidate) => `${candidate.name} (${candidate.id})`)
                .join(", ")}`,
        );
      }
      resolved.push(matches[0]!.id);
    }
    return resolved;
  }
}

function preserveIngredient(
  original: MealieIngredient,
  parsed: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...parsed,
    ...(original.referenceId ? { referenceId: original.referenceId } : {}),
    ...(original.title ? { title: original.title } : {}),
  };
}

function verifyIngredients(
  before: readonly MealieIngredient[],
  after: readonly MealieIngredient[],
): void {
  if (before.length !== after.length)
    throw new Error("Recipe ingredient count changed during normalization");
  for (let index = 0; index < before.length; index += 1) {
    if (before[index]?.referenceId && before[index]?.referenceId !== after[index]?.referenceId) {
      throw new Error("Recipe ingredient reference changed during normalization");
    }
    if ((before[index]?.title ?? "") !== (after[index]?.title ?? "")) {
      throw new Error("Recipe ingredient section changed during normalization");
    }
  }
}

function streamSlug(events: readonly { data: unknown }[]): string | undefined {
  for (const event of events) {
    if (typeof event.data === "string" && event.data.trim() && !event.data.includes(" "))
      return event.data.trim();
    const record = asRecord(event.data);
    const recipe = asRecord(record.recipe);
    const slug =
      typeof record.slug === "string"
        ? record.slug
        : typeof recipe.slug === "string"
          ? recipe.slug
          : undefined;
    if (slug) return slug;
  }
  return undefined;
}

function streamFailure(events: readonly { data: unknown; event?: string }[]): string | undefined {
  const event = [...events]
    .reverse()
    .find((candidate) => candidate.event === "error" || Boolean(asRecord(candidate.data).error));
  if (!event) return undefined;
  const value = asRecord(event.data).error ?? event.data;
  return typeof value === "string" ? value : JSON.stringify(value);
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : "Mealie operation failed";
}

function positiveInt(value: number | undefined, fallback: number): number {
  return value && Number.isInteger(value) && value > 0 ? value : fallback;
}

function looksLikeStableId(value: string): boolean {
  return (
    /^[0-9a-f]{8}-[0-9a-f-]{20,}$/i.test(value) ||
    /^[0-9a-f]{16,}$/i.test(value) ||
    /^[a-z0-9]+(?:-[a-z0-9]+)+$/i.test(value)
  );
}
