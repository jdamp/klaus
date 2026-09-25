import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { assertAbsoluteConfiguredPaths, parseConfig, publicConfig } from "../src/config.js";
import { readSecret, SecretRedactor } from "../src/security/secrets.js";

function validYaml(root: string): string {
  return `
telegram:
  tokenFile: ${root}/telegram-token
  allowedUsers: ["123", "456"]
  allowedChats: ["123", "456", "-100789"]
model:
  provider: openai-codex
  id: gpt-5.4
  reasoning: high
  authPath: ${root}/auth/auth.json
data:
  directory: ${root}/data
mcp:
  - id: home
    url: http://home-mcp.default.svc/mcp
    tokenFile: ${root}/mcp-token
skills:
  paths: [${root}/skills]
health:
  port: 8080
`;
}

describe("configuration and secrets", () => {
  it("loads valid security-sensitive settings and rejects omissions", () => {
    const config = parseConfig(validYaml("/tmp/klaus"));
    expect(config.telegram.allowedChats).toContain("-100789");
    expect(config.telegram.visualInput).toEqual({
      maxBytes: 10 * 1024 * 1024,
      downloadTimeoutMs: 15_000,
    });
    expect(config.mcp[0]?.id).toBe("home");
    expect(config.mcp[0]?.tools).toBeUndefined();
    expect(() => parseConfig("telegram: {}")).toThrow();
  });

  it("loads bounded optional image-generation settings without exposing provider details", () => {
    const config = parseConfig(
      validYaml("/tmp/klaus").replace(
        "data:",
        "imageGeneration:\n  backend:\n    type: openai-codex\n  promptMaxBytes: 2048\n  requestTimeoutMs: 60000\ndata:",
      ),
    );
    expect(config.imageGeneration).toMatchObject({
      backend: { type: "openai-codex" },
      promptMaxBytes: 2048,
      requestTimeoutMs: 60_000,
      maxResponseBytes: 16 * 1024 * 1024,
      maxImageBytes: 10 * 1024 * 1024,
    });
    expect(JSON.stringify(publicConfig(config))).not.toContain("authorization");
    expect(() =>
      parseConfig(
        validYaml("/tmp/klaus").replace(
          "data:",
          "imageGeneration:\n  backend:\n    type: other\ndata:",
        ),
      ),
    ).toThrow();
    expect(() =>
      parseConfig(
        validYaml("/tmp/klaus").replace(
          "data:",
          "imageGeneration:\n  backend:\n    type: openai-codex\n  maxImageBytes: 0\ndata:",
        ),
      ),
    ).toThrow();
  });

  it("rejects unsafe visual input limits", () => {
    const base = validYaml("/tmp/klaus").replace(
      '  allowedChats: ["123", "456", "-100789"]',
      '  allowedChats: ["123", "456", "-100789"]\n  visualInput:',
    );
    expect(() =>
      parseConfig(
        base.replace("  visualInput:\nmodel:", "  visualInput:\n    maxBytes: 0\nmodel:"),
      ),
    ).toThrow();
    expect(() =>
      parseConfig(
        base.replace(
          "  visualInput:\nmodel:",
          "  visualInput:\n    downloadTimeoutMs: 120001\nmodel:",
        ),
      ),
    ).toThrow();
  });

  it("normalizes an optional system prompt file and keeps its contents out of public config", () => {
    const config = parseConfig(
      validYaml("/tmp/klaus").replace(
        "data:",
        "agent:\n  systemPromptFile: prompts/AGENTS.md\ndata:",
      ),
    );

    expect(config.agent.systemPromptFile).toBe(join(process.cwd(), "prompts/AGENTS.md"));
    expect(() => assertAbsoluteConfiguredPaths(config)).not.toThrow();
    expect(JSON.stringify(publicConfig(config))).not.toContain("prompt contents");
  });

  it("distinguishes unrestricted, restricted, and disabled MCP tool exposure", () => {
    const unrestricted = parseConfig(validYaml("/tmp/klaus"));
    const restricted = parseConfig(
      validYaml("/tmp/klaus").replace("skills:", "    tools: [get_state, call_service]\nskills:"),
    );
    const disabled = parseConfig(
      validYaml("/tmp/klaus").replace("skills:", "    tools: []\nskills:"),
    );

    expect(unrestricted.mcp[0]?.tools).toBeUndefined();
    expect(restricted.mcp[0]?.tools).toEqual(["get_state", "call_service"]);
    expect(disabled.mcp[0]?.tools).toEqual([]);
  });

  it("supports a fixed stdio command with redacted secret environment files", () => {
    const source = validYaml("/tmp/klaus").replace(
      "    url: http://home-mcp.default.svc/mcp\n    tokenFile: /tmp/klaus/mcp-token",
      "    command: node\n    args: [server.js, serve]\n    env:\n      KANEO_API_URL: https://todo.mauzlab.de\n    secretEnv:\n      KANEO_API_KEY: /tmp/klaus/kaneo-key",
    );
    const config = parseConfig(source);
    expect(config.mcp[0]).toMatchObject({
      command: "node",
      args: ["server.js", "serve"],
      env: { KANEO_API_URL: "https://todo.mauzlab.de" },
      secretEnv: { KANEO_API_KEY: "/tmp/klaus/kaneo-key" },
    });
    expect(() => assertAbsoluteConfiguredPaths(config)).not.toThrow();
    const serialized = JSON.stringify(publicConfig(config));
    expect(serialized).toContain("[secret-file]");
    expect(serialized).not.toContain("kaneo-key");
  });

  it("rejects duplicate MCP ids, embedded credentials, and ambiguous stdio secrets", () => {
    const source = validYaml("/tmp/klaus").replace(
      "skills:",
      "  - id: home\n    url: https://user:pass@example.test/mcp\n    tools: [x]\nskills:",
    );
    expect(() => parseConfig(source)).toThrow();

    const ambiguous = validYaml("/tmp/klaus").replace(
      "    url: http://home-mcp.default.svc/mcp\n    tokenFile: /tmp/klaus/mcp-token",
      "    command: node\n    env:\n      KANEO_API_KEY: ordinary\n    secretEnv:\n      KANEO_API_KEY: /tmp/klaus/kaneo-key",
    );
    expect(() => parseConfig(ambiguous)).toThrow();
  });

  it("keeps secret locations and values out of public output", async () => {
    const root = await mkdtemp(join(tmpdir(), "klaus-secret-"));
    const tokenPath = join(root, "telegram-token");
    await writeFile(tokenPath, "very-secret-token\n");
    const secret = await readSecret(tokenPath);
    const redactor = new SecretRedactor();
    redactor.add(secret);
    const config = parseConfig(validYaml(root));

    const serialized = JSON.stringify(publicConfig(config));
    expect(serialized).not.toContain("telegram-token");
    expect(JSON.stringify(redactor.redact({ authorization: `Bearer ${secret}` }))).not.toContain(
      secret,
    );
  });
});
