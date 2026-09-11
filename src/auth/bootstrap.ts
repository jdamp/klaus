import { chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import type { AuthInteraction, AuthType } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

import type { AppConfig } from "../config.js";
import { createModelRuntime } from "../agent/pi-runtime.js";

type LoginRuntime = Pick<ModelRuntime, "login">;

export async function bootstrapProviderAuth(
  config: AppConfig["model"],
  type: AuthType,
  interaction: AuthInteraction,
  runtimeFactory: (config: AppConfig["model"]) => Promise<LoginRuntime> = createModelRuntime,
): Promise<void> {
  await mkdir(dirname(config.authPath), { recursive: true, mode: 0o700 });
  const runtime = await runtimeFactory(config);
  await runtime.login(config.provider, type, interaction);
  await chmod(config.authPath, 0o600);
}
