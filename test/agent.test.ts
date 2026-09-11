import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildContextEntries,
  ModelRuntime,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { PiSessionFactory } from "../src/agent/pi-runtime.js";
import { SessionRegistry } from "../src/agent/session-registry.js";
import { parseConfig } from "../src/config.js";
import { AppDatabase } from "../src/persistence/database.js";
import { SessionEntryRepository } from "../src/persistence/repositories.js";

function yaml(root: string, skills = "[]"): string {
  return `
telegram:
  tokenFile: ${root}/telegram
  allowedUsers: ["1"]
  allowedChats: ["1"]
model:
  provider: openai-codex
  id: gpt-5.4
  authPath: ${root}/auth/auth.json
data:
  directory: ${root}/data
mcp: []
skills:
  paths: ${skills}
health: {}
`;
}

describe("Pi runtime adapter", () => {
  it("creates sessions with zero built-in coding tools and persists restored entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "klaus-pi-"));
    const config = parseConfig(yaml(root));
    const runtime = await ModelRuntime.create({
      authPath: config.model.authPath,
      refreshOnCreate: false,
    });
    const database = new AppDatabase(":memory:");
    database.migrate();
    const entries = new SessionEntryRepository(database);
    const factory = new PiSessionFactory(config, runtime, entries);
    const managed = await factory.create("11111111-1111-4111-8111-111111111111");
    expect(managed.session.agent.state.tools).toEqual([]);
    managed.persist();
    managed.dispose();
    expect(entries.load("11111111-1111-4111-8111-111111111111").map((entry) => entry.type)).toEqual(
      ["model_change", "thinking_level_change"],
    );
    const restored = await factory.create("11111111-1111-4111-8111-111111111111");
    expect(
      restored.session.sessionManager
        .getEntries()
        .slice(0, 2)
        .map((entry) => entry.type),
    ).toEqual(["model_change", "thinking_level_change"]);
    expect(restored.session.agent.state.tools).toEqual([]);
    restored.dispose();
    database.close();
  });

  it("isolates and evicts cached chat sessions", async () => {
    const disposed: string[] = [];
    const aborted: string[] = [];
    const factory = {
      async create(id: string) {
        return {
          session: {} as never,
          abort: async () => {
            aborted.push(id);
          },
          persist() {},
          dispose() {
            disposed.push(id);
          },
        };
      },
    };
    const registry = new SessionRegistry(factory, 1);
    const one = await registry.get("one");
    expect(await registry.get("one")).toBe(one);
    await registry.get("two");
    await registry.abortAll();
    expect(aborted).toEqual(["two"]);
    expect(disposed).toEqual(["one"]);
    registry.dispose();
    expect(disposed).toEqual(["one", "two"]);
  });

  it("uses Pi compaction entries to bound old context while retaining a structured tool tail", () => {
    const entries = [
      {
        type: "custom",
        customType: "old",
        id: "old",
        parentId: null,
        timestamp: new Date(0).toISOString(),
      },
      {
        type: "compaction",
        id: "summary",
        parentId: "old",
        timestamp: new Date(1).toISOString(),
        summary: "Older household conversation summary",
        firstKeptEntryId: "call",
        tokensBefore: 100_000,
      },
      {
        type: "message",
        id: "call",
        parentId: "summary",
        timestamp: new Date(2).toISOString(),
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "tc", name: "home__light", arguments: { on: true } }],
          api: "openai-codex-responses",
          provider: "openai-codex",
          model: "gpt",
          usage: {},
          stopReason: "toolUse",
          timestamp: 2,
        },
      },
      {
        type: "message",
        id: "result",
        parentId: "call",
        timestamp: new Date(3).toISOString(),
        message: {
          role: "toolResult",
          toolCallId: "tc",
          toolName: "home__light",
          content: [{ type: "text", text: "ok" }],
          isError: false,
          timestamp: 3,
        },
      },
    ] as unknown as SessionEntry[];

    expect(buildContextEntries(entries).map((entry) => entry.id)).toEqual([
      "summary",
      "call",
      "result",
    ]);
  });

  it("loads only configured read-only skills and reports invalid skill diagnostics", async () => {
    const root = await mkdtemp(join(tmpdir(), "klaus-skills-"));
    const skills = join(root, "skills");
    await mkdir(join(skills, "valid"), { recursive: true });
    await writeFile(
      join(skills, "valid", "SKILL.md"),
      "---\nname: lights\ndescription: Control lights\n---\nUse the enabled light tool.",
    );
    await mkdir(join(skills, "invalid"), { recursive: true });
    await writeFile(join(skills, "invalid", "SKILL.md"), "missing frontmatter");
    const config = parseConfig(yaml(root, `[${skills}]`));
    const runtime = await ModelRuntime.create({
      authPath: config.model.authPath,
      refreshOnCreate: false,
    });
    const database = new AppDatabase(":memory:");
    database.migrate();
    const factory = new PiSessionFactory(config, runtime, new SessionEntryRepository(database));
    expect((await factory.skillDiagnostics()).length).toBeGreaterThan(0);
    database.close();
  });
});
