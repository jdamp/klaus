import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ResourceDiagnostic,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import type { AppConfig } from "../config.js";
import type { SessionEntryRepository } from "../persistence/repositories.js";

export type ManagedSession = {
  session: AgentSession;
  abort(): Promise<void>;
  persist(): void;
  dispose(): void;
};

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
    private readonly customTools: readonly ToolDefinition[] = [],
  ) {}

  async create(sessionId: string): Promise<ManagedSession> {
    const model = this.runtime.getModel(this.config.model.provider, this.config.model.id);
    if (!model) {
      throw new Error(
        `Unknown configured model: ${this.config.model.provider}/${this.config.model.id}`,
      );
    }

    const resourceLoader = new DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir: dirname(this.config.model.authPath),
      additionalSkillPaths: this.config.skills.paths,
      noExtensions: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt:
        "You are a private household assistant. Use only supplied tools. Never claim an action succeeded unless its tool result confirms success.",
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
    const configurationAlreadyRecorded =
      storedModel?.type === "model_change" &&
      storedModel.provider === this.config.model.provider &&
      storedModel.modelId === this.config.model.id &&
      storedThinking?.type === "thinking_level_change" &&
      storedThinking.thinkingLevel === this.config.model.reasoning;
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

    const { session } = await createAgentSession({
      modelRuntime: this.runtime,
      ...(!configurationAlreadyRecorded
        ? { model, thinkingLevel: this.config.model.reasoning }
        : {}),
      resourceLoader,
      sessionManager,
      settingsManager,
      noTools: "all",
      tools: this.customTools.map((tool) => tool.name),
      customTools: [...this.customTools],
    });

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
