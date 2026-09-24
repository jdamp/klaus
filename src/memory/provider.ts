import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";

import type { ComponentHealth } from "../app/lifecycle.js";
import type { CapabilityBinding, CapabilityProvider } from "../capabilities/types.js";
import type { ToolAuditRepository } from "../persistence/repositories.js";
import type { SecretRedactor } from "../security/secrets.js";
import type { MemoryTurnContextRegistry } from "./context.js";
import type { MemoryRepository } from "./repository.js";

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Tool arguments must be an object");
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Invalid ${name}`);
  return value;
}

function optionalString(value: unknown, name: string): string | undefined {
  return value === undefined ? undefined : stringValue(value, name);
}

function optionalInteger(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`Invalid ${name}`);
  return value;
}

function optionalStrings(value: unknown, name: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`Invalid ${name}`);
  }
  return value as string[];
}

const listParameters = {
  type: "object",
  additionalProperties: false,
  properties: {
    tag: { type: "string", minLength: 1 },
    page: { type: "integer", minimum: 1 },
    limit: { type: "integer", minimum: 1, maximum: 100 },
  },
};

const readParameters = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: { id: { type: "string", minLength: 1 } },
};

const searchParameters = {
  type: "object",
  additionalProperties: false,
  required: ["query"],
  properties: {
    query: { type: "string", minLength: 1 },
    tag: { type: "string", minLength: 1 },
    limit: { type: "integer", minimum: 1, maximum: 100 },
  },
};

const saveParameters = {
  type: "object",
  additionalProperties: false,
  required: ["title", "body"],
  properties: {
    id: { type: "string", minLength: 1 },
    expectedRevision: { type: "integer", minimum: 1 },
    title: { type: "string", minLength: 1 },
    body: { type: "string" },
    tags: { type: "array", items: { type: "string" }, maxItems: 100 },
    sourceDescription: { type: "string", maxLength: 512 },
  },
};

const deleteParameters = {
  type: "object",
  additionalProperties: false,
  required: ["id", "expectedRevision"],
  properties: {
    id: { type: "string", minLength: 1 },
    expectedRevision: { type: "integer", minimum: 1 },
  },
};

export class MemoryProvider implements CapabilityProvider {
  readonly id = "memory";

  constructor(
    private readonly repository: MemoryRepository,
    private readonly contexts: MemoryTurnContextRegistry,
    private readonly audits: ToolAuditRepository,
    private readonly redactor: SecretRedactor,
  ) {}

  start(): Promise<void> {
    this.repository.validateExisting();
    this.repository.rebuildSearchIndex();
    return Promise.resolve();
  }

  stop(): Promise<void> {
    return Promise.resolve();
  }

  health(): Record<string, ComponentHealth> {
    try {
      if (!this.repository.read("overview")) throw new Error("Overview is missing");
      return { notebook: { status: "healthy" } };
    } catch (error) {
      return {
        notebook: {
          status: "unhealthy",
          detail: error instanceof Error ? error.message : "Notebook unavailable",
        },
      };
    }
  }

  tools(binding?: CapabilityBinding): readonly ToolDefinition[] {
    const sessionId = binding?.sessionId;
    if (!sessionId) return [];
    return [
      this.#tool(
        sessionId,
        "memory_list",
        "Browse shared memory notes. Use this when search wording is uncertain.",
        listParameters,
        (value) => {
          const object = objectValue(value);
          const tag = optionalString(object.tag, "tag");
          const page = optionalInteger(object.page, "page");
          const limit = optionalInteger(object.limit, "limit");
          return this.repository.list({
            ...(tag ? { tag } : {}),
            ...(page !== undefined ? { page } : {}),
            ...(limit !== undefined ? { limit } : {}),
          });
        },
      ),
      this.#tool(
        sessionId,
        "memory_read",
        "Read one shared memory note completely by stable ID before revising or citing it.",
        readParameters,
        (value) => {
          const id = stringValue(objectValue(value).id, "id").trim();
          const note = this.repository.read(id);
          return note ?? { ok: false, error: "not_found", id };
        },
      ),
      this.#tool(
        sessionId,
        "memory_search",
        "Search current shared note titles, tags, and bodies. An empty match does not prove no relevant note exists; browse or try alternatives.",
        searchParameters,
        (value) => {
          const object = objectValue(value);
          const tag = optionalString(object.tag, "tag");
          const limit = optionalInteger(object.limit, "limit");
          return this.repository.search({
            query: stringValue(object.query, "query"),
            ...(tag ? { tag } : {}),
            ...(limit !== undefined ? { limit } : {}),
          });
        },
      ),
      this.#tool(
        sessionId,
        "memory_save",
        "Create a coherent shared note, or replace a fully read note using its ID and expected revision.",
        saveParameters,
        (value, toolCallId) => {
          const object = objectValue(value);
          const context = this.contexts.require(sessionId);
          const sanitized = this.redactor.redact({
            id: optionalString(object.id, "id")?.trim(),
            expectedRevision: optionalInteger(object.expectedRevision, "expectedRevision"),
            title: stringValue(object.title, "title"),
            body: typeof object.body === "string" ? object.body : stringValue(object.body, "body"),
            tags: optionalStrings(object.tags, "tags"),
            sourceDescription: optionalString(object.sourceDescription, "sourceDescription"),
          }) as {
            id?: string;
            expectedRevision?: number;
            title: string;
            body: string;
            tags?: string[];
            sourceDescription?: string;
          };
          return this.repository.save(
            sanitized,
            {
              senderId: context.senderId,
              updateId: context.updateId,
              ...(context.senderLabel ? { description: context.senderLabel } : {}),
            },
            toolCallId,
          );
        },
      ),
      this.#tool(
        sessionId,
        "memory_delete",
        "Revision-check and delete an ordinary note, or clear the reserved overview. This is logical notebook deletion, not historical erasure.",
        deleteParameters,
        (value, toolCallId) => {
          const object = objectValue(value);
          const context = this.contexts.require(sessionId);
          return this.repository.delete(
            stringValue(object.id, "id").trim(),
            optionalInteger(object.expectedRevision, "expectedRevision") ?? 0,
            { senderId: context.senderId, updateId: context.updateId },
            toolCallId,
          );
        },
      ),
    ];
  }

  #tool(
    sessionId: string,
    name: string,
    description: string,
    parameters: Record<string, unknown>,
    execute: (value: unknown, toolCallId: string) => unknown,
  ): ToolDefinition {
    return defineTool({
      name,
      label: name,
      description,
      parameters,
      execute: async (toolCallId, params) => {
        const context = this.contexts.require(sessionId);
        const auditId = this.audits.start(
          this.id,
          name,
          { noteId: objectValue(params).id },
          context.updateId,
        );
        try {
          const result = await Promise.resolve(execute(params, toolCallId));
          const summary =
            result && typeof result === "object"
              ? {
                  ok: (result as { ok?: unknown }).ok,
                  operation: (result as { operation?: unknown }).operation,
                  id: (result as { id?: unknown }).id,
                  error: (result as { error?: unknown }).error,
                }
              : { ok: true };
          this.audits.finish(auditId, "success", summary);
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            details: { provider: this.id, outcome: "success" },
          };
        } catch (error) {
          this.audits.finish(auditId, "failure", {
            error: error instanceof Error ? error.message : "Memory tool failed",
          });
          throw error;
        }
      },
    });
  }
}
