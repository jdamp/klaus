import { randomUUID } from "node:crypto";

import type { AppConfig } from "../config.js";
import type { AppDatabase } from "../persistence/database.js";

export const OVERVIEW_ID = "overview";

export type MemoryLimits = AppConfig["memory"];

export type MemorySource = {
  senderId: string;
  updateId: string;
  description?: string;
};

export type MemoryNote = {
  id: string;
  title: string;
  body: string;
  tags: string[];
  revision: number;
  createdAt: string;
  updatedAt: string;
  source: {
    senderId?: string;
    updateId?: string;
    description?: string;
  };
};

export type MemoryMutationResult =
  | {
      ok: true;
      operation: "created" | "updated" | "deleted" | "cleared";
      id: string;
      revision?: number;
      overviewRevision?: number;
    }
  | {
      ok: false;
      error: "not_found" | "conflict" | "invalid" | "overview_limit";
      id?: string;
      currentRevision?: number;
      message: string;
    };

type MemoryRow = {
  id: string;
  title: string;
  body: string;
  tags_json: string;
  revision: number;
  created_at: string;
  updated_at: string;
  source_sender_id: string | null;
  source_update_id: string | null;
  source_description: string | null;
};

export type MemoryListItem = Pick<
  MemoryNote,
  "id" | "title" | "revision" | "createdAt" | "updatedAt"
> & {
  preview: string;
};

export type MemorySearchItem = Pick<MemoryNote, "id" | "title" | "revision" | "updatedAt"> & {
  snippet: string;
};

function bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function utf8Prefix(value: string, maximum: number): string {
  let result = "";
  for (const character of value) {
    if (bytes(result + character) > maximum) break;
    result += character;
  }
  return result;
}

function parseTags(serialized: string): string[] {
  const value: unknown = JSON.parse(serialized);
  if (!Array.isArray(value) || value.some((tag) => typeof tag !== "string")) {
    throw new Error("Stored memory tags are invalid");
  }
  return value as string[];
}

