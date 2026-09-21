import { Ajv, type ValidateFunction } from "ajv";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { McpServerConfig } from "../config.js";
import type { ToolAuditRepository, ToolOutcome } from "../persistence/repositories.js";
import { readSecret, SecretRedactor } from "../security/secrets.js";
import type { CapabilityProvider } from "../capabilities/types.js";

export type DiscoveredTool = {
  name: string;
  description?: string;
  inputSchema: { type: "object"; [key: string]: unknown };
};

export interface McpClientLike {
  onclose?: () => void;
  connect(): Promise<void>;
  close(): Promise<void>;
  listTools(): Promise<{ tools: DiscoveredTool[] }>;
  callTool(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
}

class SdkMcpClient implements McpClientLike {
  readonly #client = new Client({ name: "klaus-agent", version: "1.0.0" });
  #transport?: StreamableHTTPClientTransport | StdioClientTransport;
  onclose?: () => void;

  constructor(
    private readonly config: McpServerConfig,
    private readonly token?: string,
    private readonly secretEnv: Record<string, string> = {},
  ) {}

  async connect(): Promise<void> {
    if ("url" in this.config) {
      this.#transport = new StreamableHTTPClientTransport(new URL(this.config.url), {
        requestInit: {
          redirect: "error",
          ...(this.token ? { headers: { Authorization: `Bearer ${this.token}` } } : {}),
        },
      });
    } else {
      this.#transport = new StdioClientTransport({
        command: this.config.command,
        args: this.config.args,
        env: { ...this.config.env, ...this.secretEnv },
        stderr: "pipe",
      });
      this.#transport.stderr?.on("data", () => undefined);
    }
    this.#transport.onclose = () => this.onclose?.();
    await this.#client.connect(this.#transport as never);
  }

  close(): Promise<void> {
    return this.#client.close();
  }

  async listTools(): Promise<{ tools: DiscoveredTool[] }> {
    const result = await this.#client.listTools();
    return {
      tools: result.tools.map((tool) => ({
        name: tool.name,
        inputSchema: tool.inputSchema,
        ...(tool.description ? { description: tool.description } : {}),
      })),
    };
  }

  callTool(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    return this.#client.callTool({ name, arguments: args }, undefined, { signal });
  }
}

export type McpClientFactory = (
  config: McpServerConfig,
  token?: string,
  secretEnv?: Record<string, string>,
) => Promise<McpClientLike>;

export class McpRegistry implements CapabilityProvider {
  readonly id = "mcp";
  readonly #clients = new Map<string, McpClientLike>();
  readonly #tools = new Map<
    string,
    {
      server: McpServerConfig;
      remoteName: string;
      validate: ValidateFunction;
    }
  >();
  readonly #health = new Map<string, { status: "healthy" | "degraded"; detail?: string }>();
  readonly #ajv = new Ajv({ strict: false, allErrors: true });

  constructor(
    private readonly configs: readonly McpServerConfig[],
    private readonly audits: ToolAuditRepository,
    private readonly factory: McpClientFactory = (config, token, secretEnv) =>
      Promise.resolve(new SdkMcpClient(config, token, secretEnv)),
    private readonly redactor = new SecretRedactor(),
  ) {}

