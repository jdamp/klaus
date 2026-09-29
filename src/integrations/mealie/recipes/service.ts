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
  translateLanguage?: string;
};

export class RecipeService {
  constructor(
    private readonly client: MealieClient,
    private readonly publicUrl?: string,
    private readonly groupSlug?: () => string | undefined,
  ) {}

  private urlFor(slug: string): string | undefined {
    const group = this.groupSlug?.();
    return this.publicUrl && group
      ? `${this.publicUrl}/g/${encodeURIComponent(group)}/r/${encodeURIComponent(slug)}`
      : undefined;
  }

  private link<T extends RecipeSummary>(recipe: T): T {
    const recipeUrl = this.urlFor(recipe.slug);
    return recipeUrl ? { ...recipe, recipeUrl } : recipe;
  }

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
    const items = pageItems(raw)
      .slice(0, perPage)
      .map((item) => this.link(recipeSummary(item)));
    return pageOf(raw, items, page, perPage);
  }

  async get(slug: string, signal: AbortSignal): Promise<RecipeDetail> {
    try {
      return this.link(recipeDetail(await this.client.getRecipe(slug, signal)));
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
      ...(input.sourceStrategy === "scraper"
        ? { includeTags: input.includeTags, includeCategories: input.includeCategories }
        : { createNewOrganizers: false, translateLanguage: input.translateLanguage }),
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
        ...(this.urlFor(slug) ? { recipeUrl: this.urlFor(slug) } : {}),
        stage: "recipe_verification",
        error: safeError(error),
      });
    }
    if (!detail.ingredients.some(hasIngredientContent)) {
      throw new NativeToolError("Recipe created without usable ingredients", "partial", {
        status: "partial",
        slug,
        ...(detail.recipeUrl ? { recipeUrl: detail.recipeUrl } : {}),
        stage: "ingredient_verification",
        error:
          "Mealie returned no usable ingredient text or food; review the created recipe before attempting another import",
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
            ...(detail.recipeUrl ? { recipeUrl: detail.recipeUrl } : {}),
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
        ...(detail.recipeUrl ? { recipeUrl: detail.recipeUrl } : {}),
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
    if (source.length === 0) throw new Error("Recipe has no ingredients to normalize");
    const parsed = await this.client.parseIngredients(source as string[], signal);
    const parsedValues: unknown = Array.isArray(parsed) ? parsed : asRecord(parsed).ingredients;
    const values: unknown[] = Array.isArray(parsedValues) ? parsedValues : [];
    if (values.length !== detail.ingredients.length) {
      throw new Error("Mealie ingredient parser returned an unexpected number of ingredients");
    }
    const ingredients: Record<string, unknown>[] = [];
    const resolved = new Map<string, { id: string; name: string }>();
    for (const [index, value] of values.entries()) {
      const ingredient = asRecord(asRecord(value).ingredient);
      if (Object.keys(ingredient).length === 0) {
        throw new Error(`Mealie parser returned an invalid ingredient at position ${index + 1}`);
      }
      const food = await this.resolveParsedReference("food", ingredient.food, resolved, signal);
      const unit = await this.resolveParsedReference("unit", ingredient.unit, resolved, signal);
      ingredients.push(
        preserveIngredient(detail.ingredients[index]!, {
          ...ingredient,
          food,
          unit,
        }),
      );
    }
    const rawRecipe = asRecord(await this.client.getRecipe(slug, signal));
    const recipePayload: Record<string, unknown> = {
      ...rawRecipe,
      recipeIngredient: ingredients,
    };
    await this.client.updateRecipe(slug, recipePayload, signal);
    const verified = recipeDetail(await this.client.getRecipe(slug, signal));
    verifyIngredients(detail.ingredients, verified.ingredients);
    if (!verified.ingredients.some(hasIngredientContent)) {
      throw new Error("Recipe ingredient update produced no usable ingredients");
    }
  }

  private async resolveParsedReference(
    kind: "food" | "unit",
    value: unknown,
    resolved: Map<string, { id: string; name: string }>,
    signal: AbortSignal,
  ): Promise<{ id: string; name: string } | null> {
    if (value === null || value === undefined) return null;
    const record = asRecord(value);
    const name = typeof record.name === "string" ? record.name.trim() : "";
    if (!name) throw new Error(`Mealie parser returned a ${kind} without a name`);
    if (typeof record.id === "string" && record.id) return { id: record.id, name };
    const cacheKey = `${kind}:${normalizeName(name)}`;
    const cached = resolved.get(cacheKey);
    if (cached) return cached;
    const matches: Array<{ id: string; name: string }> = [];
    for (let page = 1; page <= 5; page += 1) {
      const params = { search: name, page, perPage: MAX_PAGE };
      const response =
        kind === "food"
          ? await this.client.listOrganizers("food", params, signal)
          : await this.client.listUnits(params, signal);
      const entries = pageItems(response);
      for (const entry of entries) {
        const candidate = organizer(entry);
        if (!candidate) continue;
        const raw = asRecord(entry);
        const aliases = [
          candidate.name,
          ...(candidate.aliases ?? []),
          ...(kind === "unit" && typeof raw.abbreviation === "string" ? [raw.abbreviation] : []),
        ];
        if (aliases.some((alias) => normalizeName(alias) === normalizeName(name))) {
          matches.push({ id: candidate.id, name: candidate.name });
        }
      }
      const totalPages = Number(asRecord(response).total_pages ?? 1);
      if (!Number.isFinite(totalPages) || totalPages <= page) break;
      if (page === 5) throw new Error(`Mealie ${kind} lookup exceeded its page bound`);
    }
    if (matches.length !== 1) {
      throw new Error(
        matches.length === 0
          ? `Mealie ${kind} is not registered: ${name}; no recipe update was made`
          : `Mealie ${kind} is ambiguous: ${name}; no recipe update was made`,
      );
    }
    const match = matches[0]!;
    resolved.set(cacheKey, match);
    return match;
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

function hasIngredientContent(ingredient: MealieIngredient): boolean {
  return Boolean(
    ingredient.originalText?.trim() ||
    ingredient.display?.trim() ||
    ingredient.note?.trim() ||
    (asRecord(ingredient.food).name && typeof asRecord(ingredient.food).name === "string"),
  );
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

function streamSlug(events: readonly { data: unknown; event?: string }[]): string | undefined {
  for (const event of events) {
    if (
      event.event === "done" &&
      typeof event.data === "string" &&
      event.data.trim() &&
      !event.data.includes(" ")
    )
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