function noteFromRow(row: MemoryRow): MemoryNote {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    tags: parseTags(row.tags_json),
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    source: {
      ...(row.source_sender_id ? { senderId: row.source_sender_id } : {}),
      ...(row.source_update_id ? { updateId: row.source_update_id } : {}),
      ...(row.source_description ? { description: row.source_description } : {}),
    },
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function boundedJson<T>(items: T[], maximumBytes: number): T[] {
  const result: T[] = [];
  for (const item of items) {
    if (bytes(JSON.stringify([...result, item])) > maximumBytes) break;
    result.push(item);
  }
  return result;
}

export class MemoryRepository {
  constructor(
    private readonly database: AppDatabase,
    readonly limits: MemoryLimits,
  ) {}

  validateExisting(): void {
    const rows = this.database.connection
      .prepare(
        `SELECT id,title,body,tags_json,revision,created_at,updated_at,
                source_sender_id,source_update_id,source_description
         FROM memory_notes`,
      )
      .all() as MemoryRow[];
    for (const row of rows) {
      const note = noteFromRow(row);
      const invalid = this.#validationError(note.title, note.body, note.tags, note.id);
      if (invalid) {
        throw new Error(
          `Configured memory limits are incompatible with stored note ${note.id}: ${invalid.message}`,
        );
      }
    }
  }

  rebuildSearchIndex(): void {
    this.database.connection.exec("BEGIN IMMEDIATE");
    try {
      this.database.connection.exec("DELETE FROM memory_notes_fts");
      this.database.connection.exec(
        `INSERT INTO memory_notes_fts(id,title,tags,body)
         SELECT id,title,tags_json,body FROM memory_notes`,
      );
      this.database.connection.exec("COMMIT");
    } catch (error) {
      this.database.connection.exec("ROLLBACK");
      throw error;
    }
  }

  read(id: string): MemoryNote | undefined {
    const row = this.database.connection
      .prepare(
        `SELECT id,title,body,tags_json,revision,created_at,updated_at,
                source_sender_id,source_update_id,source_description
         FROM memory_notes WHERE id=?`,
      )
      .get(id) as MemoryRow | undefined;
    return row ? noteFromRow(row) : undefined;
  }

  list(options: { page?: number; tag?: string; limit?: number } = {}): {
    items: MemoryListItem[];
    page: number;
    nextPage?: number;
  } {
    const page = options.page ?? 1;
    const requestedLimit = Math.min(
      options.limit ?? this.limits.maxResults,
      this.limits.maxResults,
    );
    const boundedPageSize = Math.max(
      1,
      Math.floor(
        this.limits.listSearchMaxBytes /
          (this.limits.titleMaxBytes + this.limits.previewMaxBytes + 512),
      ),
    );
    const limit = Math.min(requestedLimit, boundedPageSize);
    if (!Number.isInteger(page) || page < 1)
      throw new Error("Memory page must be a positive integer");
    if (!Number.isInteger(limit) || limit < 1) throw new Error("Memory limit must be positive");
    const offset = (page - 1) * limit;
    const params: Array<string | number> = [];
    let where = "";
    if (options.tag) {
      where = "WHERE EXISTS (SELECT 1 FROM json_each(memory_notes.tags_json) WHERE value = ?)";
      params.push(options.tag);
    }
    params.push(limit + 1, offset);
    const rows = this.database.connection
      .prepare(
        `SELECT id,title,body,tags_json,revision,created_at,updated_at,
                source_sender_id,source_update_id,source_description
         FROM memory_notes
         ${where}
         ORDER BY CASE WHEN id='overview' THEN 0 ELSE 1 END, updated_at DESC, id
         LIMIT ? OFFSET ?`,
      )
      .all(...params) as MemoryRow[];
    const hasMore = rows.length > limit;
    const candidates = rows.slice(0, limit).map((row) => {
      const note = noteFromRow(row);
      const preview = utf8Prefix(
        note.body.replace(/\s+/g, " ").trim(),
        this.limits.previewMaxBytes,
      );
      return {
        id: note.id,
        title: note.title,
        revision: note.revision,
        createdAt: note.createdAt,
        updatedAt: note.updatedAt,
        preview,
      };
    });
    const items = boundedJson(candidates, this.limits.listSearchMaxBytes);
    return {
      items,
      page,
      ...(hasMore || items.length < candidates.length ? { nextPage: page + 1 } : {}),
    };
  }

  search(options: { query: string; tag?: string; limit?: number }): {
    items: MemorySearchItem[];
    limited: boolean;
  } {
    const limit = Math.min(options.limit ?? this.limits.maxResults, this.limits.maxResults);
    if (!Number.isInteger(limit) || limit < 1) throw new Error("Memory limit must be positive");
    const terms = options.query.match(/[\p{L}\p{N}_]+/gu) ?? [];
    if (terms.length === 0) return { items: [], limited: false };
    const query = terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" AND ");
    const params: Array<string | number> = [query];
    let tagClause = "";
    if (options.tag) {
      tagClause = "AND EXISTS (SELECT 1 FROM json_each(n.tags_json) WHERE value = ?)";
      params.push(options.tag);
    }
    params.push(limit + 1);
    const rows = this.database.connection
      .prepare(
        `SELECT n.id,n.title,n.revision,n.updated_at,
                snippet(memory_notes_fts,3,'[',']','…',24) AS snippet,
                bm25(memory_notes_fts,0.0,5.0,2.0,1.0) AS rank
         FROM memory_notes_fts
         JOIN memory_notes n ON n.id=memory_notes_fts.id
         WHERE memory_notes_fts MATCH ? ${tagClause}
         ORDER BY rank, CASE WHEN n.id='overview' THEN 0 ELSE 1 END, n.id
         LIMIT ?`,
      )
      .all(...params) as Array<{
      id: string;
      title: string;
      revision: number;
      updated_at: string;
      snippet: string;
      rank: number;
    }>;
    const hasMore = rows.length > limit;
    const candidates = rows.slice(0, limit).map((row) => ({
      id: row.id,
      title: row.title,
      snippet: row.snippet,
      revision: row.revision,
      updatedAt: row.updated_at,
    }));
    const items = boundedJson(candidates, this.limits.listSearchMaxBytes);
    return { items, limited: hasMore || items.length < candidates.length };
  }

  save(
    input: {
      id?: string;
      expectedRevision?: number;
      title: string;
      body: string;
      tags?: string[];
      sourceDescription?: string;
    },
    source: MemorySource,
    toolCallId: string,
  ): MemoryMutationResult {
    const id = input.id ?? randomUUID();
    const tags = [...new Set((input.tags ?? []).map((tag) => tag.trim()))];
    const validation = this.#validationError(input.title.trim(), input.body, tags, id);
    if (validation) return validation;
    if (input.id && (!Number.isInteger(input.expectedRevision) || input.expectedRevision! < 1)) {
      return {
        ok: false,
        error: "invalid",
        id,
        message: "expectedRevision is required for an update",
      };
    }
    if (!input.id && input.expectedRevision !== undefined) {
      return {
        ok: false,
        error: "invalid",
        id,
        message: "expectedRevision is only valid when updating an existing note",
      };
    }
    const description = input.sourceDescription?.trim().slice(0, 512);
    this.database.connection.exec("BEGIN IMMEDIATE");
    try {
      const prior = this.#receipt(source.updateId, toolCallId);
      if (prior) {
        this.database.connection.exec("COMMIT");
        return prior;
      }
      const now = new Date().toISOString();
      let result: MemoryMutationResult;
      if (!input.id) {
        this.database.connection
          .prepare(
            `INSERT INTO memory_notes(
              id,title,body,tags_json,revision,created_at,updated_at,
              source_sender_id,source_update_id,source_description
            ) VALUES (?,?,?,?,1,?,?,?,?,?)`,
          )
          .run(
            id,
            input.title.trim(),
            input.body,
            JSON.stringify(tags),
            now,
            now,
            source.senderId,
            source.updateId,
            description ?? null,
          );
        result = { ok: true, operation: "created", id, revision: 1 };
      } else {
        const changed = this.database.connection
          .prepare(
            `UPDATE memory_notes SET
              title=?,body=?,tags_json=?,revision=revision+1,updated_at=?,
              source_sender_id=?,source_update_id=?,source_description=?
             WHERE id=? AND revision=?`,
          )
          .run(
            input.title.trim(),
            input.body,
            JSON.stringify(tags),
            now,
            source.senderId,
            source.updateId,
            description ?? null,
            id,
            input.expectedRevision!,
          );
        if (changed.changes === 1) {
          result = {
            ok: true,
            operation: "updated",
            id,
            revision: input.expectedRevision! + 1,
          };
        } else {
          result = this.#missingOrConflict(id);
        }
      }
      this.#storeReceipt(source.updateId, toolCallId, "save", id, result);
      this.database.connection.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.connection.exec("ROLLBACK");
      throw error;
    }
  }

  delete(
    id: string,
    expectedRevision: number,
    source: MemorySource,
    toolCallId: string,
  ): MemoryMutationResult {
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
      return { ok: false, error: "invalid", id, message: "expectedRevision must be positive" };
    }
    this.database.connection.exec("BEGIN IMMEDIATE");
    try {
      const prior = this.#receipt(source.updateId, toolCallId);
      if (prior) {
        this.database.connection.exec("COMMIT");
        return prior;
      }
      const now = new Date().toISOString();
      let result: MemoryMutationResult;
      if (id === OVERVIEW_ID) {
        const changed = this.database.connection
          .prepare(
            `UPDATE memory_notes SET body='',revision=revision+1,updated_at=?,
              source_sender_id=?,source_update_id=?,source_description='overview cleared'
             WHERE id=? AND revision=?`,
          )
          .run(now, source.senderId, source.updateId, OVERVIEW_ID, expectedRevision);
        result =
          changed.changes === 1
            ? {
                ok: true,
                operation: "cleared",
                id,
                revision: expectedRevision + 1,
                overviewRevision: expectedRevision + 1,
              }
            : this.#missingOrConflict(id);
      } else {
        const changed = this.database.connection
          .prepare("DELETE FROM memory_notes WHERE id=? AND revision=?")
          .run(id, expectedRevision);
        if (changed.changes !== 1) {
          result = this.#missingOrConflict(id);
        } else {
          const overview = this.read(OVERVIEW_ID);
          let overviewRevision: number | undefined;
          if (overview) {
            const link = new RegExp(`\\[[^\\]]*\\]\\(memory:${escapeRegExp(id)}\\)`, "g");
            const body = overview.body.replace(link, "").replace(/\n{3,}/g, "\n\n");
            if (body !== overview.body) {
              this.database.connection
                .prepare(
                  `UPDATE memory_notes SET body=?,revision=revision+1,updated_at=?,
                    source_sender_id=?,source_update_id=?,source_description='removed deleted note link'
                   WHERE id='overview'`,
                )
                .run(body, now, source.senderId, source.updateId);
              overviewRevision = overview.revision + 1;
            }
          }
          result = {
            ok: true,
            operation: "deleted",
            id,
            ...(overviewRevision ? { overviewRevision } : {}),
          };
        }
      }
      this.#storeReceipt(source.updateId, toolCallId, "delete", id, result);
      this.database.connection.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.connection.exec("ROLLBACK");
      throw error;
    }
  }

  #validationError(
    title: string,
    body: string,
    tags: string[],
    id: string,
  ): Extract<MemoryMutationResult, { ok: false }> | undefined {
    if (!title) return { ok: false, error: "invalid", id, message: "title is required" };
    if (id === OVERVIEW_ID && title !== "Overview") {
      return {
        ok: false,
        error: "invalid",
        id,
        message: "the reserved overview title must remain Overview",
      };
    }
    if (bytes(title) > this.limits.titleMaxBytes) {
      return { ok: false, error: "invalid", id, message: "title exceeds titleMaxBytes" };
    }
    if (tags.length > this.limits.maxTags) {
      return { ok: false, error: "invalid", id, message: "too many tags" };
    }
    if (tags.some((tag) => !tag || bytes(tag) > this.limits.tagMaxBytes)) {
      return { ok: false, error: "invalid", id, message: "a tag is empty or too large" };
    }
    if (id === OVERVIEW_ID && bytes(body) > this.limits.overviewMaxBytes) {
      return {
        ok: false,
        error: "overview_limit",
        id,
        message: "overview exceeds overviewMaxBytes",
      };
    }
    const representative: MemoryNote = {
      id,
      title,
      body,
      tags,
      revision: 9_999_999,
      createdAt: "9999-12-31T23:59:59.999Z",
      updatedAt: "9999-12-31T23:59:59.999Z",
      source: {
        senderId: "9".repeat(32),
        updateId: "9".repeat(32),
        description: "x".repeat(512),
      },
    };
    if (bytes(JSON.stringify(representative)) > this.limits.readMaxBytes) {
      return {
        ok: false,
        error: "invalid",
        id,
        message: "note cannot fit the configured complete read response",
      };
    }
    return undefined;
  }

  #missingOrConflict(id: string): MemoryMutationResult {
    const row = this.database.connection
      .prepare("SELECT revision FROM memory_notes WHERE id=?")
      .get(id) as { revision: number } | undefined;
    return row
      ? {
          ok: false,
          error: "conflict",
          id,
          currentRevision: row.revision,
          message: "revision conflict; read the current note before retrying",
        }
      : { ok: false, error: "not_found", id, message: "memory note not found" };
  }

  #receipt(updateId: string, toolCallId: string): MemoryMutationResult | undefined {
    const row = this.database.connection
      .prepare("SELECT outcome_json FROM memory_mutations WHERE update_id=? AND tool_call_id=?")
      .get(updateId, toolCallId) as { outcome_json: string } | undefined;
    return row ? (JSON.parse(row.outcome_json) as MemoryMutationResult) : undefined;
  }

  #storeReceipt(
    updateId: string,
    toolCallId: string,
    operation: "save" | "delete",
    targetId: string,
    result: MemoryMutationResult,
  ): void {
    this.database.connection
      .prepare(
        `INSERT INTO memory_mutations(
          update_id,tool_call_id,operation,target_id,outcome_json,created_at
        ) VALUES (?,?,?,?,?,?)`,
      )
      .run(
        updateId,
        toolCallId,
        operation,
        targetId,
        JSON.stringify(result),
        new Date().toISOString(),
      );
  }
}
