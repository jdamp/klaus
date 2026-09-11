import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { createModelRuntime, providerReady } from "../agent/pi-runtime.js";
import { composeApplication } from "../app/compose.js";
import type { Application } from "../app/lifecycle.js";
import { parseConfig } from "../config.js";
import { OutboxWorker } from "../delivery/outbox-worker.js";
import { KeyedQueue } from "../dispatch/keyed-queue.js";
import { HealthServer } from "../health/server.js";
import { McpRegistry } from "../mcp/registry.js";
import { AppDatabase } from "../persistence/database.js";
import {
  ChatRepository,
  OutboxRepository,
  StateRepository,
  ToolAuditRepository,
  UpdateRepository,
} from "../persistence/repositories.js";
import { SecretRedactor, readSecret } from "../security/secrets.js";
import { Logger } from "../observability/logger.js";
import { TelegramHttpClient } from "../telegram/client.js";
import { TelegramPoller } from "../telegram/poller.js";
import { TelegramRouter } from "../telegram/router.js";
import {
  CapabilityComponent,
  PersistenceComponent,
  SessionComponent,
  TelegramRuntimeComponent,
} from "./services.js";

export type BuiltApplication = {
  application: Application;
  config: ReturnType<typeof parseConfig>;
  health: HealthServer;
  logger: Logger;
};

export async function buildApplication(configPath: string): Promise<BuiltApplication> {
  const config = parseConfig(await readFile(configPath, "utf8"));
  const telegramToken = await readSecret(config.telegram.tokenFile);
  const redactor = new SecretRedactor();
  redactor.add(telegramToken);
  for (const server of config.mcp) {
    if (server.tokenFile) redactor.add(await readSecret(server.tokenFile));
  }
  const logger = new Logger(redactor);

  const database = new AppDatabase(join(config.data.directory, "klaus.sqlite"));
  const persistence = new PersistenceComponent(database);
  const runtime = await createModelRuntime(config.model);
  if (!(await providerReady(runtime, config.model.provider))) {
    database.close();
    throw new Error(
      `Model provider ${config.model.provider} is not authenticated; run the auth login command`,
    );
  }

  const mcp = new McpRegistry(config.mcp, new ToolAuditRepository(database), undefined, redactor);
  const capabilities = new CapabilityComponent(mcp);
  const sessions = new SessionComponent(config, runtime, database, mcp);
  const api = new TelegramHttpClient(telegramToken);
  const delivery = new OutboxWorker(new OutboxRepository(database), api);
  const queue = new KeyedQueue();
  const router = new TelegramRouter(
    {
      allowedUsers: new Set(config.telegram.allowedUsers),
      allowedChats: new Set(config.telegram.allowedChats),
    },
    new UpdateRepository(database),
    new ChatRepository(database),
    queue,
    (input, sessionId) => sessions.handle(input, sessionId),
  );
  const poller = new TelegramPoller(
    api,
    new StateRepository(database),
    config.telegram.pollingTimeoutSeconds,
    (update, bot) => router.route(update, bot).then(() => undefined),
  );
  const telegram = new TelegramRuntimeComponent(poller, queue);
  const applicationReference: { current?: Application } = {};
  const health = new HealthServer(config.health.host, config.health.port, async () => {
    if (!applicationReference.current) {
      return { live: true, ready: false, integrations: {} };
    }
    const integrations = await applicationReference.current.health();
    const core = ["persistence", "sessions", "delivery", "telegram"];
    return {
      live: true,
      ready: core.every((name) => integrations[name]?.status === "healthy"),
      integrations,
    };
  });
  const application = composeApplication({
    persistence,
    capabilities,
    sessions,
    delivery,
    telegram,
    health,
  });
  applicationReference.current = application;

  return { application, config, health, logger };
}
