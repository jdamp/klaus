import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import type { AuthEvent, AuthInteraction, AuthPrompt, AuthType } from "@earendil-works/pi-ai";

import { bootstrapProviderAuth } from "./auth/bootstrap.js";
import { parseConfig } from "./config.js";
import { buildApplication } from "./runtime/application.js";

function argument(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function interaction(): { auth: AuthInteraction; close: () => void } {
  const terminal = createInterface({ input: stdin, output: stdout });
  const prompt = async (request: AuthPrompt): Promise<string> => {
    if (request.type === "select") {
      stdout.write(
        request.options.map((option) => `${option.id}: ${option.label}`).join("\n") + "\n",
      );
    }
    return terminal.question(`${request.message} `);
  };
  const notify = (event: AuthEvent): void => {
    if (event.type === "auth_url") stdout.write(`${event.instructions ?? "Open"}: ${event.url}\n`);
    else if (event.type === "device_code")
      stdout.write(`Open ${event.verificationUri} and enter ${event.userCode}\n`);
    else stdout.write(`${event.message}\n`);
  };
  return { auth: { prompt, notify }, close: () => terminal.close() };
}

async function main(): Promise<void> {
  const configPath = argument("--config", "config.yaml")!;
  if (process.argv[2] === "auth" && process.argv[3] === "login") {
    const config = parseConfig(await readFile(configPath, "utf8"));
    const type = (argument("--type", "oauth") ?? "oauth") as AuthType;
    const consoleInteraction = interaction();
    try {
      await bootstrapProviderAuth(config.model, type, consoleInteraction.auth);
      stdout.write(`Authentication stored at ${config.model.authPath}\n`);
    } finally {
      consoleInteraction.close();
    }
    return;
  }

  const built = await buildApplication(configPath);
  const shutdown = async (): Promise<void> => {
    built.logger.log("info", "runtime.stopping");
    await built.application.stop();
    built.logger.log("info", "runtime.stopped");
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
  await built.application.start();
  built.logger.log("info", "runtime.started", {
    provider: built.config.model.provider,
    mcpServers: built.config.mcp.map((server) => server.id),
  });
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Fatal startup error");
  process.exitCode = 1;
});
