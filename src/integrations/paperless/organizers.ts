import { NativeToolError } from "../../capabilities/execution.js";
import { PaperlessHttpError, type PaperlessClient } from "./client.js";
import {
  collectionFor,
  normalizeName,
  organizer,
  pageOf,
  positiveId,
  type PaperlessOrganizer,
  type PaperlessOrganizerKind,
  type PaperlessPage,
} from "./types.js";

const MAX_PAGE_SIZE = 100;
const MAX_RESOLVE_PAGES = 10;
const MAX_CANDIDATES = 5;

export class PaperlessOrganizerService {
  constructor(private readonly client: PaperlessClient) {}

  async list(
    kind: PaperlessOrganizerKind,
    options: { query?: string; page?: number; perPage?: number },
    signal?: AbortSignal,
  ): Promise<PaperlessPage<PaperlessOrganizer>> {
    const page = positiveInt(options.page, 1);
    const perPage = Math.min(MAX_PAGE_SIZE, positiveInt(options.perPage, 25));
    const response = await this.client.list(
      collectionFor(kind),
      {
        page,
        page_size: perPage,
        ...(options.query?.trim() ? { name__icontains: options.query.trim() } : {}),
      },
      signal,
    );
    return pageOf(response.body, organizer, page, perPage);
  }

  async resolve(
    kind: PaperlessOrganizerKind,
    reference: string | number,
    signal?: AbortSignal,
  ): Promise<PaperlessOrganizer> {
    const collection = collectionFor(kind);
    if (typeof reference === "number") {
      const id = positiveId(reference, `${kind} id`);
      try {
        return organizer((await this.client.getOrganizer(collection, id, signal)).body);
      } catch (error) {
        if (error instanceof PaperlessHttpError && error.status === 404) {
          throw new NotFoundError(`Paperless ${kind} was not found`);
        }
        throw error;
      }
    }
    if (typeof reference !== "string" || !reference.trim() || reference.length > 256) {
      throw new Error(`Invalid Paperless ${kind} reference`);
    }
    if (/^\d+$/.test(reference.trim())) {
      const id = positiveId(reference, `${kind} id`);
      try {
        return organizer((await this.client.getOrganizer(collection, id, signal)).body);
      } catch (error) {
        if (error instanceof PaperlessHttpError && error.status === 404) {
          throw new NotFoundError(`Paperless ${kind} was not found`);
        }
        throw error;
      }
    }
    return this.#resolveName(kind, reference.trim(), signal);
  }

  async #resolveName(
    kind: PaperlessOrganizerKind,
    name: string,
    signal?: AbortSignal,
  ): Promise<PaperlessOrganizer> {
    const first = await this.list(kind, { query: name, page: 1, perPage: MAX_PAGE_SIZE }, signal);
    let matches = first.items.filter((item) => normalizeName(item.name) === normalizeName(name));
    const pages = Math.min(first.totalPages ?? 1, MAX_RESOLVE_PAGES);
    for (let page = 2; page <= pages; page += 1) {
      const next = await this.list(kind, { query: name, page, perPage: MAX_PAGE_SIZE }, signal);
      matches = matches.concat(
        next.items.filter((item) => normalizeName(item.name) === normalizeName(name)),
      );
      if (matches.length > 1) break;
    }
    if ((first.totalPages ?? 1) > MAX_RESOLVE_PAGES && matches.length <= 1) {
      throw new Error(`Paperless ${kind} lookup exceeded its bounded page limit; use a numeric id`);
    }
    if (matches.length === 0)
      throw new NotFoundError(`Paperless ${kind} was not found by exact name`);
    if (matches.length > 1) {
      throw new Error(
        `Paperless ${kind} name is ambiguous: ${matches
          .slice(0, MAX_CANDIDATES)
          .map(({ id }) => id)
          .join(", ")}`,
      );
    }
    return matches[0]!;
  }

  async create(
    kind: PaperlessOrganizerKind,
    name: string,
    signal?: AbortSignal,
  ): Promise<PaperlessOrganizer> {
    const normalized = validateName(name);
    try {
      const existing = await this.#resolveName(kind, normalized, signal);
      if (existing) return existing;
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
    }
    let created: PaperlessOrganizer;
    try {
      created = organizer(
        (await this.client.createOrganizer(collectionFor(kind), normalized, signal)).body,
      );
    } catch (error) {
      if (error instanceof PaperlessHttpError && error.status < 500) throw error;
      throw new NativeToolError(
        `Paperless ${kind} creation outcome is indeterminate`,
        "indeterminate",
        {
          status: "indeterminate",
          kind,
          name: normalized,
          stage: "creation_submission",
        },
      );
    }
    try {
      const verified = organizer(
        (await this.client.getOrganizer(collectionFor(kind), created.id, signal)).body,
      );
      if (
        verified.id !== created.id ||
        normalizeName(verified.name) !== normalizeName(normalized)
      ) {
        throw new Error("Organizer state did not match");
      }
      return verified;
    } catch {
      throw new NativeToolError(
        `Paperless ${kind} was created but verification failed`,
        "partial",
        {
          status: "partial",
          kind,
          id: created.id,
          stage: "creation_verification",
        },
      );
    }
  }

  async rename(
    kind: PaperlessOrganizerKind,
    reference: string | number,
    name: string,
    signal?: AbortSignal,
  ): Promise<PaperlessOrganizer> {
    const current = await this.resolve(kind, reference, signal);
    const normalized = validateName(name);
    let renamed: PaperlessOrganizer;
    try {
      renamed = organizer(
        (await this.client.renameOrganizer(collectionFor(kind), current.id, normalized, signal))
          .body,
      );
    } catch (error) {
      if (error instanceof PaperlessHttpError && error.status < 500) throw error;
      throw new NativeToolError(
        `Paperless ${kind} rename outcome is indeterminate`,
        "indeterminate",
        {
          status: "indeterminate",
          kind,
          id: current.id,
          stage: "rename_submission",
        },
      );
    }
    try {
      if (renamed.id !== current.id || normalizeName(renamed.name) !== normalizeName(normalized)) {
        throw new Error("Organizer state did not match");
      }
      const verified = organizer(
        (await this.client.getOrganizer(collectionFor(kind), current.id, signal)).body,
      );
      if (normalizeName(verified.name) !== normalizeName(normalized)) {
        throw new Error("Organizer state did not match");
      }
      return verified;
    } catch {
      throw new NativeToolError(
        `Paperless ${kind} was renamed but verification failed`,
        "partial",
        {
          status: "partial",
          kind,
          id: current.id,
          stage: "rename_verification",
        },
      );
    }
  }
}

class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
  }
}

function validateName(value: string): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 128) {
    throw new Error("Organizer name must be 1 to 128 characters");
  }
  return value.trim();
}

function positiveInt(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("Invalid Paperless page number");
  return value;
}
