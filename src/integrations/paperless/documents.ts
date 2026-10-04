import { NativeToolError } from "../../capabilities/execution.js";
import { PaperlessHttpError, type PaperlessClient } from "./client.js";
import type { PaperlessOrganizerService } from "./organizers.js";
import { asRecord, pageOf, positiveId, type PaperlessPage } from "./types.js";

const MAX_PAGE_SIZE = 100;
const MAX_SEARCH_BYTES = 4096;
const MAX_OCR_CHUNK_BYTES = 24 * 1024;
const MAX_CUSTOM_FIELDS = 30;
const MAX_CUSTOM_FIELD_VALUE_BYTES = 2048;
const ORDERING: Record<string, string> = {
  id: "id",
  title: "title",
  created: "created",
  added: "added",
  modified: "modified",
  correspondent: "correspondent__name",
  documentType: "document_type__name",
};

export type DocumentSearchInput = {
  searchMode?: "text" | "title_search" | "query";
  searchText?: string;
  dateFrom?: string;
  dateTo?: string;
  tags?: Array<string | number>;
  tagMatch?: "any" | "all";
  correspondent?: string | number;
  documentType?: string | number;
  page?: number;
  perPage?: number;
  orderBy?: keyof typeof ORDERING;
  orderDirection?: "asc" | "desc";
};

export type DocumentUpdateInput = {
  id: number;
  title?: string;
  created?: string;
  tags?: Array<string | number>;
  correspondent?: string | number | null;
  documentType?: string | number | null;
};

export type DocumentSummary = {
  id: number;
  title: string;
  created?: string;
  added?: string;
  modified?: string;
  correspondent?: { id: number; name?: string } | number | null;
  documentType?: { id: number; name?: string } | number | null;
  tags: Array<{ id: number; name?: string }>;
  highlight?: string;
  browserUrl?: string;
};

export class PaperlessDocumentService {
  constructor(
    private readonly client: PaperlessClient,
    private readonly organizers: PaperlessOrganizerService,
    private readonly publicUrl?: string,
  ) {}

  async search(
    input: DocumentSearchInput,
    signal?: AbortSignal,
  ): Promise<PaperlessPage<DocumentSummary>> {
    validateSearch(input);
    const page = positiveInt(input.page, 1);
    const perPage = Math.min(MAX_PAGE_SIZE, positiveInt(input.perPage, 25));
    const params: Record<string, string | number | undefined> = {
      page,
      page_size: perPage,
      ...(input.searchText?.trim()
        ? { [input.searchMode ?? "text"]: input.searchText.trim() }
        : {}),
      ...(input.dateFrom ? { created__gte: input.dateFrom } : {}),
      ...(input.dateTo ? { created__lte: input.dateTo } : {}),
      ...(input.orderBy
        ? { ordering: `${input.orderDirection === "desc" ? "-" : ""}${ORDERING[input.orderBy]}` }
        : {}),
    };
    if (input.tags?.length) {
      const ids: number[] = [];
      for (const reference of input.tags)
        ids.push((await this.organizers.resolve("tag", reference, signal)).id);
      params[input.tagMatch === "all" ? "tags__id__all" : "tags__id__in"] = ids.join(",");
    }
    if (input.correspondent !== undefined) {
      params["correspondent__id"] = (
        await this.organizers.resolve("correspondent", input.correspondent, signal)
      ).id;
    }
    if (input.documentType !== undefined) {
      params["document_type__id"] = (
        await this.organizers.resolve("document_type", input.documentType, signal)
      ).id;
    }
    const response = await this.client.list("documents", params, signal);
    const result = pageOf(response.body, toSummary, page, perPage);
    return {
      ...result,
      items: result.items.map((document) => ({
        ...document,
        ...(this.publicUrl ? { browserUrl: `${this.publicUrl}/documents/${document.id}` } : {}),
      })),
    };
  }

