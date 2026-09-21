export type OrganizerKind = "category" | "tag";

export type MealieOrganizer = {
  id: string;
  name: string;
  slug?: string;
  group?: string;
  aliases?: string[];
};

export type MealieIngredient = {
  referenceId?: string;
  title?: string;
  originalText?: string;
  display?: string;
  note?: string;
  quantity?: number | string;
  unit?: string;
  food?: string;
  substitutions?: unknown[];
  [key: string]: unknown;
};

export type RecipeSummary = {
  id?: string;
  slug: string;
  name: string;
  description?: string;
  image?: string;
  sourceUrl?: string;
  categories: MealieOrganizer[];
  tags: MealieOrganizer[];
};

export type RecipeDetail = RecipeSummary & {
  yield?: string | number;
  totalTime?: string;
  prepTime?: string;
  cookTime?: string;
  ingredients: MealieIngredient[];
  instructions: unknown[];
};

export type BoundedPage<T> = {
  items: T[];
  page: number;
  perPage: number;
  total?: number;
  totalPages?: number;
  hasNextPage?: boolean;
  hasPreviousPage?: boolean;
};

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function idOf(value: unknown): string | undefined {
  const record = asRecord(value);
  return text(record.id) ?? text(record.uuid) ?? text(record.slug);
}

export function organizer(value: unknown): MealieOrganizer | undefined {
  const record = asRecord(value);
  const id = idOf(record);
  const name = text(record.name) ?? text(record.title) ?? text(record.slug);
  if (!id || !name) return undefined;
  const slug = text(record.slug);
  const group = text(record.group);
  const aliases = Array.isArray(record.aliases)
    ? record.aliases.filter((entry): entry is string => typeof entry === "string")
    : undefined;
  return {
    id,
    name,
    ...(slug ? { slug } : {}),
    ...(group ? { group } : {}),
    ...(aliases && aliases.length > 0 ? { aliases } : {}),
  };
}

export function organizerList(value: unknown): MealieOrganizer[] {
  const record = asRecord(value);
  const entries = Array.isArray(value)
    ? value
    : Array.isArray(record.items)
      ? record.items
      : Array.isArray(record.data)
        ? record.data
        : Array.isArray(record.categories)
          ? record.categories
          : Array.isArray(record.tags)
            ? record.tags
            : Array.isArray(record.foods)
              ? record.foods
              : [];
  return entries.map(organizer).filter((entry): entry is MealieOrganizer => Boolean(entry));
}

export function recipeSummary(value: unknown): RecipeSummary {
  const record = asRecord(value);
  const slug = text(record.slug) ?? text(record.id);
  const name = text(record.name) ?? text(record.title);
  if (!slug || !name) throw new Error("Mealie recipe response lacks slug or name");
  const id = text(record.id);
  const description = text(record.description);
  const image = text(record.image);
  const sourceUrl = text(record.orgURL) ?? text(record.sourceUrl);
  return {
    ...(id ? { id } : {}),
    slug,
    name,
    ...(description ? { description } : {}),
    ...(image ? { image } : {}),
    ...(sourceUrl ? { sourceUrl } : {}),
    categories: organizerList(record.categories),
    tags: organizerList(record.tags),
  };
}

export function recipeDetail(value: unknown): RecipeDetail {
  const record = asRecord(value);
  const summary = recipeSummary(value);
  const ingredientValues = Array.isArray(record.recipeIngredient)
    ? record.recipeIngredient
    : Array.isArray(record.ingredients)
      ? record.ingredients
      : [];
  const instructions = Array.isArray(record.recipeInstructions)
    ? record.recipeInstructions
    : Array.isArray(record.instructions)
      ? record.instructions
      : [];
  const totalTime = text(record.totalTime);
  const prepTime = text(record.prepTime);
  const cookTime = text(record.cookTime);
  const recipeYield =
    typeof record.recipeYield === "number" || typeof record.recipeYield === "string"
      ? record.recipeYield
      : undefined;
  return {
    ...summary,
    ...(recipeYield === undefined ? {} : { yield: recipeYield }),
    ...(totalTime ? { totalTime } : {}),
    ...(prepTime ? { prepTime } : {}),
    ...(cookTime ? { cookTime } : {}),
    ingredients: ingredientValues.slice(0, 500).map((entry) => asRecord(entry) as MealieIngredient),
    instructions: instructions.slice(0, 500),
  };
}

export function pageItems(value: unknown): unknown[] {
  const record = asRecord(value);
  if (Array.isArray(value)) return value;
  for (const key of ["items", "recipes", "data", "categories", "tags", "foods"]) {
    if (Array.isArray(record[key])) return record[key];
  }
  return [];
}

export function pageOf<T>(
  value: unknown,
  items: T[],
  page: number,
  perPage: number,
): BoundedPage<T> {
  const record = asRecord(value);
  const total = typeof record.total === "number" ? record.total : undefined;
  const totalPages =
    typeof record.totalPages === "number"
      ? record.totalPages
      : total === undefined
        ? undefined
        : Math.ceil(total / perPage);
  const hasNextPage =
    typeof record.nextPage === "boolean"
      ? record.nextPage
      : totalPages === undefined
        ? undefined
        : page < totalPages;
  const hasPreviousPage = typeof record.previousPage === "boolean" ? record.previousPage : page > 1;
  return {
    items,
    page,
    perPage,
    ...(total === undefined ? {} : { total }),
    ...(totalPages === undefined ? {} : { totalPages }),
    ...(hasNextPage === undefined ? {} : { hasNextPage }),
    hasPreviousPage,
  };
}

export function normalizeName(value: string): string {
  return value.trim().toLocaleLowerCase();
}
