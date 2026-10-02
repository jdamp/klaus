import { unlink } from "node:fs/promises";
import { resolve } from "node:path";

import {
  createMcpExtension,
  type ExtensionFactory,
  type LoadedMcpConfig,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  isJsonRpcRequest,
  isJsonRpcResponse,
  StdioTransport,
  StreamableHttpTransport,
  type JsonRpcId,
  type JsonRpcMessage,
  type McpTransport,
  type McpTransportMessageListener,
} from "@earendil-works/pi-mcp";

import type { AppConfig, McpServerConfig } from "../config.js";
import type { ComponentHealth } from "../app/lifecycle.js";
import type { ToolAuditRepository, ToolOutcome } from "../persistence/repositories.js";
import { readSecret, type SecretRedactor } from "../security/secrets.js";
import { hideMcpResourceHelpers } from "../agent/extensions.js";

type ServerPolicy = AppConfig["mcp"][number];

export class PiMcpHealthRegistry {
  readonly #sessions = new Map<string, Map<string, ComponentHealth>>();
  readonly #closedSessions = new Set<string>();

  beginSession(sessionId: string): void {
    this.#closedSessions.delete(sessionId);
  }

  set(
    sessionId: string,
    serverId: string,
    status: ComponentHealth["status"],
    detail?: string,
  ): void {
    if (this.#closedSessions.has(sessionId)) return;
    let session = this.#sessions.get(sessionId);
    if (!session) {
      session = new Map();
      this.#sessions.set(sessionId, session);
    }
    session.set(serverId, { status, ...(detail ? { detail } : {}) });
  }

  clearSession(sessionId: string): void {
    this.#closedSessions.add(sessionId);
    this.#sessions.delete(sessionId);
  }

  snapshot(serverIds: readonly string[]): Record<string, ComponentHealth> {
    const result: Record<string, ComponentHealth> = {};
    for (const serverId of serverIds) {
      const states = [...this.#sessions.values()]
        .map((session) => session.get(serverId))
        .filter((state): state is ComponentHealth => state !== undefined);
      const healthy = states.some((state) => state.status === "healthy");
      const degraded = states.find((state) => state.status !== "healthy");
      result[`mcp.${serverId}`] = healthy
        ? { status: "healthy" }
        : (degraded ?? {
            status: "degraded",
            detail: "No active Pi MCP session has checked this configured server.",
          });
    }
    return result;
  }
}

export class PiMcpConnectionRegistry {
  readonly #sessions = new Map<string, Set<McpTransport>>();

  add(sessionId: string, transport: McpTransport): void {
    let session = this.#sessions.get(sessionId);
    if (!session) {
      session = new Set();
      this.#sessions.set(sessionId, session);
    }
    session.add(transport);
  }

  async closeSession(sessionId: string): Promise<void> {
    const transports = this.#sessions.get(sessionId);
    this.#sessions.delete(sessionId);
    if (transports) await Promise.allSettled([...transports].map((transport) => transport.close()));
  }
}

function piExposure(config: ServerPolicy): "direct" | "deferred" | "hidden" {
  return config.tools === undefined ? config.exposure : "hidden";
}

function piToolExposure(config: ServerPolicy): Record<string, "direct" | "deferred"> | undefined {
  if (config.tools === undefined || config.tools.length === 0) return undefined;
  return Object.fromEntries(config.tools.map((tool) => [tool, config.exposure]));
}

export async function loadPiMcpConfig(
  configs: readonly McpServerConfig[],
  redactor: SecretRedactor,
): Promise<LoadedMcpConfig> {
  const servers: LoadedMcpConfig["servers"] = [];
  const errors: string[] = [];
  for (const config of configs) {
    try {
      const toolExposure = piToolExposure(config);
      const base = {
        exposure: piExposure(config),
        timeout: config.timeoutMs / 1_000,
        ...(toolExposure ? { toolExposure } : {}),
      };
      if ("url" in config) {
        const token = config.tokenFile ? await readSecret(config.tokenFile) : undefined;
        redactor.add(token);
        servers.push({
          name: config.id,
          source: "klaus-config",
          scope: "extension",
          config: {
            type: "http",
            url: config.url,
            ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
            ...base,
          },
        });
      } else {
        const secretEnv = Object.fromEntries(
          await Promise.all(
            Object.entries(config.secretEnv).map(async ([name, path]) => {
              const secret = await readSecret(path);
              redactor.add(secret);
              return [name, secret] as const;
            }),
          ),
        );
        servers.push({
          name: config.id,
          source: "klaus-config",
          scope: "extension",
          config: {
            type: "stdio",
            command: config.command,
            args: config.args,
            env: { ...config.env, ...secretEnv },
            ...base,
          },
        });
      }
    } catch {
      errors.push(`MCP server "${config.id}" could not load its configured secret file.`);
    }
  }
  return { servers, errors, autoEnableCodemode: false };
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && ((bytes[end] ?? 0) & 0b1100_0000) === 0b1000_0000) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

function safeContentBlock(block: unknown, redactor: SecretRedactor): unknown {
  const redacted = redactor.redact(block);
  if (!redacted || typeof redacted !== "object" || Array.isArray(redacted)) return redacted;
  const value = redacted as Record<string, unknown>;
  if (value.type !== "resource" || !value.resource || typeof value.resource !== "object") {
    return redacted;
  }
  const resource = value.resource as Record<string, unknown>;
  const mimeType = typeof resource.mimeType === "string" ? resource.mimeType : "";
  if (typeof resource.blob === "string" && !mimeType.startsWith("image/")) {
    const textMime = /^(text\/|application\/json|application\/[^;]+\+json)/i.test(mimeType);
    if (!textMime) {
      return { type: "text", text: "[Non-text MCP resource omitted by the result safety limit]" };
    }
  }
  return redacted;
}

function boundCallToolResult(value: unknown, maxBytes: number, redactor: SecretRedactor): unknown {
  const redacted = redactor.redact(value);
  if (!redacted || typeof redacted !== "object" || Array.isArray(redacted)) return redacted;
  const result = redacted as Record<string, unknown>;
  if (!Array.isArray(result.content)) return redacted;
  const bounded: Record<string, unknown> = {
    content: result.content.map((block) => safeContentBlock(block, redactor)),
    ...(result.isError === true ? { isError: true } : {}),
  };
  if (result.structuredContent !== undefined) bounded.structuredContent = result.structuredContent;
  if (serializedBytes(bounded) <= maxBytes) return bounded;

  delete bounded.structuredContent;
  const content = bounded.content as unknown[];
  while (serializedBytes(bounded) > maxBytes && content.length > 0) {
    const last = content[content.length - 1];
    if (last && typeof last === "object" && !Array.isArray(last) && "text" in last) {
      if (typeof last.text !== "string") {
        content.pop();
        continue;
      }
      const text = last.text;
      const currentBytes = serializedBytes(bounded);
      const allowance = Math.max(0, maxBytes - (currentBytes - Buffer.byteLength(text, "utf8")));
      const shortened = truncateUtf8(text, allowance);
      if (shortened && shortened !== text) {
        last.text = shortened;
      } else {
        content.pop();
      }
    } else {
      content.pop();
    }
  }
  return bounded;
}

async function safeToolResult(
  value: unknown,
  maxBytes: number,
  redactor: SecretRedactor,
): Promise<unknown> {
  const redacted = redactor.redact(value);
  if (!redacted || typeof redacted !== "object" || Array.isArray(redacted)) return redacted;
  const result = redacted as Record<string, unknown>;
  const details = result.details;
  if (details && typeof details === "object" && !Array.isArray(details)) {
    const fullOutputPath = (details as { fullOutputPath?: unknown }).fullOutputPath;
    if (typeof fullOutputPath === "string") await unlink(fullOutputPath).catch(() => undefined);
    delete (details as Record<string, unknown>).fullOutputPath;
  }
  if (serializedBytes(result) <= maxBytes) return result;
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content
    .filter((block): block is { type: "text"; text: string } =>
      Boolean(block && typeof block === "object" && (block as { type?: unknown }).type === "text"),
    )
    .map((block) => block.text)
    .join("\n");
  return {
    content: [{ type: "text", text: truncateUtf8(text, Math.max(0, maxBytes - 128)) }],
    ...(result.isError === true ? { isError: true } : {}),
    details: { truncated: true },
  };
}

export class RedactingMcpTransport implements McpTransport {
  readonly #pending = new Map<JsonRpcId, { method: string; toolName?: string }>();
  #closePromise?: Promise<void>;

  constructor(
    private readonly transport: McpTransport,
    private readonly policy: ServerPolicy,
    private readonly redactor: SecretRedactor,
    private readonly health?: {
      set(
        sessionId: string,
        serverId: string,
        status: "healthy" | "degraded",
        detail?: string,
      ): void;
    },
    private readonly sessionId?: string,
  ) {}

  #setHealth(status: "healthy" | "degraded", detail?: string): void {
    if (this.health && this.sessionId) {
      this.health.set(this.sessionId, this.policy.id, status, detail);
    }
  }

  start(): Promise<void> {
    return this.transport.start();
  }

  async send(message: JsonRpcMessage): Promise<void> {
    if (isJsonRpcRequest(message)) {
      const params = message.params as { name?: unknown } | undefined;
      this.#pending.set(message.id, {
        method: message.method,
        ...(typeof params?.name === "string" ? { toolName: params.name } : {}),
      });
    }
    try {
      await this.transport.send(message);
    } catch (error) {
      if (isJsonRpcRequest(message)) this.#pending.delete(message.id);
      this.#setHealth(
        "degraded",
        String(this.redactor.redact(error instanceof Error ? error.message : error)),
      );
      throw error;
    }
  }

  close(): Promise<void> {
    this.#pending.clear();
    this.#closePromise ??= this.transport.close();
    return this.#closePromise;
  }

  onMessage(listener: McpTransportMessageListener): () => void {
    return this.transport.onMessage((message) => {
      if (isJsonRpcResponse(message)) {
        const request = this.#pending.get(message.id);
        this.#pending.delete(message.id);
        if (request?.method === "initialize") {
          this.#setHealth(
            "error" in message ? "degraded" : "healthy",
            "error" in message ? String(this.redactor.redact(message.error.message)) : undefined,
          );
        }
        if (request?.method === "tools/call" && "result" in message) {
          listener({
            ...message,
            result: boundCallToolResult(
              message.result,
              Math.max(0, this.policy.maxResultBytes - 256),
              this.redactor,
            ),
          });
          return;
        }
      }
      listener(this.redactor.redact(message) as JsonRpcMessage);
    });
  }

  onError(listener: (error: Error) => void): () => void {
    return this.transport.onError((error) => {
      const safe = String(this.redactor.redact(error.message));
      this.#setHealth("degraded", safe);
      listener(new Error(safe));
    });
  }

  onClose(listener: () => void): () => void {
    return this.transport.onClose(() => {
      this.#setHealth("degraded", "MCP transport closed.");
      listener();
    });
  }

  setProtocolVersion(version: string): void {
    this.transport.setProtocolVersion?.(version);
  }
}

