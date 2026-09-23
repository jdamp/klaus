import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionFactory,
  type ResourceDiagnostic,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import type { AppConfig } from "../config.js";
import type { SessionEntryRepository } from "../persistence/repositories.js";
import {
  ATTRIBUTION_COMPACTION_GUIDANCE,
  memoryTurnSystemPrompt,
  type MemoryTurnContextRegistry,
} from "../memory/context.js";

export type ManagedSession = {
  session: AgentSession;
  abort(): Promise<void>;
  persist(): void;
  dispose(): void;
};

export const HOUSEHOLD_SYSTEM_PROMPT = [
  "You are a private household assistant responding in a Telegram chat.",
  "Your final text response is automatically delivered to the originating Telegram chat, so answer the user directly and do not claim that you cannot send the current reply.",
  "You cannot proactively message another chat unless an enabled tool explicitly supports it.",
  "Use only supplied tools.",
  "Never claim an external action succeeded unless its tool result confirms success.",
].join(" ");

export function attributionCompactionInstructions(prior?: string): string {
  return [prior, ATTRIBUTION_COMPACTION_GUIDANCE].filter(Boolean).join("\n\n");
}

export async function loadHouseholdSystemPrompt(config: AppConfig): Promise<string> {
  if (!config.agent.systemPromptFile) return HOUSEHOLD_SYSTEM_PROMPT;

  let prompt: string;
  try {
    prompt = await readFile(config.agent.systemPromptFile, "utf8");
  } catch (error) {
    throw new Error(
      `Unable to read household system prompt file: ${config.agent.systemPromptFile}`,
      {
        cause: error,
      },
    );
  }
  if (!prompt.trim()) {
    throw new Error(`Household system prompt file is empty: ${config.agent.systemPromptFile}`);
  }
  return prompt;
}

export async function createModelRuntime(config: AppConfig["model"]): Promise<ModelRuntime> {
  await mkdir(dirname(config.authPath), { recursive: true, mode: 0o700 });
  return ModelRuntime.create({
    authPath: config.authPath,
    ...(config.modelsPath ? { modelsPath: config.modelsPath } : {}),
    modelsStorePath: resolve(dirname(config.authPath), "models-store.json"),
  });
}

export async function providerReady(runtime: ModelRuntime, provider: string): Promise<boolean> {
  return Boolean(await runtime.checkAuth(provider, { signal: AbortSignal.timeout(10_000) }));
}

export class PiSessionFactory {
  constructor(
    private readonly config: AppConfig,
    private readonly runtime: ModelRuntime,
    private readonly entries: SessionEntryRepository,
    private readonly customTools:
      readonly ToolDefinition[] | ((sessionId: string) => readonly ToolDefinition[]) = [],
    private readonly systemPrompt = HOUSEHOLD_SYSTEM_PROMPT,
    private readonly memoryContexts?: MemoryTurnContextRegistry,
  ) {}

