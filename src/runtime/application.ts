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
import { PiMcpConnectionRegistry, PiMcpHealthRegistry } from "../mcp/pi-adapter.js";
import { AgentToolCatalog } from "../capabilities/catalog.js";
import type { CapabilityProvider } from "../capabilities/types.js";
import { MealieProvider } from "../integrations/mealie/provider.js";
import { PaperlessProvider } from "../integrations/paperless/provider.js";
import { PaperlessUploadReceiptRepository } from "../integrations/paperless/receipts.js";
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
import { TelegramUploadFileLoader } from "../telegram/upload-file.js";
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
  let mealieKey: string | undefined;
  if (config.mealie) {
    try {
      mealieKey = await readSecret(config.mealie.apiKeyFile);
    } catch (error) {
      throw new Error("Unable to read configured Mealie API key file", { cause: error });
    }
  }
  redactor.add(mealieKey);
  let paperlessToken: string | undefined;
  if (config.paperless) {
    try {
      paperlessToken = await readSecret(config.paperless.apiTokenFile);
    } catch {
      throw new Error("Unable to read configured Paperless API token file");
    }
  }
  redactor.add(paperlessToken);
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
  const paperlessReceipts = new PaperlessUploadReceiptRepository(database);
  const api = new TelegramHttpClient(telegramToken);
  const paperlessUploadFileLoader = config.paperless
    ? new TelegramUploadFileLoader(
        api,
        config.paperless.maxUploadBytes,
        config.paperless.downloadTimeoutMs,
      )
    : undefined;
  const outbox = new OutboxRepository(database, config.imageGeneration?.maxImageBytes);
  const turnContexts = new TurnContextRegistry();
  const memoryRepository = new MemoryRepository(database, config.memory);
  const memoryContexts = new MemoryTurnContextRegistry();
  const mcpHealth = new PiMcpHealthRegistry();
  const mcpConnections = new PiMcpConnectionRegistry();
  const memory = new MemoryProvider(memoryRepository, memoryContexts, audits, redactor);
  const providers: CapabilityProvider[] = [memory];
  if (config.mealie && mealieKey) {
    providers.push(new MealieProvider(config.mealie, mealieKey, audits, redactor));
  }
  if (config.paperless && paperlessToken) {
    providers.push(
      new PaperlessProvider(
        config.paperless,
        paperlessToken,
        audits,
        redactor,
        turnContexts,
        new Set(config.telegram.allowedChats),
        new Set(config.telegram.allowedUsers),
        undefined,
        paperlessReceipts,
        paperlessUploadFileLoader,
      ),
    );
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
    { audits, redactor, health: mcpHealth, connections: mcpConnections },
  );
  const chats = new ChatRepository(database);
  const delivery = new OutboxWorker(outbox, api);
  const queue = new KeyedQueue();
  const commands = new TelegramCommandHandler(chats, outbox, sessions, memoryRepository);
  const router = new TelegramRouter(
    {
      allowedUsers: new Set(config.telegram.allowedUsers),
      allowedChats: new Set(config.telegram.allowedChats),
      paperlessEnabled: config.paperless !== undefined,
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
    const integrations = {
      ...(await applicationReference.current.health()),
      ...mcpHealth.snapshot(config.mcp.map((server) => server.id)),
    };
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