  async update(input: DocumentUpdateInput, signal?: AbortSignal): Promise<DocumentSummary> {
    positiveId(input.id, "document id");
    const patch: Record<string, unknown> = {};
    if (input.title !== undefined) {
      if (
        typeof input.title !== "string" ||
        !input.title.trim() ||
        input.title.trim().length > 512
      ) {
        throw new Error("Document title must be 1 to 512 characters");
      }
      patch.title = input.title.trim();
    }
    if (input.created !== undefined) {
      validateDate(input.created, "created");
      patch.created = input.created;
    }
    if (input.tags !== undefined) {
      if (!Array.isArray(input.tags) || input.tags.length > 20) {
        throw new Error("Document tags must contain at most 20 references");
      }
      const tags: number[] = [];
      for (const reference of input.tags)
        tags.push((await this.organizers.resolve("tag", reference, signal)).id);
      patch.tags = tags;
    }
    if (input.correspondent !== undefined) {
      patch.correspondent =
        input.correspondent === null
          ? null
          : (await this.organizers.resolve("correspondent", input.correspondent, signal)).id;
    }
    if (input.documentType !== undefined) {
      patch.document_type =
        input.documentType === null
          ? null
          : (await this.organizers.resolve("document_type", input.documentType, signal)).id;
    }
    if (Object.keys(patch).length === 0)
      throw new Error("At least one document field must be updated");
    try {
      await this.client.updateDocument(input.id, patch, signal);
    } catch (error) {
      if (error instanceof PaperlessHttpError && error.status < 500) throw error;
      throw new NativeToolError("Paperless update outcome is indeterminate", "indeterminate", {
        status: "indeterminate",
        documentId: input.id,
        stage: "update_submission",
      });
    }
    try {
      const verified = toSummary((await this.client.getDocument(input.id, undefined, signal)).body);
      verifyPatch(verified, patch);
      return {
        ...verified,
        ...(this.publicUrl ? { browserUrl: `${this.publicUrl}/documents/${input.id}` } : {}),
      };
    } catch {
      throw new NativeToolError("Paperless accepted an update but verification failed", "partial", {
        status: "partial",
        documentId: input.id,
        stage: "verification",
      });
    }
  }

  async get(
    id: number,
    options: { versionId?: number; offset?: number; maxBytes?: number } = {},
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    positiveId(id, "document id");
    if (options.versionId !== undefined) positiveId(options.versionId, "version id");
    const offset = nonnegativeInt(options.offset, 0);
    const maxBytes = options.maxBytes ?? MAX_OCR_CHUNK_BYTES;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_OCR_CHUNK_BYTES) {
      throw new Error(`OCR chunk must be between 1 and ${MAX_OCR_CHUNK_BYTES} bytes`);
    }
    const response = await this.client.getDocument(id, options.versionId, signal);
    const raw = asRecord(response.body);
    const summary = toSummary(raw);
    const content = typeof raw.content === "string" ? raw.content : "";
    const codepoints = Array.from(content);
    if (offset > codepoints.length) throw new Error("OCR offset exceeds document text length");
    let end = offset;
    let bytes = 0;
    while (end < codepoints.length) {
      const nextBytes = Buffer.byteLength(codepoints[end]!, "utf8");
      if (bytes + nextBytes > maxBytes) break;
      bytes += nextBytes;
      end += 1;
    }
    const customFields = Array.isArray(raw.custom_fields)
      ? raw.custom_fields.slice(0, MAX_CUSTOM_FIELDS).map(customField)
      : [];
    return {
      ...summary,
      ...(options.versionId === undefined ? {} : { versionId: options.versionId }),
      ...(this.publicUrl ? { browserUrl: `${this.publicUrl}/documents/${id}` } : {}),
      customFields,
      ocr: codepoints.slice(offset, end).join(""),
      hasOcr: content.length > 0,
      ...(end < codepoints.length ? { truncated: true, nextOffset: end } : { truncated: false }),
    };
  }
}

function verifyPatch(document: DocumentSummary, patch: Record<string, unknown>): void {
  if (patch.title !== undefined && document.title !== patch.title)
    throw new Error("Title did not match");
  if (patch.created !== undefined && document.created !== patch.created)
    throw new Error("Created date did not match");
  if (patch.tags !== undefined) {
    const actual = document.tags.map((tag) => tag.id).sort((left, right) => left - right);
    const expected = [...(patch.tags as number[])].sort((left, right) => left - right);
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      throw new Error("Tag assignments did not match");
  }
  if (
    patch.correspondent !== undefined &&
    relationId(document.correspondent) !== patch.correspondent
  ) {
    throw new Error("Correspondent assignment did not match");
  }
  if (
    patch.document_type !== undefined &&
    relationId(document.documentType) !== patch.document_type
  ) {
    throw new Error("Document type assignment did not match");
  }
}

function relationId(value: DocumentSummary["correspondent"]): number | null | undefined {
  if (value === null || typeof value === "number") return value;
  return value?.id;
}

function customField(value: unknown): Record<string, unknown> {
  const record = asRecord(value);
  const field = asRecord(record.field ?? record.custom_field);
  const id = typeof field.id === "number" ? field.id : undefined;
  const name = typeof field.name === "string" ? field.name.slice(0, 128) : undefined;
  const key = [
    "value",
    "value_text",
    "value_int",
    "value_float",
    "value_bool",
    "value_date",
    "value_url",
    "value_monetary",
    "value_select",
  ].find((candidate) => record[candidate] !== undefined);
  const fieldValue = key ? safeFieldValue(record[key], 0) : undefined;
  return {
    ...(id && Number.isSafeInteger(id) && id > 0 ? { id } : {}),
    ...(name ? { name } : {}),
    ...(fieldValue === undefined ? {} : { value: fieldValue }),
  };
}

