import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import { nativeTool, type NativeToolExecutor } from "../../../capabilities/execution.js";
import type { OrganizerService } from "./service.js";
import type { OrganizerKind } from "../types.js";

const kind = { type: "string", enum: ["category", "tag"] };

export function organizerTools(
  service: OrganizerService,
  executor: NativeToolExecutor,
): ToolDefinition[] {
  return [
    nativeTool({
      executor,
      name: "mealie_list_organizers",
      description: "List or search Mealie categories or tags.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["kind"],
        properties: {
          kind,
          search: { type: "string" },
          page: { type: "integer", minimum: 1 },
          perPage: { type: "integer", minimum: 1, maximum: 100 },
        },
      },
      parse: (value) => {
        const object = objectValue(value);
        return {
          kind: kindValue(object.kind),
          ...(object.search === undefined ? {} : { search: stringValue(object.search, "search") }),
          page: numberValue(object.page, 1),
          perPage: numberValue(object.perPage, 25),
        };
      },
      execute: (args, signal) =>
        service.list(args.kind, args.search, args.page, args.perPage, signal),
    }),
    nativeTool({
      executor,
      name: "mealie_create_organizer",
      description: "Create a Mealie category or tag without deleting anything.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "name"],
        properties: { kind, name: { type: "string", minLength: 1, maxLength: 200 } },
      },
      parse: (value) => {
        const object = objectValue(value);
        return { kind: kindValue(object.kind), name: stringValue(object.name, "name") };
      },
      execute: (args, signal) => service.create(args.kind, args.name, signal),
    }),
    nativeTool({
      executor,
      name: "mealie_rename_organizer",
      description: "Rename a Mealie category or tag by stable id.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "id", "name"],
        properties: {
          kind,
          id: { type: "string", minLength: 1 },
          name: { type: "string", minLength: 1, maxLength: 200 },
        },
      },
      parse: (value) => {
        const object = objectValue(value);
        return {
          kind: kindValue(object.kind),
          id: stringValue(object.id, "id"),
          name: stringValue(object.name, "name"),
        };
      },
      execute: (args, signal) => service.rename(args.kind, args.id, args.name, signal),
    }),
    nativeTool({
      executor,
      name: "mealie_set_recipe_organizers",
      description:
        "Replace or clear category and tag assignments on a Mealie recipe. Omitted collections remain unchanged.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["slug"],
        properties: {
          slug: { type: "string", minLength: 1 },
          categories: { type: "array", maxItems: 50, items: { type: "string", minLength: 1 } },
          tags: { type: "array", maxItems: 50, items: { type: "string", minLength: 1 } },
        },
      },
      parse: (value) => {
        const object = objectValue(value);
        return {
          slug: stringValue(object.slug, "slug"),
          ...(object.categories === undefined
            ? {}
            : { categories: stringArray(object.categories, "categories") }),
          ...(object.tags === undefined ? {} : { tags: stringArray(object.tags, "tags") }),
        };
      },
      execute: (args, signal) => service.assign(args.slug, args.categories, args.tags, signal),
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
function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim()))
    throw new Error(`Invalid ${name}`);
  return value.map((entry) => (entry as string).trim());
}
function kindValue(value: unknown): OrganizerKind {
  if (value !== "category" && value !== "tag") throw new Error("kind must be category or tag");
  return value;
}
function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}