  #safeDetail(error: unknown, fallback: string): string {
    const detail = error instanceof Error ? error.message : fallback;
    return String(this.redactor.redact(detail));
  }

  async start(): Promise<void> {
    await this.connect();
  }

  async connect(): Promise<void> {
    for (const config of this.configs) {
      try {
        await this.#connectOne(config);
      } catch (error) {
        this.#health.set(config.id, {
          status: "degraded",
          detail: this.#safeDetail(error, "MCP connection failed"),
        });
      }
    }
  }

  async #connectOne(config: McpServerConfig): Promise<void> {
    const token =
      "url" in config && config.tokenFile ? await readSecret(config.tokenFile) : undefined;
    const secretEnv =
      "url" in config
        ? undefined
        : Object.fromEntries(
            await Promise.all(
              Object.entries(config.secretEnv).map(async ([name, path]) => {
                const value = await readSecret(path);
                this.redactor.add(value);
                return [name, value] as const;
              }),
            ),
          );
    if (token) this.redactor.add(token);
    const client = await this.factory(config, token, secretEnv);
    await client.connect();
    const listed = await client.listTools();
    const discovered: Array<{
      publicName: string;
      remoteName: string;
      validate: ValidateFunction;
    }> = [];
    for (const tool of listed.tools) {
      if (config.tools && !config.tools.includes(tool.name)) continue;
      discovered.push({
        publicName: `${config.id}__${tool.name}`,
        remoteName: tool.name,
        validate: this.#ajv.compile(tool.inputSchema),
      });
    }
    const previous = this.#clients.get(config.id);
    if (previous) {
      previous.onclose = () => undefined;
      await previous.close();
    }
    this.#clients.set(config.id, client);
    for (const name of this.#tools.keys()) {
      if (name.startsWith(`${config.id}__`)) this.#tools.delete(name);
    }
    for (const tool of discovered) {
      if (this.#tools.has(tool.publicName))
        throw new Error(`Duplicate MCP tool: ${tool.publicName}`);
      this.#tools.set(tool.publicName, {
        server: config,
        remoteName: tool.remoteName,
        validate: tool.validate,
      });
    }
    client.onclose = () => {
      if (this.#clients.get(config.id) === client) {
        this.#health.set(config.id, { status: "degraded", detail: "MCP process disconnected" });
      }
    };
    this.#health.set(config.id, { status: "healthy" });
  }

  async reconnect(
    serverId: string,
    attempts = 3,
    sleeper: (milliseconds: number) => Promise<void> = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
  ): Promise<boolean> {
    const config = this.configs.find((candidate) => candidate.id === serverId);
    if (!config) throw new Error(`Unknown MCP server: ${serverId}`);
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        await this.#connectOne(config);
        return true;
      } catch (error) {
        this.#health.set(serverId, {
          status: "degraded",
          detail: this.#safeDetail(error, "MCP reconnection failed"),
        });
        if (attempt + 1 < attempts) await sleeper(Math.min(5_000, 250 * 2 ** attempt));
      }
    }
    return false;
  }

  stop(): Promise<void> {
    return this.close();
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.#clients.values()].map((client) => client.close()));
    this.#clients.clear();
    this.#tools.clear();
  }

  health(): Record<string, { status: "healthy" | "degraded"; detail?: string }> {
    return Object.fromEntries(this.#health);
  }

  names(): string[] {
    return [...this.#tools.keys()].sort();
  }

  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const tool = this.#tools.get(name);
    if (!tool) throw new Error(`MCP capability unavailable: ${name}`);
    if (!tool.validate(args)) throw new Error(`Invalid arguments for ${name}`);

    const client = this.#clients.get(tool.server.id);
    if (!client) throw new Error(`MCP server unavailable: ${tool.server.id}`);
    const auditId = this.audits.start(tool.server.id, tool.remoteName, this.redactor.redact(args));
    const timeout = AbortSignal.timeout(tool.server.timeoutMs);
    try {
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const result = this.redactor.redact(await client.callTool(tool.remoteName, args, combined));
      const serialized = JSON.stringify(result);
      const bounded =
        Buffer.byteLength(serialized) > tool.server.maxResultBytes
          ? {
              truncated: true,
              content: Buffer.from(serialized)
                .subarray(0, tool.server.maxResultBytes)
                .toString("utf8"),
            }
          : result;
      this.audits.finish(auditId, "success", bounded);
      return bounded;
    } catch (error) {
      const outcome: ToolOutcome = signal?.aborted
        ? "cancelled"
        : timeout.aborted
          ? "timeout"
          : "failure";
      this.audits.finish(auditId, outcome, {
        error: this.#safeDetail(error, "MCP call failed"),
      });
      throw error;
    }
  }

  tools(): readonly ToolDefinition[] {
    return this.piTools();
  }

  piTools(): ToolDefinition[] {
    return this.names().map((name) => {
      const tool = this.#tools.get(name)!;
      return defineTool({
        name,
        label: name,
        description: `Configured MCP tool ${name}`,
        parameters: tool.validate.schema,
        execute: async (_toolCallId, params, signal) => {
          const result = await this.call(name, params as Record<string, unknown>, signal);
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            details: { serverId: tool.server.id, remoteName: tool.remoteName },
          };
        },
      });
    });
  }
}
