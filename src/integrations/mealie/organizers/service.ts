import type { MealieClient } from "../client.js";
import {
  asRecord,
  normalizeName,
  organizer,
  organizerList,
  pageItems,
  pageOf,
  type BoundedPage,
  type MealieOrganizer,
  type OrganizerKind,
} from "../types.js";

const MAX_PAGE = 100;

export class OrganizerService {
  constructor(private readonly client: MealieClient) {}

  async list(
    kind: OrganizerKind,
    search: string | undefined,
    page = 1,
    perPage = 25,
    signal: AbortSignal,
  ): Promise<BoundedPage<MealieOrganizer>> {
    const boundedPage = positiveInt(page, 1);
    const boundedPerPage = Math.min(MAX_PAGE, positiveInt(perPage, 25));
    const raw = await this.client.listOrganizers(
      kind,
      { search: search?.trim() || undefined, page: boundedPage, perPage: boundedPerPage },
      signal,
    );
    return pageOf(raw, organizerList(raw).slice(0, boundedPerPage), boundedPage, boundedPerPage);
  }

  async create(kind: OrganizerKind, name: string, signal: AbortSignal): Promise<MealieOrganizer> {
    const created = organizer(await this.client.createOrganizer(kind, name, signal));
    if (!created) throw new Error(`Mealie did not return the created ${kind}`);
    return this.readBack(kind, created, signal);
  }

  async rename(
    kind: OrganizerKind,
    id: string,
    name: string,
    signal: AbortSignal,
  ): Promise<MealieOrganizer> {
    const renamed = organizer(await this.client.renameOrganizer(kind, id, name, signal));
    return this.readBack(kind, renamed ?? { id, name }, signal);
  }

  async assign(
    slug: string,
    categories: string[] | undefined,
    tags: string[] | undefined,
    signal: AbortSignal,
  ): Promise<{ slug: string; categories: MealieOrganizer[]; tags: MealieOrganizer[] }> {
    const raw = asRecord(await this.client.getRecipe(slug, signal));
    const resolvedCategories =
      categories === undefined ? undefined : await this.resolveAll("category", categories, signal);
    const resolvedTags =
      tags === undefined ? undefined : await this.resolveAll("tag", tags, signal);
    const payload: Record<string, unknown> = { ...raw };
    if (resolvedCategories !== undefined) payload.categories = resolvedCategories;
    if (resolvedTags !== undefined) payload.tags = resolvedTags;
    await this.client.updateRecipe(slug, payload, signal);
    const verified = asRecord(await this.client.getRecipe(slug, signal));
    const actualCategories = organizerList(verified.categories);
    const actualTags = organizerList(verified.tags);
    if (resolvedCategories !== undefined && !sameIds(resolvedCategories, actualCategories)) {
      throw new Error("Mealie category assignment verification failed");
    }
    if (resolvedTags !== undefined && !sameIds(resolvedTags, actualTags)) {
      throw new Error("Mealie tag assignment verification failed");
    }
    return { slug, categories: actualCategories, tags: actualTags };
  }

  private async resolveAll(
    kind: OrganizerKind,
    values: string[],
    signal: AbortSignal,
  ): Promise<MealieOrganizer[]> {
    const result: MealieOrganizer[] = [];
    for (const value of values) {
      if (looksLikeStableId(value)) {
        const direct = organizer(await this.client.getOrganizer(kind, value, signal));
        if (!direct) throw new Error(`Mealie ${kind} not found: ${value}`);
        result.push(direct);
        continue;
      }
      const raw = await this.client.listOrganizers(
        kind,
        { search: value, page: 1, perPage: MAX_PAGE },
        signal,
      );
      const matches = pageItems(raw)
        .map(organizer)
        .filter((entry): entry is MealieOrganizer => Boolean(entry))
        .filter(
          (entry) =>
            normalizeName(entry.name) === normalizeName(value) ||
            (entry.slug && normalizeName(entry.slug) === normalizeName(value)),
        );
      if (matches.length !== 1) {
        throw new Error(
          matches.length === 0
            ? `Mealie ${kind} not found: ${value}`
            : `Mealie ${kind} name is ambiguous: ${value}; candidates: ${matches
                .slice(0, 10)
                .map((candidate) => `${candidate.name} (${candidate.id})`)
                .join(", ")}`,
        );
      }
      result.push(matches[0]!);
    }
    return result;
  }

  private async readBack(
    kind: OrganizerKind,
    candidate: MealieOrganizer,
    signal: AbortSignal,
  ): Promise<MealieOrganizer> {
    const fetched = await this.client.getOrganizer(kind, candidate.id, signal);
    return organizer(fetched) ?? candidate;
  }
}

function positiveInt(value: number, fallback: number): number {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function looksLikeStableId(value: string): boolean {
  return (
    /^[0-9a-f]{8}-[0-9a-f-]{20,}$/i.test(value) ||
    /^[0-9a-f]{16,}$/i.test(value) ||
    /^[a-z0-9]+(?:-[a-z0-9]+)+$/i.test(value)
  );
}

function sameIds(left: readonly MealieOrganizer[], right: readonly MealieOrganizer[]): boolean {
  return (
    left
      .map((entry) => entry.id)
      .sort()
      .join(",") ===
    right
      .map((entry) => entry.id)
      .sort()
      .join(",")
  );
}
