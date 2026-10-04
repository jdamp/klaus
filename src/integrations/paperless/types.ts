import type { PaperlessCollection } from "./client.js";

export type PaperlessOrganizerKind = "tag" | "correspondent" | "document_type";
export type PaperlessOrganizer = { id: number; name: string };
export type PaperlessPage<T> = {
  items: T[];
  page: number;
  perPage: number;
  total?: number;
  totalPages?: number;
  hasNextPage: boolean;
};

export const PAPERLESS_ORGANIZERS: Record<
  PaperlessOrganizerKind,
  Exclude<PaperlessCollection, "documents">
> = {
  tag: "tags",
  correspondent: "correspondents",
  document_type: "document_types",
};

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function organizer(value: unknown): PaperlessOrganizer {
  const record = asRecord(value);
  const id = record.id;
  const name = record.name;
  if (
    typeof id !== "number" ||
    !Number.isSafeInteger(id) ||
    id < 1 ||
    typeof name !== "string" ||
    !name.trim()
  ) {
    throw new Error("Paperless organizer response is incompatible");
  }
  return { id, name: name.trim().slice(0, 256) };
}

export function pageOf<T>(
  value: unknown,
  map: (entry: unknown) => T,
  page: number,
  perPage: number,
): PaperlessPage<T> {
  const record = asRecord(value);
  if (
    !Array.isArray(record.results) ||
    typeof record.count !== "number" ||
    !Number.isSafeInteger(record.count) ||
    record.count < 0
  ) {
    throw new Error("Paperless paginated response is incompatible");
  }
  const totalPages = Math.ceil(record.count / perPage);
  return {
    items: record.results.slice(0, perPage).map(map),
    page,
    perPage,
    total: record.count,
    totalPages,
    hasNextPage: page < totalPages,
  };
}

export function collectionFor(
  kind: PaperlessOrganizerKind,
): Exclude<PaperlessCollection, "documents"> {
  return PAPERLESS_ORGANIZERS[kind];
}

export function positiveId(value: string | number, label = "Paperless identifier"): number {
  const normalized = typeof value === "number" ? String(value) : value.trim();
  if (!/^\d+$/.test(normalized)) throw new Error(`Invalid ${label}`);
  const id = Number(normalized);
  if (!Number.isSafeInteger(id) || id < 1) throw new Error(`Invalid ${label}`);
  return id;
}

export function normalizeName(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}
