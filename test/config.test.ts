import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseConfig, publicConfig } from "../src/config.js";
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
    tools: [get_state, call_service]
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
    expect(config.mcp[0]?.id).toBe("home");
    expect(() => parseConfig("telegram: {}")).toThrow();
  });

  it("rejects duplicate MCP ids and embedded credentials", () => {
    const source = validYaml("/tmp/klaus").replace(
      "skills:",
      "  - id: home\n    url: https://user:pass@example.test/mcp\n    tools: [x]\nskills:",
    );
    expect(() => parseConfig(source)).toThrow();
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