  async create(
    sessionId: string,
    preferredModel?: { provider: string; modelId: string },
  ): Promise<ManagedSession> {
    const fallbackModel = this.runtime.getModel(this.config.model.provider, this.config.model.id);
    if (!fallbackModel) {
      throw new Error(
        `Unknown configured model: ${this.config.model.provider}/${this.config.model.id}`,
      );
    }
    let model = fallbackModel;
    if (preferredModel) {
      try {
        const preferred = (await this.runtime.getAvailable(preferredModel.provider)).find(
          (candidate) => candidate.id === preferredModel.modelId,
        );
        if (preferred) model = preferred;
      } catch {
        // A retained preference is non-destructive; use the configured fallback while unavailable.
      }
    }

    const memoryExtension: ExtensionFactory | undefined = this.memoryContexts
      ? (pi) => {
          pi.on("before_agent_start", (event) => ({
            systemPrompt: memoryTurnSystemPrompt(
              event.systemPrompt,
              this.memoryContexts!.require(sessionId),
            ),
          }));
        }
      : undefined;
    const resourceLoader = new DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir: dirname(this.config.model.authPath),
      additionalSkillPaths: this.config.skills.paths,
      noExtensions: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: this.systemPrompt,
      ...(memoryExtension
        ? {
            extensionFactories: [
              { name: "klaus-memory-context", hidden: true, factory: memoryExtension },
            ],
          }
        : {}),
      skillsOverride: (base) => ({
        skills: base.skills.filter((skill) =>
          this.config.skills.paths.some((path) => skill.filePath.startsWith(resolve(path))),
        ),
        diagnostics: base.diagnostics,
      }),
    });
    await resourceLoader.reload();

    const storedEntries = this.entries.load(sessionId);
    const storedModel = [...storedEntries].reverse().find((entry) => entry.type === "model_change");
    const storedThinking = [...storedEntries]
      .reverse()
      .find((entry) => entry.type === "thinking_level_change");
    const modelConfigurationMatches =
      storedModel?.type === "model_change" &&
      storedModel.provider === model.provider &&
      storedModel.modelId === model.id;
    const storedThinkingLevel: ThinkingLevel | undefined =
      storedThinking?.type === "thinking_level_change"
        ? (storedThinking.thinkingLevel as ThinkingLevel)
        : undefined;
    // Preserve a user-selected level when a managed session is recreated, including before its first turn.
    const initialThinkingLevel =
      modelConfigurationMatches && storedThinkingLevel !== undefined
        ? storedThinkingLevel === this.config.model.reasoning
          ? undefined
          : storedThinkingLevel
        : this.config.model.reasoning;
    const sessionManager = SessionManager.inMemory(process.cwd(), { id: sessionId }, storedEntries);
    const settingsManager = SettingsManager.inMemory({
      compaction: {
        enabled: true,
        reserveTokens: Math.max(2_048, Math.floor(this.config.model.contextTokens * 0.1)),
        keepRecentTokens: Math.max(2_048, Math.floor(this.config.model.contextTokens * 0.25)),
      },
      retry: {
        enabled: this.config.model.retryLimit > 0,
        maxRetries: this.config.model.retryLimit,
      },
      defaultTools: [],
    });

    const customTools =
      typeof this.customTools === "function" ? this.customTools(sessionId) : this.customTools;
    const { session } = await createAgentSession({
      modelRuntime: this.runtime,
      model,
      ...(initialThinkingLevel !== undefined ? { thinkingLevel: initialThinkingLevel } : {}),
      resourceLoader,
      sessionManager,
      settingsManager,
      noTools: "all",
      tools: customTools.map((tool) => tool.name),
      customTools: [...customTools],
    });

    // Pi 0.85 exposes one shared default compaction path for manual, threshold,
    // and overflow compaction. Decorate it so every built-in summary receives
    // the same attribution requirement; explicit manual instructions are retained.
    const compactable = session as unknown as {
      _runDefaultCompaction: (...argumentsValue: unknown[]) => Promise<unknown>;
    };
    if (typeof compactable._runDefaultCompaction === "function") {
      const original = compactable._runDefaultCompaction.bind(session);
      compactable._runDefaultCompaction = (...argumentsValue: unknown[]) => {
        const prior = typeof argumentsValue[4] === "string" ? argumentsValue[4] : undefined;
        argumentsValue[4] = attributionCompactionInstructions(prior);
        return original(...argumentsValue);
      };
    }

    return {
      session,
      abort: () => session.abort(),
      persist: () => this.entries.replace(sessionId, session.sessionManager.getEntries()),
      dispose: () => session.dispose(),
    };
  }

  async skillDiagnostics(): Promise<ResourceDiagnostic[]> {
    const loader = new DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir: dirname(this.config.model.authPath),
      additionalSkillPaths: this.config.skills.paths,
      noExtensions: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      skillsOverride: (base) => ({
        skills: base.skills.filter((skill) =>
          this.config.skills.paths.some((path) => skill.filePath.startsWith(resolve(path))),
        ),
        diagnostics: base.diagnostics,
      }),
    });
    await loader.reload();
    return loader.getSkills().diagnostics;
  }
}

export async function authFileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

export function extractFinalText(messages: AgentSession["messages"]): string {
  const assistant = [...messages].reverse().find((message) => message.role === "assistant");
  if (!assistant || !("content" in assistant) || !Array.isArray(assistant.content)) return "";
  return assistant.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("");
}
