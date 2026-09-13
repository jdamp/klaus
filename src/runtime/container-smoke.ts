import { constants } from "node:fs";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { parseConfig } from "../config.js";
import { HealthServer } from "../health/server.js";
import { AppDatabase } from "../persistence/database.js";

const configPath = process.argv[2];
if (!configPath) throw new Error("Missing smoke-test configuration path");
if (process.getuid?.() !== 1000) throw new Error("Runtime image is not executing as UID 1000");

try {
  await access("/app", constants.W_OK);
  throw new Error("Runtime application directory is unexpectedly writable");
} catch (error) {
  if (error instanceof Error && error.message.includes("unexpectedly writable")) throw error;
}

const config = parseConfig(await readFile(configPath, "utf8"));
await mkdir(dirname(config.model.authPath), { recursive: true });
const authProbe = join(dirname(config.model.authPath), ".write-probe");
await writeFile(authProbe, "ok", { mode: 0o600 });
await rm(authProbe);

const database = new AppDatabase(join(config.data.directory, "klaus.sqlite"));
database.migrate();
const health = new HealthServer(config.health.host, config.health.port, () => ({
  live: true,
  ready: true,
  integrations: { persistence: { status: "healthy" } },
}));

try {
  await health.start();
  const response = await fetch(`http://${config.health.host}:${config.health.port}/live`);
  if (!response.ok) throw new Error(`Health smoke test failed with HTTP ${response.status}`);
  const body = (await response.json()) as { live?: boolean };
  if (body.live !== true) throw new Error("Health smoke test did not report liveness");
} finally {
  await health.stop();
  database.close();
}