export function createKlausMcpExtension(
  configs: readonly AppConfig["mcp"][number][],
  loadedConfig: LoadedMcpConfig,
  audits: ToolAuditRepository,
  redactor: SecretRedactor,
  health?: PiMcpHealthRegistry,
  connections?: PiMcpConnectionRegistry,
  sessionId?: string,
): ExtensionFactory {
  const policies = new Map(configs.map((config) => [config.id, config]));
  const loadedNames = new Set(loadedConfig.servers.map((server) => server.name));
  let sessionActive = true;
  if (health && sessionId) health.beginSession(sessionId);
  const healthReporter =
    health && sessionId
      ? {
          set: (
            currentSessionId: string,
            serverId: string,
            status: "healthy" | "degraded",
            detail?: string,
          ) => {
            if (sessionActive) health.set(currentSessionId, serverId, status, detail);
          },
        }
      : undefined;
  if (health && sessionId) {
    for (const config of configs) {
      health.set(
        sessionId,
        config.id,
        "degraded",
        loadedNames.has(config.id)
          ? "Pi MCP connection has not completed initialization."
          : "Configured MCP secret file is unavailable.",
      );
    }
  }
  const extension = createMcpExtension({
    loadConfig: () => loadedConfig,
    logPath: "/dev/null",
    updateConfig: () => undefined,
    createTransport: (entry, cwd, authProvider) => {
      const policy = policies.get(entry.name);
      if (!policy) throw new Error(`MCP server is not configured: ${entry.name}`);
      const transport: McpTransport =
        "url" in entry.config
          ? new StreamableHttpTransport({
              url: entry.config.url,
              ...(entry.config.headers ? { headers: entry.config.headers } : {}),
              ...(authProvider ? { authProvider } : {}),
            })
          : new StdioTransport({
              command: entry.config.command,
              ...(entry.config.args ? { args: entry.config.args } : {}),
              cwd: resolve(cwd, entry.config.cwd ?? "."),
              ...(entry.config.env ? { env: entry.config.env } : {}),
              stderr: "pipe",
            });
      const guardedTransport = new RedactingMcpTransport(
        transport,
        policy,
        redactor,
        healthReporter,
        sessionId,
      );
      if (sessionId) connections?.add(sessionId, guardedTransport);
      return guardedTransport;
    },
    startupWaitMs: 2_000,
  });

  const definitions = new Map<
    string,
    { server: AppConfig["mcp"][number]; remoteName: string; allowed: boolean }
  >();
  return hideMcpResourceHelpers((pi) => {
    if (health && sessionId) {
      pi.on("session_shutdown", () => {
        sessionActive = false;
        health.clearSession(sessionId);
      });
    }
    pi.on("tool_call", (event) => {
      const binding = definitions.get(event.toolName);
      if (binding && !binding.allowed) {
        return { block: true, reason: "This MCP tool is excluded by Klaus configuration" };
      }
      return undefined;
    });
    const guarded = new Proxy(pi, {
      get(target, property) {
        if (property === "registerTool") {
          return (definition: ToolDefinition) => {
            if (!definition.namespace?.name.startsWith("mcp__")) {
              return target.registerTool(definition);
            }
            const delimiter = definition.label.indexOf("/");
            const serverId = delimiter < 0 ? "" : definition.label.slice(0, delimiter);
            const remoteName =
              delimiter < 0 ? definition.name : definition.label.slice(delimiter + 1);
            const server = policies.get(serverId);
            if (!server) return;
            const allowed = server.tools === undefined || server.tools.includes(remoteName);
            definitions.set(definition.name, { server, remoteName, allowed });
            const original = definition.execute.bind(definition);
            const execute: ToolDefinition["execute"] = async (
              toolCallId,
              params,
              signal,
              onUpdate,
              toolContext,
            ) => {
              const auditId = audits.start(
                server.id,
                remoteName,
                redactor.redact(params),
                undefined,
                toolCallId,
              );
              const timeout = AbortSignal.timeout(server.timeoutMs);
              const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
              const safeUpdate: typeof onUpdate = onUpdate
                ? (update) => onUpdate(redactor.redact(update) as typeof update)
                : undefined;
              try {
                if (!allowed) throw new Error("MCP tool is excluded by Klaus configuration");
                const output = await original(
                  toolCallId,
                  params,
                  combined,
                  safeUpdate,
                  toolContext,
                );
                const safe = (await safeToolResult(
                  output,
                  server.maxResultBytes,
                  redactor,
                )) as typeof output;
                const isError = Boolean(
                  safe && typeof safe === "object" && "isError" in safe && safe.isError,
                );
                audits.finish(auditId, isError ? "failure" : "success", safe);
                return safe;
              } catch (error) {
                const outcome: ToolOutcome = signal?.aborted
                  ? "cancelled"
                  : timeout.aborted
                    ? "timeout"
                    : "failure";
                audits.finish(auditId, outcome, {
                  error: redactor.redact(error instanceof Error ? error.message : String(error)),
                });
                const safeMessage = String(
                  redactor.redact(error instanceof Error ? error.message : String(error)),
                );
                const safeCause = redactor.redact(
                  error instanceof Error
                    ? { name: error.name, message: error.message }
                    : String(error),
                );
                // The original MCP error may contain configured credentials; keep only its redacted form.
                // eslint-disable-next-line preserve-caught-error
                throw new Error(safeMessage, { cause: safeCause });
              }
            };
            return target.registerTool({ ...definition, execute });
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        if (typeof value !== "function") return value;
        const method = value as (...args: unknown[]) => unknown;
        return (...args: unknown[]) => method.apply(target, args);
      },
    });
    return extension(guarded);
  });
}
