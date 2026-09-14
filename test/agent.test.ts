import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildContextEntries,
  ModelRuntime,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import {
  HOUSEHOLD_SYSTEM_PROMPT,
  loadHouseholdSystemPrompt,
  PiSessionFactory,
} from "../src/agent/pi-runtime.js";
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
    expect(managed.session.agent.state.systemPrompt).toContain(HOUSEHOLD_SYSTEM_PROMPT);
    expect(HOUSEHOLD_SYSTEM_PROMPT).toContain(
      "final text response is automatically delivered to the originating Telegram chat",
    );
    expect(HOUSEHOLD_SYSTEM_PROMPT).toContain(
      "Never claim an external action succeeded unless its tool result confirms success",
    );
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

  it("replaces the built-in prompt with an explicitly configured prompt file", async () => {
    const root = await mkdtemp(join(tmpdir(), "klaus-prompt-"));
    const promptPath = join(root, "AGENTS.md");
    const customPrompt = "You are the carefully configured household assistant.";
    await writeFile(promptPath, customPrompt);
    const config = parseConfig(
      yaml(root).replace("data:", `agent:\n  systemPromptFile: ${promptPath}\ndata:`),
    );
    const loadedPrompt = await loadHouseholdSystemPrompt(config);
    expect(loadedPrompt).toBe(customPrompt);

    const runtime = await ModelRuntime.create({
      authPath: config.model.authPath,
      refreshOnCreate: false,
    });
    const database = new AppDatabase(":memory:");
    database.migrate();
    const factory = new PiSessionFactory(
      config,
      runtime,
      new SessionEntryRepository(database),
      [],
      loadedPrompt,
    );
    const managed = await factory.create("44444444-4444-4444-8444-444444444444");
    expect(managed.session.agent.state.systemPrompt).toContain(customPrompt);
    expect(managed.session.agent.state.systemPrompt).not.toContain(
      "You are a private household assistant responding in a Telegram chat.",
    );
    managed.dispose();
    database.close();
  });

  it("rejects missing and empty configured prompt files", async () => {
    const root = await mkdtemp(join(tmpdir(), "klaus-prompt-invalid-"));
    const missing = parseConfig(
      yaml(root).replace("data:", `agent:\n  systemPromptFile: ${join(root, "missing.md")}\ndata:`),
    );
    await expect(loadHouseholdSystemPrompt(missing)).rejects.toThrow("missing.md");

    const directory = parseConfig(
      yaml(root).replace("data:", `agent:\n  systemPromptFile: ${root}\ndata:`),
    );
    await expect(loadHouseholdSystemPrompt(directory)).rejects.toThrow(root);

    const emptyPath = join(root, "empty.md");
    await writeFile(emptyPath, " \n\t");
    const empty = parseConfig(
      yaml(root).replace("data:", `agent:\n  systemPromptFile: ${emptyPath}\ndata:`),
    );
    await expect(loadHouseholdSystemPrompt(empty)).rejects.toThrow("empty.md");
  });

  it("uses an available preferred model for new and restored sessions", async () => {
    const root = await mkdtemp(join(tmpdir(), "klaus-preferred-model-"));
    const runtime = await ModelRuntime.create({
      authPath: join(root, "auth", "auth.json"),
      modelsStorePath: join(root, "auth", "models-store.json"),
      refreshOnCreate: false,
    });
    await runtime.setRuntimeApiKey("anthropic", "test-key");
    const available = await runtime.getAvailable("anthropic");
    const fallback = available[0];
    const preferred = available[1];
    if (!fallback || !preferred) throw new Error("Expected at least two built-in Anthropic models");
    const config = parseConfig(
      yaml(root)
        .replace("provider: openai-codex", "provider: anthropic")
        .replace("id: gpt-5.4", `id: ${fallback.id}`),
    );
    const database = new AppDatabase(":memory:");
    database.migrate();
    const factory = new PiSessionFactory(config, runtime, new SessionEntryRepository(database));
    const sessionId = "22222222-2222-4222-8222-222222222222";
    const first = await factory.create(sessionId, {
      provider: preferred.provider,
      modelId: preferred.id,
    });
    expect(first.session.model?.id).toBe(preferred.id);
    first.persist();
    first.dispose();
    const restored = await factory.create(sessionId, {
      provider: preferred.provider,
      modelId: preferred.id,
    });
    expect(restored.session.model?.id).toBe(preferred.id);
    restored.dispose();
    const unavailable = await factory.create("33333333-3333-4333-8333-333333333333", {
      provider: "anthropic",
      modelId: "missing-model",
    });
    expect(unavailable.session.model?.id).toBe(fallback.id);
    unavailable.dispose();
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

  it("forwards model preferences and targets only active cached sessions for user abort", async () => {
    const created: Array<{ id: string; preferred?: { provider: string; modelId: string } }> = [];
    let idle = false;
    let aborted = 0;
    const factory = {
      async create(id: string, preferred?: { provider: string; modelId: string }) {
        created.push({ id, ...(preferred ? { preferred } : {}) });
        return {
          session: {
            get isIdle() {
              return idle;
            },
          } as never,
          abort: async () => {
            aborted += 1;
            idle = true;
          },
          persist() {},
          dispose() {},
        };
      },
    };
    const registry = new SessionRegistry(factory);
    await registry.get("one", { provider: "backend", modelId: "selected" });

    expect(created).toEqual([
      { id: "one", preferred: { provider: "backend", modelId: "selected" } },
    ]);
    expect(await registry.abortForUser("missing")).toBe(false);
    expect(await registry.abortForUser("one")).toBe(true);
    expect(aborted).toBe(1);
    expect(registry.consumeUserCancellation("one")).toBe(true);
    expect(registry.consumeUserCancellation("one")).toBe(false);
    registry.dispose();
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