function safeFieldValue(value: unknown, depth: number): unknown {
  if (depth > 2) return undefined;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    const bytes = Buffer.from(value, "utf8");
    return bytes.byteLength > MAX_CUSTOM_FIELD_VALUE_BYTES
      ? bytes.subarray(0, MAX_CUSTOM_FIELD_VALUE_BYTES).toString("utf8")
      : value;
  }
  if (Array.isArray(value))
    return value.slice(0, 20).map((entry) => safeFieldValue(entry, depth + 1));
  if (typeof value === "object") {
    if (depth >= 2) return undefined;
    const entries = Object.entries(value as Record<string, unknown>)
      .slice(0, 10)
      .filter(([key]) => /^[a-zA-Z0-9_-]{1,40}$/.test(key))
      .map(([key, entry]) => [key, safeFieldValue(entry, depth + 1)] as const)
      .filter(([, entry]) => entry !== undefined);
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
  }
  return undefined;
}

function validateSearch(input: DocumentSearchInput): void {
  if (
    input.searchMode !== undefined &&
    !["text", "title_search", "query"].includes(input.searchMode)
  ) {
    throw new Error("Invalid Paperless search mode");
  }
  if (input.searchText !== undefined) {
    if (typeof input.searchText !== "string" || !input.searchText.trim()) {
      throw new Error("Search text must not be empty");
    }
    if (Buffer.byteLength(input.searchText, "utf8") > MAX_SEARCH_BYTES) {
      throw new Error("Search text exceeds the Paperless query limit");
    }
  }
  if (input.searchMode && !input.searchText) throw new Error("Search mode requires search text");
  if (input.dateFrom) validateDate(input.dateFrom, "dateFrom");
  if (input.dateTo) validateDate(input.dateTo, "dateTo");
  if (input.dateFrom && input.dateTo && input.dateFrom > input.dateTo) {
    throw new Error("dateFrom must not be after dateTo");
  }
  if (input.tags && (input.tags.length > 20 || input.tags.length === 0)) {
    throw new Error("Provide between 1 and 20 tag filters");
  }
  if (input.orderBy && !(input.orderBy in ORDERING))
    throw new Error("Unsupported document ordering");
}

function toSummary(value: unknown): DocumentSummary {
  const record = asRecord(value);
  const id = positiveId(record.id as number, "document id");
  const title = typeof record.title === "string" ? record.title.slice(0, 512) : `Document ${id}`;
  const hit = asRecord(record.__search_hit__);
  const highlight =
    typeof hit.highlights === "string" ? plainText(hit.highlights).slice(0, 400) : undefined;
  const correspondent = related(record.correspondent);
  const documentType = related(record.document_type);
  const tags = Array.isArray(record.tags) ? record.tags.slice(0, 50).map(tagSummary) : [];
  const created = safeDate(record.created);
  const added = safeDate(record.added);
  const modified = safeDate(record.modified);
  return {
    id,
    title,
    ...(created ? { created } : {}),
    ...(added ? { added } : {}),
    ...(modified ? { modified } : {}),
    ...(correspondent !== undefined ? { correspondent } : {}),
    ...(documentType !== undefined ? { documentType } : {}),
    tags,
    ...(highlight ? { highlight } : {}),
  };
}

function related(value: unknown): DocumentSummary["correspondent"] | undefined {
  if (value === null) return null;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "number" || !Number.isSafeInteger(record.id) || record.id < 1)
    return undefined;
  return {
    id: record.id,
    ...(typeof record.name === "string" ? { name: record.name.slice(0, 256) } : {}),
  };
}

function tagSummary(value: unknown): { id: number; name?: string } {
  const record = asRecord(value);
  const id = positiveId(record.id as number, "tag id");
  return { id, ...(typeof record.name === "string" ? { name: record.name.slice(0, 256) } : {}) };
}

function plainText(value: string): string {
  return value
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, "&");
}

function safeDate(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= 64 ? value : undefined;
}

function validateDate(value: string, name: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`Invalid ${name}; use YYYY-MM-DD`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`Invalid ${name}; use a real calendar date`);
  }
}

function nonnegativeInt(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid Paperless text offset");
  return value;
}

function positiveInt(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error("Invalid Paperless pagination value");
  return value;
}
