import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { bootstrapProviderAuth } from "../src/auth/bootstrap.js";
import { parseConfig } from "../src/config.js";

describe("Pi provider authentication bootstrap", () => {
  it("delegates OAuth to Pi and preserves protected writable state", async () => {
    const root = await mkdtemp(join(tmpdir(), "klaus-auth-"));
    const config = parseConfig(`
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
skills: { paths: [] }
health: {}
`);
    let loginType = "";
    await bootstrapProviderAuth(
      config.model,
      "oauth",
      { prompt: async () => "", notify: () => undefined },
      async () => ({
        login: async (_provider, type) => {
          loginType = type;
          await writeFile(config.model.authPath, JSON.stringify({ refreshed: true }));
          return { type: "oauth", access: "secret", refresh: "secret", expires: Date.now() };
        },
      }),
    );

    expect(loginType).toBe("oauth");
    expect(JSON.parse(await readFile(config.model.authPath, "utf8"))).toEqual({ refreshed: true });
    expect((await stat(config.model.authPath)).mode & 0o077).toBe(0);
  });

  it("delegates API-key provider setup without parsing credentials", async () => {
    const root = await mkdtemp(join(tmpdir(), "klaus-api-key-"));
    const config = parseConfig(`
telegram: { tokenFile: ${root}/telegram, allowedUsers: ["1"], allowedChats: ["1"] }
model: { provider: anthropic, id: claude, authPath: ${root}/auth/auth.json }
data: { directory: ${root}/data }
mcp: []
skills: { paths: [] }
health: {}
`);
    let delegated = false;
    await bootstrapProviderAuth(
      config.model,
      "api_key",
      { prompt: async () => "provider-owned-value", notify: () => undefined },
      async () => ({
        login: async () => {
          delegated = true;
          await writeFile(config.model.authPath, "{}");
          return { type: "api_key", key: "provider-owned-value" };
        },
      }),
    );
    expect(delegated).toBe(true);
  });
});
