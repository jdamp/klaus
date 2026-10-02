import { appendFile, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { estimateTokens, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  isJsonRpcRequest,
  type JsonRpcMessage,
  type McpTransport,
  type McpTransportMessageListener,
} from "@earendil-works/pi-mcp";
import { describe, expect, it } from "vitest";

import { PiSessionFactory } from "../src/agent/pi-runtime.js";
import { parseConfig } from "../src/config.js";
import {
  PiMcpConnectionRegistry,
  loadPiMcpConfig,
  PiMcpHealthRegistry,
  RedactingMcpTransport,
} from "../src/mcp/pi-adapter.js";
import { AppDatabase } from "../src/persistence/database.js";
import { SessionEntryRepository, ToolAuditRepository } from "../src/persistence/repositories.js";
import { SecretRedactor } from "../src/security/secrets.js";

function configYaml(root: string, mcp: string): string {
  return `
telegram:
  tokenFile: ${root}/telegram-token
  allowedUsers: ["1"]
  allowedChats: ["1"]
model:
  provider: openai-codex
  id: gpt-6-sol
  authPath: ${root}/auth/auth.json
data:
  directory: ${root}/data
mcp:${mcp}
skills:
  paths: []
health: {}
`;
}

class FakeTransport implements McpTransport {
  readonly sent: JsonRpcMessage[] = [];
  #message: McpTransportMessageListener | undefined;

  start(): Promise<void> {
    return Promise.resolve();
  }

  send(message: JsonRpcMessage): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  onMessage(listener: McpTransportMessageListener): () => void {
    this.#message = listener;
    return () => {
      this.#message = undefined;
    };
  }

  onError(): () => void {
    return () => undefined;
  }

  onClose(): () => void {
    return () => undefined;
  }

  reply(message: JsonRpcMessage): void {
    this.#message?.(message);
  }
}

describe("Pi MCP adapter", () => {
  it("estimates fewer initial declaration tokens for deferred fixture tools", async () => {
    const catalogue = Array.from({ length: 24 }, (_, index) => ({
      name: `mcp__fixture__tool_${index + 1}`,
      description: `Search the fixture catalogue for household item ${index + 1} by name and status.`,
      parameters: Type.Object({
        query: Type.String({ description: "Text to match against item names." }),
        limit: Type.Optional(Type.Integer({ description: "Maximum matching items." })),
      }),
    }));
    const estimate = (tools: typeof catalogue) =>
      estimateTokens({ role: "system", content: "", toolsAdded: tools, timestamp: 0 });
    const deferredSearch = {
      name: "tool_search",
      description: "Searches deferred tool metadata and loads matching tools.",
      parameters: Type.Object({
        query: Type.String({ description: "Text to match against item names." }),
        limit: Type.Optional(Type.Integer({ description: "Maximum matching items." })),
      }),
    };
    const directEstimatedTokens = estimate(catalogue);
    const deferredEstimatedTokens = estimate([deferredSearch]);
    expect(catalogue).toHaveLength(24);
    expect(directEstimatedTokens).toBeGreaterThan(deferredEstimatedTokens);
    expect(deferredEstimatedTokens).toBeGreaterThan(0);
    if (process.env.KLAUS_MCP_MEASURE_FILE) {
      await appendFile(
        process.env.KLAUS_MCP_MEASURE_FILE,
        `${JSON.stringify({
          measurement: "pi-mcp-declarations",
          directDeclarations: catalogue.length,
          deferredDeclarations: 1,
          directEstimatedTokens,
          deferredEstimatedTokens,
        })}\n`,
      );
    }
  });

  it("maps default, direct, allowlist, and empty MCP policies without changing tool semantics", async () => {
    const root = await mkdtemp(join(tmpdir(), "klaus-pi-mcp-config-"));
    const tokenFile = join(root, "token");
    const keyFile = join(root, "kaneo-key");
    await writeFile(tokenFile, "http-fixture-token");
    await writeFile(keyFile, "stdio-fixture-key");
    const config = parseConfig(
      configYaml(
        root,
        `
  - id: unrestricted
    url: https://mcp.example.test/mcp
    tokenFile: ${tokenFile}
  - id: allowlist
    url: https://mcp.example.test/allowed
    exposure: direct
    tools: [get_state]
  - id: disabled
    url: https://mcp.example.test/disabled
    tools: []
  - id: kaneo
    command: node
    args: [server.js]
    secretEnv:
      KANEO_API_KEY: ${keyFile}`,
      ),
    );
    const redactor = new SecretRedactor();
    const loaded = await loadPiMcpConfig(config.mcp, redactor);

    expect(loaded.errors).toEqual([]);
    expect(loaded.servers).toHaveLength(4);
    expect(loaded.servers[0]).toMatchObject({
      name: "unrestricted",
      config: { exposure: "deferred", url: "https://mcp.example.test/mcp" },
    });
    expect(loaded.servers[0]?.config).toHaveProperty(
      "headers.Authorization",
      "Bearer http-fixture-token",
    );
    expect(loaded.servers[1]?.config).toMatchObject({
      exposure: "hidden",
      toolExposure: { get_state: "direct" },
    });
    expect(loaded.servers[2]?.config).toMatchObject({ exposure: "hidden" });
    expect(loaded.servers[2]?.config).not.toHaveProperty("toolExposure");
    expect(loaded.servers[3]?.config).toMatchObject({
      type: "stdio",
      env: { KANEO_API_KEY: "stdio-fixture-key" },
    });
    expect(loaded.servers.map((server) => server.name)).toEqual([
      "unrestricted",
      "allowlist",
      "disabled",
      "kaneo",
    ]);
    expect(isJsonRpcRequest({ jsonrpc: "2.0", id: 1, method: "tools/call" })).toBe(true);
    expect(
      JSON.stringify(redactor.redact({ Authorization: "Bearer http-fixture-token" })),
    ).not.toContain("http-fixture-token");
  });

  it("redacts and bounds MCP responses before Pi can store or spill them", async () => {
    const root = await mkdtemp(join(tmpdir(), "klaus-pi-mcp-bound-"));
    const config = parseConfig(
      configYaml(
        root,
        `
  - id: home
    url: https://mcp.example.test/mcp
    maxResultBytes: 1024`,
      ),
    );
    const policy = config.mcp[0];
    if (!policy) throw new Error("Expected one MCP policy");
    const secret = "mcp-result-fixture-secret";
    const redactor = new SecretRedactor();
    redactor.add(secret);
    const inner = new FakeTransport();
    const transport = new RedactingMcpTransport(inner, policy, redactor);
    const received: JsonRpcMessage[] = [];
    transport.onMessage((message) => received.push(message));

    await transport.send({
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: { name: "light", arguments: {} },
    });
    inner.reply({
      jsonrpc: "2.0",
      id: 8,
      result: {
        content: [
          { type: "text", text: `Token was ${secret}` },
          { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        ],
        structuredContent: { api_key: secret, status: "ok" },
      },
    });
    const response = received[0];
    expect(response && "result" in response).toBe(true);
    const serialized = JSON.stringify(response);
    expect(serialized).not.toContain(secret);
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).toContain("image/png");
    expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(policy.maxResultBytes);

    const largeTransport = new FakeTransport();
    const boundedTransport = new RedactingMcpTransport(largeTransport, policy, redactor);
    const largeResponses: JsonRpcMessage[] = [];
    boundedTransport.onMessage((message) => largeResponses.push(message));
    await boundedTransport.send({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "large", arguments: {} },
    });
    largeTransport.reply({
      jsonrpc: "2.0",
      id: 9,
      result: {
        content: [{ type: "text", text: `${secret} ${"x".repeat(8_000)}` }],
        structuredContent: { nested: "y".repeat(8_000) },
      },
    });
    const largeSerialized = JSON.stringify(largeResponses[0]);
    expect(largeSerialized).not.toContain(secret);
    expect(Buffer.byteLength(largeSerialized)).toBeLessThanOrEqual(policy.maxResultBytes);
  });

  it("connects a configured stdio server through Pi and audits redacted calls", async () => {
    const root = await mkdtemp(join(tmpdir(), "klaus-pi-mcp-stdio-"));
    const secretFile = join(root, "mcp-secret");
    const secret = "pi-stdio-result-secret";
    await writeFile(secretFile, secret);
    const config = parseConfig(
      configYaml(
        root,
        `
  - id: stdio
    exposure: deferred
    command: ${process.execPath}
    args: [${resolve("test/fixtures/mcp-stdio-secret.mjs")}]
    secretEnv:
      TEST_MCP_SECRET: ${secretFile}
    tools: [secret_echo, slow_echo, error_echo, large_echo, image_echo]
    timeoutMs: 2000
  - id: kaneo
    command: ${process.execPath}
    args: [${resolve("test/fixtures/mcp-stdio-secret.mjs")}]
    secretEnv:
      TEST_MCP_SECRET: ${secretFile}
    tools: [secret_echo]
    timeoutMs: 5000
  - id: offline
    exposure: deferred
    command: /bin/false
    args: []
    timeoutMs: 1000`,
      ),
    );
    const redactor = new SecretRedactor();
    const database = new AppDatabase(":memory:");
    database.migrate();
    const audits = new ToolAuditRepository(database);
    const health = new PiMcpHealthRegistry();
    const connections = new PiMcpConnectionRegistry();
    const runtime = await ModelRuntime.create({
      authPath: config.model.authPath,
      refreshOnCreate: false,
    });
    let managed: Awaited<ReturnType<PiSessionFactory["create"]>> | undefined;
    try {
      const factory = new PiSessionFactory(
        config,
        runtime,
        new SessionEntryRepository(database),
        [],
        undefined,
        undefined,
        { audits, redactor, health, connections },
      );
      managed = await factory.create("88888888-8888-4888-8888-888888888888");
      const deadline = Date.now() + 5_000;
      let definition = managed.session.extensionRunner.getToolDefinition("mcp__stdio__secret_echo");
      let errorDefinition =
        managed.session.extensionRunner.getToolDefinition("mcp__stdio__error_echo");
      let largeDefinition =
        managed.session.extensionRunner.getToolDefinition("mcp__stdio__large_echo");
      let imageDefinition =
        managed.session.extensionRunner.getToolDefinition("mcp__stdio__image_echo");
      let kaneoAllowedDefinition =
        managed.session.extensionRunner.getToolDefinition("mcp__kaneo__secret_echo");
      let kaneoExcludedDefinition =
        managed.session.extensionRunner.getToolDefinition("mcp__kaneo__slow_echo");
      let slowDefinition =
        managed.session.extensionRunner.getToolDefinition("mcp__stdio__slow_echo");
      while (
        (!definition ||
          !errorDefinition ||
          !largeDefinition ||
          !imageDefinition ||
          !kaneoAllowedDefinition) &&
        Date.now() < deadline
      ) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 50));
        definition = managed.session.extensionRunner.getToolDefinition("mcp__stdio__secret_echo");
        errorDefinition =
          managed.session.extensionRunner.getToolDefinition("mcp__stdio__error_echo");
        largeDefinition =
          managed.session.extensionRunner.getToolDefinition("mcp__stdio__large_echo");
        imageDefinition =
          managed.session.extensionRunner.getToolDefinition("mcp__stdio__image_echo");
        kaneoAllowedDefinition =
          managed.session.extensionRunner.getToolDefinition("mcp__kaneo__secret_echo");
        kaneoExcludedDefinition =
          managed.session.extensionRunner.getToolDefinition("mcp__kaneo__slow_echo");
        slowDefinition = managed.session.extensionRunner.getToolDefinition("mcp__stdio__slow_echo");
      }
      expect(definition).toBeDefined();
      expect(errorDefinition).toBeDefined();
      expect(largeDefinition).toBeDefined();
      expect(imageDefinition).toBeDefined();
      expect(kaneoAllowedDefinition).toBeDefined();
      expect(kaneoExcludedDefinition).toBeDefined();
      expect(slowDefinition).toBeDefined();
      let states = health.snapshot(["stdio", "kaneo", "offline"]);
      while (
        (states["mcp.stdio"]?.status !== "healthy" ||
          states["mcp.offline"]?.detail ===
            "Pi MCP connection has not completed initialization.") &&
        Date.now() < deadline
      ) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 50));
        states = health.snapshot(["stdio", "kaneo", "offline"]);
      }
      expect(states["mcp.stdio"]?.status).toBe("healthy");
      expect(states["mcp.offline"]?.status).toBe("degraded");
      expect(managed.session.getActiveToolNames()).toContain("tool_search");
      expect(managed.session.getActiveToolNames()).not.toContain("mcp__stdio__secret_echo");

      const signal = AbortSignal.timeout(5_000);
      const toolContext = managed.session.extensionRunner.createToolContext("call-1", signal);
      const toolSearch = managed.session.extensionRunner.getToolDefinition("tool_search");
      expect(toolSearch).toBeDefined();
      const searchResult = await toolSearch!.execute(
        "search-stdio",
        { query: "secret echo configured fixture" },
        signal,
        undefined,
        toolContext,
      );
      expect(JSON.stringify(searchResult)).toContain("mcp__stdio__secret_echo");
      expect(managed.session.getActiveToolNames()).toContain("mcp__stdio__secret_echo");
      const restrictedSearch = await toolSearch!.execute(
        "search-kaneo-restriction",
        { query: "slow echo delayed result" },
        signal,
        undefined,
        toolContext,
      );
      expect(JSON.stringify(restrictedSearch)).not.toContain("mcp__kaneo__slow_echo");
      expect(managed.session.getActiveToolNames()).not.toContain("mcp__kaneo__slow_echo");
      const output = await definition!.execute("call-1", {}, signal, undefined, toolContext);
      expect(JSON.stringify(output)).toContain("[REDACTED]");
      expect(JSON.stringify(output)).not.toContain(secret);
      expect(JSON.stringify(managed.session.sessionManager.getEntries())).not.toContain(secret);
      const errorOutput = await errorDefinition!.execute(
        "call-error",
        {},
        signal,
        undefined,
        toolContext,
      );
      expect(errorOutput.isError).toBe(true);
      expect(JSON.stringify(errorOutput)).not.toContain(secret);
      const imageOutput = await imageDefinition!.execute(
        "call-image",
        {},
        signal,
        undefined,
        toolContext,
      );
      expect(JSON.stringify(imageOutput)).toContain("image/png");
      expect(JSON.stringify(imageOutput)).toContain("aGVsbG8=");
      const kaneoOutput = await kaneoAllowedDefinition!.execute(
        "call-kaneo-allowed",
        {},
        signal,
        undefined,
        toolContext,
      );
      expect(JSON.stringify(kaneoOutput)).toContain("[REDACTED]");
      await expect(
        kaneoExcludedDefinition!.execute("call-kaneo-excluded", {}, signal, undefined, toolContext),
      ).rejects.toThrow("excluded by Klaus configuration");
      const largeOutput = await largeDefinition!.execute(
        "call-large",
        {},
        signal,
        undefined,
        toolContext,
      );
      expect(JSON.stringify(largeOutput)).not.toContain("fullOutputPath");
      expect(JSON.stringify(largeOutput)).not.toContain(secret);
      const tempFiles = (await readdir(tmpdir())).filter((name) => /^pi-mcp-.*\.txt$/.test(name));
      const leakedSpill = await Promise.all(
        tempFiles.map(async (name) => {
          const path = join(tmpdir(), name);
          const contents = await readFile(path, "utf8").catch(() => "");
          return contents.includes("MCP_SPILL_PROBE_[REDACTED]") ? path : undefined;
        }),
      );
      expect(leakedSpill.filter(Boolean)).toEqual([]);
      await expect(
        slowDefinition!.execute("call-3", {}, signal, undefined, toolContext),
      ).rejects.toThrow();
      const controller = new AbortController();
      const cancellingContext = managed.session.extensionRunner.createToolContext(
        "call-4",
        controller.signal,
      );
      const cancelledCall = slowDefinition!.execute(
        "call-4",
        {},
        controller.signal,
        undefined,
        cancellingContext,
      );
      setTimeout(() => controller.abort(), 30);
      await expect(cancelledCall).rejects.toThrow();
      const rows = database.connection.prepare("SELECT * FROM tool_executions").all();
      expect(JSON.stringify(rows)).not.toContain(secret);
      expect(rows).toHaveLength(8);
      expect(rows.map((row) => (row as { status: string }).status).sort()).toEqual([
        "cancelled",
        "failure",
        "failure",
        "success",
        "success",
        "success",
        "success",
        "timeout",
      ]);
    } finally {
      await managed?.dispose();
      expect(health.snapshot(["stdio"])["mcp.stdio"]?.detail).toBe(
        "No active Pi MCP session has checked this configured server.",
      );
      database.close();
    }
  }, 15_000);

  it("sends a mounted HTTP bearer token only through Pi's in-memory MCP transport", async () => {
    const root = await mkdtemp(join(tmpdir(), "klaus-pi-mcp-http-"));
    const tokenFile = join(root, "http-token");
    const token = "pi-http-fixture-token";
    await writeFile(tokenFile, token);
    const receivedAuthorization: string[] = [];
    const serverErrors: string[] = [];
    const httpServer = createServer(async (request, response) => {
      receivedAuthorization.push(String(request.headers.authorization ?? ""));
      if (request.method === "GET") {
        response.statusCode = 405;
        response.end();
        return;
      }
      if (request.method !== "POST") {
        response.statusCode = 405;
        response.end();
        return;
      }
      try {
        let requestBody = "";
        for await (const chunk of request as AsyncIterable<unknown>) {
          if (typeof chunk === "string") requestBody += chunk;
          else if (chunk instanceof Uint8Array) requestBody += new TextDecoder().decode(chunk);
        }
        const message = JSON.parse(requestBody) as {
          jsonrpc: "2.0";
          id?: string | number;
          method: string;
          params?: Record<string, unknown>;
        };
        if (message.id === undefined) {
          response.statusCode = 202;
          response.end();
          return;
        }
        const result =
          message.method === "initialize"
            ? {
                protocolVersion: message.params?.protocolVersion ?? "2025-03-26",
                capabilities: { tools: { listChanged: true }, resources: {} },
                serverInfo: { name: "http-fixture", version: "1.0.0" },
              }
            : message.method === "tools/list"
              ? {
                  tools: [
                    {
                      name: "auth_check",
                      description: "Check mounted auth",
                      inputSchema: { type: "object", properties: {} },
                    },
                    {
                      name: "mcp_error",
                      description: "Returns an MCP tool error",
                      inputSchema: { type: "object", properties: {} },
                    },
                    {
                      name: "transport_error",
                      description: "Returns a JSON-RPC transport error",
                      inputSchema: { type: "object", properties: {} },
                    },
                    {
                      name: "ha-get_state",
                      description: "Normalized first collision fixture",
                      inputSchema: { type: "object", properties: {} },
                    },
                    {
                      name: "ha_get_state",
                      description: "Normalized second collision fixture",
                      inputSchema: { type: "object", properties: {} },
                    },
                  ],
                }
              : message.method === "tools/call"
                ? message.params?.name === "transport_error"
                  ? undefined
                  : message.params?.name === "mcp_error"
                    ? {
                        isError: true,
                        content: [{ type: "text", text: `Rejected bearer ${token}` }],
                      }
                    : {
                        content: [
                          {
                            type: "text",
                            text: receivedAuthorization.includes(`Bearer ${token}`)
                              ? "auth-ok"
                              : "auth-missing",
                          },
                        ],
                      }
                : message.method === "resources/list"
                  ? { resources: [] }
                  : message.method === "resources/templates/list"
                    ? { resourceTemplates: [] }
                    : undefined;
        response.statusCode = 200;
        response.setHeader("Content-Type", "application/json");
        response.end(
          JSON.stringify(
            message.method === "tools/call" && message.params?.name === "transport_error"
              ? {
                  jsonrpc: "2.0",
                  id: message.id,
                  error: { code: -32603, message: `MCP upstream failure ${token}` },
                }
              : result === undefined
                ? {
                    jsonrpc: "2.0",
                    id: message.id,
                    error: { code: -32601, message: "Method not found" },
                  }
                : { jsonrpc: "2.0", id: message.id, result },
          ),
        );
      } catch (error) {
        serverErrors.push(error instanceof Error ? error.message : String(error));
        response.statusCode = 500;
        response.end();
      }
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      httpServer.once("error", rejectListen);
      httpServer.listen(0, "127.0.0.1", resolveListen);
    });
    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("Expected an HTTP fixture port");
    const config = parseConfig(
      configYaml(
        root,
        `
  - id: http
    url: http://127.0.0.1:${address.port}/mcp
    tokenFile: ${tokenFile}
    exposure: direct
    timeoutMs: 5000`,
      ),
    );
    const redactor = new SecretRedactor();
    const database = new AppDatabase(":memory:");
    database.migrate();
    const audits = new ToolAuditRepository(database);
    const health = new PiMcpHealthRegistry();
    const connections = new PiMcpConnectionRegistry();
    const runtime = await ModelRuntime.create({
      authPath: config.model.authPath,
      refreshOnCreate: false,
    });
    let managed: Awaited<ReturnType<PiSessionFactory["create"]>> | undefined;
    try {
      const factory = new PiSessionFactory(
        config,
        runtime,
        new SessionEntryRepository(database),
        [],
        undefined,
        undefined,
        { audits, redactor, health, connections },
      );
      managed = await factory.create("99999999-9999-4999-8999-999999999999");
      const deadline = Date.now() + 5_000;
      let definition = managed.session.extensionRunner.getToolDefinition("mcp__http__auth_check");
      let mcpErrorDefinition =
        managed.session.extensionRunner.getToolDefinition("mcp__http__mcp_error");
      let transportErrorDefinition = managed.session.extensionRunner.getToolDefinition(
        "mcp__http__transport_error",
      );
      while (
        (!definition || !mcpErrorDefinition || !transportErrorDefinition) &&
        Date.now() < deadline
      ) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 50));
        definition = managed.session.extensionRunner.getToolDefinition("mcp__http__auth_check");
        mcpErrorDefinition =
          managed.session.extensionRunner.getToolDefinition("mcp__http__mcp_error");
        transportErrorDefinition = managed.session.extensionRunner.getToolDefinition(
          "mcp__http__transport_error",
        );
      }
      if (!definition || !mcpErrorDefinition || !transportErrorDefinition) {
        throw new Error(
          `HTTP MCP did not register auth_check: ${JSON.stringify(health.snapshot(["http"]))}; requests=${receivedAuthorization.length}; errors=${serverErrors.join(" | ")}`,
        );
      }
      expect(managed.session.getActiveToolNames()).toContain("mcp__http__auth_check");
      const directNames = managed.session.getActiveToolNames();
      const normalizedCollisionNames = directNames.filter((name) =>
        name.startsWith("mcp__http__ha_get_state_"),
      );
      expect(normalizedCollisionNames).toHaveLength(2);
      expect(new Set(normalizedCollisionNames).size).toBe(2);
      expect(normalizedCollisionNames.every((name) => /_[0-9a-f]{8}$/.test(name))).toBe(true);
      const signal = AbortSignal.timeout(5_000);
      const toolContext = managed.session.extensionRunner.createToolContext("http-call", signal);
      const output = await definition.execute("http-call", {}, signal, undefined, toolContext);
      expect(JSON.stringify(output)).toContain("auth-ok");
      const mcpError = await mcpErrorDefinition.execute(
        "http-mcp-error",
        {},
        signal,
        undefined,
        toolContext,
      );
      expect(mcpError.isError).toBe(true);
      expect(JSON.stringify(mcpError)).not.toContain(token);
      await expect(
        transportErrorDefinition.execute(
          "http-transport-error",
          {},
          signal,
          undefined,
          toolContext,
        ),
      ).rejects.toThrow();
      expect(receivedAuthorization.length).toBeGreaterThan(0);
      expect(receivedAuthorization.every((value) => value === `Bearer ${token}`)).toBe(true);
      const auditRows = database.connection.prepare("SELECT * FROM tool_executions").all();
      expect(JSON.stringify(auditRows)).not.toContain(token);
      expect(auditRows).toHaveLength(3);
      expect(auditRows.map((row) => (row as { status: string }).status).sort()).toEqual([
        "failure",
        "failure",
        "success",
      ]);
      expect(JSON.stringify(managed.session.sessionManager.getEntries())).not.toContain(token);
    } finally {
      await managed?.dispose();
      database.close();
      await new Promise<void>((resolveClose) => httpServer.close(() => resolveClose()));
    }
  }, 15_000);

  it("keeps one stdio process per active Pi session and closes it on disposal", async () => {
    const root = await mkdtemp(join(tmpdir(), "klaus-pi-mcp-sessions-"));
    const secretFile = join(root, "mcp-secret");
    const secret = "session-bound-fixture-secret";
    await writeFile(secretFile, secret);
    const config = parseConfig(
      configYaml(
        root,
        `
  - id: one
    command: ${process.execPath}
    args: [${resolve("test/fixtures/mcp-stdio-secret.mjs")}]
    secretEnv:
      TEST_MCP_SECRET: ${secretFile}
    exposure: direct
    tools: [secret_echo]`,
      ),
    );
    const database = new AppDatabase(":memory:");
    database.migrate();
    const redactor = new SecretRedactor();
    const audits = new ToolAuditRepository(database);
    const connections = new PiMcpConnectionRegistry();
    const runtime = await ModelRuntime.create({
      authPath: config.model.authPath,
      refreshOnCreate: false,
    });
    const factory = new PiSessionFactory(
      config,
      runtime,
      new SessionEntryRepository(database),
      [],
      undefined,
      undefined,
      { audits, redactor, connections },
    );
    const sessions: Array<Awaited<ReturnType<PiSessionFactory["create"]>>> = [];
    const pids = new Set<number>();
    try {
      for (const sessionId of [
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      ]) {
        const managed = await factory.create(sessionId);
        sessions.push(managed);
        const deadline = Date.now() + 5_000;
        let definition = managed.session.extensionRunner.getToolDefinition("mcp__one__secret_echo");
        while (!definition && Date.now() < deadline) {
          await new Promise((resolveWait) => setTimeout(resolveWait, 50));
          definition = managed.session.extensionRunner.getToolDefinition("mcp__one__secret_echo");
        }
        expect(definition).toBeDefined();
        expect(managed.session.getActiveToolNames()).toContain("mcp__one__secret_echo");
        const signal = AbortSignal.timeout(5_000);
        const context = managed.session.extensionRunner.createToolContext(sessionId, signal);
        const result = await definition!.execute(sessionId, {}, signal, undefined, context);
        const pid = /pid=(\d+)/.exec(JSON.stringify(result))?.[1];
        if (!pid) throw new Error("Pi MCP fixture did not report its process ID");
        pids.add(Number(pid));
        expect(JSON.stringify(result)).not.toContain(secret);
      }
      expect(pids.size).toBe(2);
      await Promise.all(sessions.map((managed) => Promise.resolve(managed.dispose())));
      for (const pid of pids) {
        const deadline = Date.now() + 7_000;
        let running = true;
        while (running && Date.now() < deadline) {
          try {
            const stat = await readFile(`/proc/${pid}/stat`, "utf8");
            const state = stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
            running = state !== "Z";
            await new Promise((resolveWait) => setTimeout(resolveWait, 25));
          } catch {
            running = false;
          }
        }
        expect(running, `stdio process ${pid} was still running after session disposal`).toBe(
          false,
        );
      }
    } finally {
      await Promise.all(sessions.map((managed) => Promise.resolve(managed.dispose())));
      database.close();
    }
  }, 15_000);

  it("discovers a changed unrestricted catalogue after session recreation", async () => {
    const root = await mkdtemp(join(tmpdir(), "klaus-pi-mcp-recreated-catalogue-"));
    const fixture = resolve("test/fixtures/mcp-stdio-secret.mjs");
    const configFor = (toolset: "v1" | "v2") =>
      parseConfig(
        configYaml(
          root,
          `
  - id: refresh
    command: ${process.execPath}
    args: [${fixture}]
    env:
      TEST_MCP_TOOLSET: ${toolset}
    exposure: deferred`,
        ),
      );
    const database = new AppDatabase(":memory:");
    database.migrate();
    const entries = new SessionEntryRepository(database);
    const audits = new ToolAuditRepository(database);
    const redactor = new SecretRedactor();
    const connections = new PiMcpConnectionRegistry();
    const runtime = await ModelRuntime.create({
      authPath: configFor("v1").model.authPath,
      refreshOnCreate: false,
    });
    let first: Awaited<ReturnType<PiSessionFactory["create"]>> | undefined;
    let recreated: Awaited<ReturnType<PiSessionFactory["create"]>> | undefined;
    const sessionId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    try {
      const firstFactory = new PiSessionFactory(
        configFor("v1"),
        runtime,
        entries,
        [],
        undefined,
        undefined,
        { audits, redactor, connections },
      );
      first = await firstFactory.create(sessionId);
      const deadline = Date.now() + 5_000;
      while (
        !first.session.extensionRunner.getToolDefinition("mcp__refresh__secret_echo") &&
        Date.now() < deadline
      ) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 50));
      }
      expect(
        first.session.extensionRunner.getToolDefinition("mcp__refresh__new_feature"),
      ).toBeUndefined();
      await first.dispose();
      first = undefined;

      const secondFactory = new PiSessionFactory(
        configFor("v2"),
        runtime,
        entries,
        [],
        undefined,
        undefined,
        { audits, redactor, connections },
      );
      const discoveryStarted = performance.now();
      recreated = await secondFactory.create(sessionId);
      let newTool = recreated.session.extensionRunner.getToolDefinition(
        "mcp__refresh__new_feature",
      );
      while (!newTool && Date.now() < deadline) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 50));
        newTool = recreated.session.extensionRunner.getToolDefinition("mcp__refresh__new_feature");
      }
      const catalogueDiscoveryMs = Math.round(performance.now() - discoveryStarted);
      expect(newTool).toBeDefined();
      expect(recreated.session.getActiveToolNames()).not.toContain("mcp__refresh__new_feature");
      const signal = AbortSignal.timeout(5_000);
      const context = recreated.session.extensionRunner.createToolContext(
        "catalogue-search",
        signal,
      );
      const search = recreated.session.extensionRunner.getToolDefinition("tool_search");
      const firstSearchStarted = performance.now();
      const result = await search!.execute(
        "catalogue-search",
        { query: "new feature catalogue items" },
        signal,
        undefined,
        context,
      );
      const firstSearchMs = Math.round(performance.now() - firstSearchStarted);
      expect(JSON.stringify(result)).toContain("mcp__refresh__new_feature");
      expect(recreated.session.getActiveToolNames()).toContain("mcp__refresh__new_feature");
      const output = await newTool!.execute("new-feature", {}, signal, undefined, context);
      expect(JSON.stringify(output)).toContain("new feature ready");
      if (process.env.KLAUS_MCP_MEASURE_FILE) {
        await appendFile(
          process.env.KLAUS_MCP_MEASURE_FILE,
          `${JSON.stringify({
            measurement: "pi-mcp-discovery-latency",
            catalogueDiscoveryMs,
            firstSearchMs,
          })}\n`,
        );
      }
    } finally {
      await first?.dispose();
      await recreated?.dispose();
      database.close();
    }
  }, 15_000);
});
