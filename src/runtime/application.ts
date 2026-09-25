import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  createModelRuntime,
  loadHouseholdSystemPrompt,
  providerReady,
} from "../agent/pi-runtime.js";
import { composeApplication } from "../app/compose.js";
import type { Application } from "../app/lifecycle.js";
import { parseConfig } from "../config.js";
import { OutboxWorker } from "../delivery/outbox-worker.js";
import { KeyedQueue } from "../dispatch/keyed-queue.js";
import { HealthServer } from "../health/server.js";
import { McpRegistry } from "../mcp/registry.js";
import { AgentToolCatalog } from "../capabilities/catalog.js";
import { MealieProvider } from "../integrations/mealie/provider.js";
import { TurnContextRegistry } from "../agent/turn-context.js";
import { CodexImageGenerator } from "../image-generation/codex.js";
import { ImageGenerationProvider } from "../image-generation/provider.js";
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
import { MemoryTurnContextRegistry } from "../memory/context.js";
import { MemoryProvider } from "../memory/provider.js";
import { MemoryRepository } from "../memory/repository.js";
import { TelegramHttpClient } from "../telegram/client.js";
import { TelegramCommandHandler } from "../telegram/command-handler.js";
import { TelegramPoller } from "../telegram/poller.js";
import { TelegramRouter } from "../telegram/router.js";
import { TelegramTypingActivity } from "../telegram/typing-activity.js";
import { TelegramVisualInputLoader } from "../telegram/visual-input.js";
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
  const systemPrompt = await loadHouseholdSystemPrompt(config);
  const telegramToken = await readSecret(config.telegram.tokenFile);
  const redactor = new SecretRedactor();
  redactor.add(telegramToken);
  for (const server of config.mcp) {
    if ("url" in server && server.tokenFile) {
      redactor.add(await readSecret(server.tokenFile));
    } else if ("secretEnv" in server) {
      for (const path of Object.values(server.secretEnv)) {
        redactor.add(await readSecret(path));
      }
    }
  }
  let mealieKey: string | undefined;
  if (config.mealie) {
    try {
      mealieKey = await readSecret(config.mealie.apiKeyFile);
    } catch (error) {
      throw new Error("Unable to read configured Mealie API key file", { cause: error });
    }
  }
  redactor.add(mealieKey);
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

  const audits = new ToolAuditRepository(database);
  const outbox = new OutboxRepository(database, config.imageGeneration?.maxImageBytes);
  const turnContexts = new TurnContextRegistry();
  const memoryRepository = new MemoryRepository(database, config.memory);
  const memoryContexts = new MemoryTurnContextRegistry();
  const memory = new MemoryProvider(memoryRepository, memoryContexts, audits, redactor);
  const mcp = new McpRegistry(config.mcp, audits, undefined, redactor);
  const providers = [memory, mcp] as Array<
    MemoryProvider | McpRegistry | MealieProvider | ImageGenerationProvider
  >;
  if (config.mealie && mealieKey) {
    providers.push(new MealieProvider(config.mealie, mealieKey, audits, redactor));
  }
  if (config.imageGeneration) {
    const generator = new CodexImageGenerator(runtime, config.imageGeneration);
    providers.push(
      new ImageGenerationProvider(
        generator,
        outbox,
        audits,
        turnContexts,
        config.imageGeneration.promptMaxBytes,
        config.imageGeneration.maxImageBytes,
        redactor,
      ),
    );
  }
  const catalog = new AgentToolCatalog(providers);
  const capabilities = new CapabilityComponent(catalog);
  const api = new TelegramHttpClient(telegramToken);
  const visualInput = new TelegramVisualInputLoader(
    api,
    config.telegram.visualInput.maxBytes,
    config.telegram.visualInput.downloadTimeoutMs,
  );
  const sessions = new SessionComponent(
    config,
    runtime,
    database,
    catalog,
    systemPrompt,
    {
      repository: memoryRepository,
      contexts: memoryContexts,
    },
    visualInput,
    turnContexts,
  );
  const chats = new ChatRepository(database);
  const delivery = new OutboxWorker(outbox, api);
  const queue = new KeyedQueue();
  const commands = new TelegramCommandHandler(chats, outbox, sessions, memoryRepository);
  const router = new TelegramRouter(
    {
      allowedUsers: new Set(config.telegram.allowedUsers),
      allowedChats: new Set(config.telegram.allowedChats),
    },
    new UpdateRepository(database),
    chats,
    queue,
    new TelegramTypingActivity(api),
    (input, sessionId) => sessions.handle(input, sessionId),
    commands,
    (callbackQueryId) => api.answerCallbackQuery(callbackQueryId),
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
