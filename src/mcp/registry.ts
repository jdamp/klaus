import { Ajv, type ValidateFunction } from "ajv";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { McpServerConfig } from "../config.js";
import type { ToolAuditRepository, ToolOutcome } from "../persistence/repositories.js";
import { readSecret, SecretRedactor } from "../security/secrets.js";

export type DiscoveredTool = {
  name: string;
  description?: string;
  inputSchema: { type: "object"; [key: string]: unknown };
};

export interface McpClientLike {
  connect(): Promise<void>;
  close(): Promise<void>;
  listTools(): Promise<{ tools: DiscoveredTool[] }>;
  callTool(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
}

class SdkMcpClient implements McpClientLike {
  readonly #client = new Client({ name: "klaus-agent", version: "1.0.0" });
  #transport?: StreamableHTTPClientTransport;

  constructor(
    private readonly url: URL,
    private readonly token?: string,
  ) {}

  async connect(): Promise<void> {
    this.#transport = new StreamableHTTPClientTransport(this.url, {
      requestInit: {
        redirect: "error",
        ...(this.token ? { headers: { Authorization: `Bearer ${this.token}` } } : {}),
      },
    });
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

export type McpClientFactory = (config: McpServerConfig, token?: string) => Promise<McpClientLike>;

export class McpRegistry {
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
    private readonly factory: McpClientFactory = (config, token) =>
      Promise.resolve(new SdkMcpClient(new URL(config.url), token)),
    private readonly redactor = new SecretRedactor(),
  ) {}

  #safeDetail(error: unknown, fallback: string): string {
    const detail = error instanceof Error ? error.message : fallback;
    return String(this.redactor.redact(detail));
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
    const token = config.tokenFile ? await readSecret(config.tokenFile) : undefined;
    const client = await this.factory(config, token);
    await client.connect();
    const previous = this.#clients.get(config.id);
    if (previous) await previous.close();
    this.#clients.set(config.id, client);
    for (const name of this.#tools.keys()) {
      if (name.startsWith(`${config.id}__`)) this.#tools.delete(name);
    }
    const listed = await client.listTools();
    for (const tool of listed.tools) {
      if (!config.tools.includes(tool.name)) continue;
      const publicName = `${config.id}__${tool.name}`;
      if (this.#tools.has(publicName)) throw new Error(`Duplicate MCP tool: ${publicName}`);
      this.#tools.set(publicName, {
        server: config,
        remoteName: tool.name,
        validate: this.#ajv.compile(tool.inputSchema),
      });
    }
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
