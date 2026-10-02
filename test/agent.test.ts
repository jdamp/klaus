import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildContextEntries,
  type ExtensionContext,
  ModelRuntime,
  type SessionBeforeCompactEvent,
  type SessionEntry,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";

import { MCP_RESOURCE_HELPERS } from "../src/agent/extensions.js";
import {
  HOUSEHOLD_SYSTEM_PROMPT,
  attributionCompactionInstructions,
  extractFinalText,
  loadHouseholdSystemPrompt,
  PiSessionFactory,
  runAttributionCompaction,
  sdkResourceRoot,
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
  id: gpt-6-sol
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
  it("adds attribution requirements to manual and automatic compaction guidance", () => {
    const automatic = attributionCompactionInstructions();
    expect(automatic).toContain("immutable sender IDs");
    expect(automatic).toContain("unattributed legacy statements");
    const manual = attributionCompactionInstructions("Preserve project milestones.");
    expect(manual).toContain("Preserve project milestones.");
    expect(manual).toContain("tentative");
  });

  it("uses guided Pi compaction for manual, threshold, split-turn, and overflow events", async () => {
    const root = await mkdtemp(join(tmpdir(), "klaus-compaction-hook-"));
    const config = parseConfig(yaml(root));
    const runtime = await ModelRuntime.create({
      authPath: config.model.authPath,
      refreshOnCreate: false,
    });
    const model = runtime.getModel(config.model.provider, config.model.id);
    if (!model) throw new Error("Expected the configured model to be available");

    const prompts: string[] = [];
    const notify = vi.fn();
    const streamSimple = vi.fn((summaryModel: typeof model, transcript: unknown) => {
      prompts.push(JSON.stringify(transcript));
      const message: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "Summary retains sender IDs 101 and 202." }],
        api: summaryModel.api,
        provider: summaryModel.provider,
        model: summaryModel.id,
        usage: {
          input: 10,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 15,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      };
      return { result: async () => message } as AssistantMessageEventStream;
    });
    const context = {
      model,
      thinkingLevel: "off",
      modelRegistry: {
        streamSimple,
      },
      ui: { notify },
    } as unknown as ExtensionContext;
    const userMessage = (text: string) =>
      ({
        role: "user",
        content: [{ type: "text", text }],
        timestamp: Date.now(),
      }) as AgentMessage;
    const preparation = (splitTurn: boolean): SessionBeforeCompactEvent["preparation"] => ({
      firstKeptEntryId: "kept-entry",
      messagesToSummarize: [
        userMessage("Alice [sender_id=101] prefers the blue room."),
        userMessage("Bob [sender_id=202] tentatively prefers the green room."),
      ],
      turnPrefixMessages: splitTurn
        ? [userMessage("Bob [sender_id=202] asks to compare both rooms.")]
        : [],
      isSplitTurn: splitTurn,
      tokensBefore: 8_000,
      fileOps: { read: new Set(), written: new Set(), edited: new Set() },
      settings: { enabled: true, reserveTokens: 1_024, keepRecentTokens: 512 },
    });
    const event = (
      reason: SessionBeforeCompactEvent["reason"],
      splitTurn = false,
      customInstructions?: string,
    ): SessionBeforeCompactEvent => ({
      type: "session_before_compact",
      preparation: preparation(splitTurn),
      branchEntries: [],
      ...(customInstructions ? { customInstructions } : {}),
      reason,
      willRetry: reason === "overflow",
      signal: new AbortController().signal,
    });

    for (const [reason, splitTurn, customInstructions] of [
      ["manual", false, "Preserve project milestones."],
      ["threshold", false, undefined],
      ["threshold", true, undefined],
      ["overflow", false, undefined],
    ] as const) {
      const promptStart = prompts.length;
      const result = await runAttributionCompaction(
        event(reason, splitTurn, customInstructions),
        context,
      );
      expect(notify).not.toHaveBeenCalled();
      expect(result.cancel).not.toBe(true);
      expect(result.compaction?.summary).toContain("sender IDs 101 and 202");
      const summaryPrompts = prompts.slice(promptStart);
      expect(summaryPrompts.length).toBe(splitTurn ? 2 : 1);
      expect(summaryPrompts[0]).toContain("Preserve application-supplied immutable sender IDs");
      expect(summaryPrompts[0]).toContain("sender_id=101");
      expect(summaryPrompts[0]).toContain("sender_id=202");
      if (customInstructions) expect(summaryPrompts[0]).toContain(customInstructions);
      if (splitTurn) {
        expect(summaryPrompts[1]).toContain("sender_id=202");
        expect(result.compaction?.summary).toContain("Turn Context (split turn)");
      }
    }
    expect(streamSimple).toHaveBeenCalledTimes(5);
  });

  it("cancels compaction when the guided summary fails instead of falling back", async () => {
    const root = await mkdtemp(join(tmpdir(), "klaus-compaction-failure-"));
    const config = parseConfig(yaml(root));
    const runtime = await ModelRuntime.create({
      authPath: config.model.authPath,
      refreshOnCreate: false,
    });
    const model = runtime.getModel(config.model.provider, config.model.id);
    if (!model) throw new Error("Expected the configured model to be available");
    const notify = vi.fn();
    const context = {
      model,
      modelRegistry: {
        streamSimple: vi.fn(() => ({ result: async () => Promise.reject(new Error("offline")) })),
      },
      ui: { notify },
    } as unknown as ExtensionContext;
    const event: SessionBeforeCompactEvent = {
      type: "session_before_compact",
      preparation: {
        firstKeptEntryId: "kept-entry",
        messagesToSummarize: [
          {
            role: "user",
            content: [{ type: "text", text: "[sender_id=101] Keep the decision." }],
            timestamp: Date.now(),
          },
        ] as AgentMessage[],
        turnPrefixMessages: [],
        isSplitTurn: false,
        tokensBefore: 8_000,
        fileOps: { read: new Set(), written: new Set(), edited: new Set() },
        settings: { enabled: true, reserveTokens: 1_024, keepRecentTokens: 512 },
      },
      branchEntries: [],
      reason: "threshold",
      willRetry: false,
      signal: new AbortController().signal,
    };

    const result = await runAttributionCompaction(event, context);
    expect(result).toEqual({ cancel: true });
    expect(notify).toHaveBeenCalledWith(
      "Klaus compaction failed and was cancelled: offline",
      "error",
    );
  });

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
    expect(managed.session.extensionRunner.hasHandlers("session_before_compact")).toBe(true);
    expect(managed.session.systemPrompt).toContain(HOUSEHOLD_SYSTEM_PROMPT);
    expect(HOUSEHOLD_SYSTEM_PROMPT).toContain(
      "final text response is automatically delivered to the originating Telegram chat",
    );
    expect(HOUSEHOLD_SYSTEM_PROMPT).toContain(
      "Never claim an external action succeeded unless its tool result confirms success",
    );
    managed.persist();
    managed.session.setThinkingLevel("high");
    managed.persist();
    await managed.dispose();
    expect(entries.load("11111111-1111-4111-8111-111111111111").map((entry) => entry.type)).toEqual(
      ["model_change", "thinking_level_change", "thinking_level_change"],
    );
    const restored = await factory.create("11111111-1111-4111-8111-111111111111");
    expect(
      restored.session.sessionManager
        .getEntries()
        .slice(0, 2)
        .map((entry) => entry.type),
    ).toEqual(["model_change", "thinking_level_change"]);
    expect(restored.session.thinkingLevel).toBe("high");
    expect(restored.session.agent.state.tools).toEqual([]);
    await restored.dispose();
    database.close();
  });

  it("loads trusted Pi extensions and ignores ambient user and project MCP configs", async () => {
    const root = await mkdtemp(join(tmpdir(), "klaus-pi-isolation-"));
    const config = parseConfig(yaml(root));
    const resourceRoot = sdkResourceRoot(config);
    await mkdir(join(resourceRoot, ".pi"), { recursive: true });
    await mkdir(resourceRoot, { recursive: true });
    await writeFile(
      join(resourceRoot, "mcp.json"),
      JSON.stringify({ mcpServers: { ambient_user_server: { command: "/bin/false" } } }),
    );
    await writeFile(
      join(resourceRoot, ".pi", "mcp.json"),
      JSON.stringify({ mcpServers: { ambient_project_server: { command: "/bin/false" } } }),
    );
    const database = new AppDatabase(join(root, "data", "klaus.sqlite"));
    database.migrate();
    const runtime = await ModelRuntime.create({
      authPath: config.model.authPath,
      refreshOnCreate: false,
    });
    let managed: Awaited<ReturnType<PiSessionFactory["create"]>> | undefined;
    try {
      const factory = new PiSessionFactory(config, runtime, new SessionEntryRepository(database));
      managed = await factory.create("66666666-6666-4666-8666-666666666666");
      const registeredTools = managed.session.extensionRunner
        .getAllRegisteredTools()
        .map((tool) => tool.definition.name);
      expect(managed.session.extensionRunner.getExtensionPaths()).toContain("<inline:klaus-mcp>");
      expect(managed.session.extensionRunner.getExtensionPaths()).toContain(
        "<inline:klaus-tool-search>",
      );
      expect(registeredTools).toContain("tool_search");
      expect(registeredTools.some((name) => name.includes("ambient_user_server"))).toBe(false);
      expect(registeredTools.some((name) => name.includes("ambient_project_server"))).toBe(false);
      expect(managed.session.getActiveToolNames()).not.toContain("tool_search");
    } finally {
      await managed?.dispose();
      database.close();
    }
  });

  it("keeps native Klaus tools active, makes deferred MCP tools callable, and disables Pi coding tools", async () => {
    const root = await mkdtemp(join(tmpdir(), "klaus-pi-tools-"));
    const config = parseConfig(yaml(root));
    const runtime = await ModelRuntime.create({
      authPath: config.model.authPath,
      refreshOnCreate: false,
    });
    const database = new AppDatabase(":memory:");
    database.migrate();
    const nativeTool: ToolDefinition = {
      name: "klaus_echo",
      label: "Klaus echo",
      description: "Return the supplied text.",
      parameters: Type.Object({ text: Type.String() }),
      async execute(_id, params) {
        return {
          content: [{ type: "text", text: (params as { text: string }).text }],
          details: undefined,
        };
      },
    };
    const deferredMcpTool: ToolDefinition = {
      name: "home__get_state",
      label: "Get state",
      description: "Read a Home Assistant entity state.",
      parameters: Type.Object({ entity: Type.String() }),
      exposure: "deferred",
      async execute(_id, params) {
        return {
          content: [{ type: "text", text: (params as { entity: string }).entity }],
          details: undefined,
        };
      },
    };
    const factory = new PiSessionFactory(config, runtime, new SessionEntryRepository(database), [
      nativeTool,
      deferredMcpTool,
    ]);
    const managed = await factory.create("77777777-7777-4777-8777-777777777777");
    const active = managed.session.getActiveToolNames();
    const callable = managed.session.getCallableToolNames();
    expect(active).toContain("klaus_echo");
    expect(active).toContain("tool_search");
    expect(active).not.toContain("home__get_state");
    expect(callable).toContain("klaus_echo");
    expect(callable).toContain("home__get_state");
    for (const forbidden of [
      "bash",
      "read",
      "write",
      "edit",
      "find",
      "grep",
      "ls",
      "codemode",
      ...MCP_RESOURCE_HELPERS,
    ]) {
      expect(active).not.toContain(forbidden);
      expect(callable).not.toContain(forbidden);
    }
    await managed.dispose();
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
    expect(managed.session.systemPrompt).toContain(customPrompt);
    expect(managed.session.systemPrompt).not.toContain(
      "You are a private household assistant responding in a Telegram chat.",
    );
    await managed.dispose();
    database.close();
  });

  it("restores Pi 0.85 session history and continues across a database restart without replaying tools", async () => {
    const root = await mkdtemp(join(tmpdir(), "klaus-legacy-session-"));
    const databasePath = join(root, "klaus.sqlite");
    const sessionId = "55555555-5555-4555-8555-555555555555";
    const fixture = JSON.parse(
      await readFile(new URL("./fixtures/pi-0.85-session-entries.json", import.meta.url), "utf8"),
    ) as SessionEntry[];
    let legacyToolExecutions = 0;
    const legacyTool: ToolDefinition = {
      name: "home__light",
      label: "Kitchen light",
      description: "Switch the kitchen light.",
      parameters: Type.Object({ on: Type.Boolean() }),
      async execute() {
        legacyToolExecutions += 1;
        return { content: [{ type: "text", text: "Unexpected replay" }], details: undefined };
      },
    };
    const mockTextResponse = (runtime: ModelRuntime, text: string) => {
      vi.spyOn(runtime, "streamSimple").mockImplementation((model) => {
        const message: AssistantMessage = {
          role: "assistant",
          content: [{ type: "text", text }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: Date.now(),
        };
        const start: AssistantMessage = { ...message, content: [], stopReason: "pending" };
        const textStart: AssistantMessage = {
          ...start,
          content: [{ type: "text", text: "" }],
        };
        const textPartial: AssistantMessage = {
          ...start,
          content: [{ type: "text", text }],
        };
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => {
          stream.push({ type: "start", partial: start });
          stream.push({ type: "text_start", contentIndex: 0, partial: textStart });
          stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: textPartial });
          stream.push({ type: "text_end", contentIndex: 0, content: text, partial: textPartial });
          stream.push({ type: "done", reason: "stop", message });
        });
        return stream;
      });
    };
    const config = parseConfig(
      yaml(root)
        .replace("provider: openai-codex", "provider: anthropic")
        .replace("id: gpt-6-sol", "id: claude-opus-4-5"),
    );

    const firstDatabase = new AppDatabase(databasePath);
    firstDatabase.migrate();
    const firstEntries = new SessionEntryRepository(firstDatabase);
    firstEntries.replace(sessionId, fixture);
    const firstRuntime = await ModelRuntime.create({
      authPath: config.model.authPath,
      modelsStorePath: join(root, "auth", "models-store.json"),
      refreshOnCreate: false,
    });
    await firstRuntime.setRuntimeApiKey("anthropic", "fixture-key");
    mockTextResponse(firstRuntime, "The restored conversation is available.");
    const firstFactory = new PiSessionFactory(config, firstRuntime, firstEntries, [legacyTool]);
    const first = await firstFactory.create(sessionId);

    expect(first.session.model?.id).toBe("claude-opus-4-5");
    expect(first.session.thinkingLevel).toBe("high");
    expect(
      first.session.messages.some(
        (message) =>
          message.role === "user" &&
          Array.isArray(message.content) &&
          message.content.some((part) => part.type === "image"),
      ),
    ).toBe(true);
    expect(
      first.session.messages.some(
        (message) =>
          message.role === "assistant" &&
          message.content.some((part) => part.type === "toolCall" && part.name === "home__light"),
      ),
    ).toBe(true);
    expect(
      first.session.messages.some(
        (message) => message.role === "toolResult" && message.toolName === "home__light",
      ),
    ).toBe(true);
    await first.session.prompt("Continue from the restored history.");
    expect(extractFinalText(first.session.messages)).toBe(
      "The restored conversation is available.",
    );
    first.persist();
    await first.dispose();
    firstDatabase.close();

    const secondDatabase = new AppDatabase(databasePath);
    secondDatabase.migrate();
    const secondEntries = new SessionEntryRepository(secondDatabase);
    const secondRuntime = await ModelRuntime.create({
      authPath: config.model.authPath,
      modelsStorePath: join(root, "auth", "models-store.json"),
      refreshOnCreate: false,
    });
    await secondRuntime.setRuntimeApiKey("anthropic", "fixture-key");
    mockTextResponse(secondRuntime, "The new turn survived restart.");
    const secondFactory = new PiSessionFactory(config, secondRuntime, secondEntries, [legacyTool]);
    const restored = await secondFactory.create(sessionId);
    expect(restored.session.model?.id).toBe("claude-opus-4-5");
    expect(restored.session.thinkingLevel).toBe("high");
    expect(extractFinalText(restored.session.messages)).toBe(
      "The restored conversation is available.",
    );
    expect(
      restored.session.messages.some(
        (message) =>
          message.role === "user" &&
          Array.isArray(message.content) &&
          message.content.some((part) => part.type === "image"),
      ),
    ).toBe(true);
    await restored.session.prompt("Add another note after restarting.");
    expect(extractFinalText(restored.session.messages)).toBe("The new turn survived restart.");
    expect(legacyToolExecutions).toBe(0);
    restored.persist();
    await restored.dispose();
    secondDatabase.close();
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
        .replace("id: gpt-6-sol", `id: ${fallback.id}`),
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
    await first.dispose();
    const restored = await factory.create(sessionId, {
      provider: preferred.provider,
      modelId: preferred.id,
    });
    expect(restored.session.model?.id).toBe(preferred.id);
    await restored.dispose();
    const unavailable = await factory.create("33333333-3333-4333-8333-333333333333", {
      provider: "anthropic",
      modelId: "missing-model",
    });
    expect(unavailable.session.model?.id).toBe(fallback.id);
    await unavailable.dispose();
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
    await registry.dispose();
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
    await registry.dispose();
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
