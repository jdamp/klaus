import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import type { ComponentHealth } from "../../app/lifecycle.js";
import { NativeToolExecutor } from "../../capabilities/execution.js";
import type { CapabilityProvider } from "../../capabilities/types.js";
import type { ToolAuditRepository } from "../../persistence/repositories.js";
import type { SecretRedactor } from "../../security/secrets.js";
import { MealieClient, type MealieConfig, type MealieFetch } from "./client.js";
import { organizerTools } from "./organizers/tools.js";
import { OrganizerService } from "./organizers/service.js";
import { recipeTools } from "./recipes/tools.js";
import { RecipeService } from "./recipes/service.js";
import { asRecord } from "./types.js";

export class MealieProvider implements CapabilityProvider {
  readonly id = "mealie";
  readonly #client: MealieClient;
  readonly #executor: NativeToolExecutor;
  readonly #tools: readonly ToolDefinition[];
  #state: ComponentHealth = { status: "degraded", detail: "Mealie has not been checked" };
  #incompatible = false;

  constructor(
    config: MealieConfig,
    apiKey: string,
    audits: ToolAuditRepository,
    redactor: SecretRedactor,
    fetcher?: MealieFetch,
  ) {
    redactor.add(apiKey);
    this.#client = new MealieClient(config, apiKey, fetcher);
    this.#executor = new NativeToolExecutor(
      audits,
      redactor,
      this.id,
      {
        timeoutMs: config.requestTimeoutMs,
        maxResultBytes: config.maxResultBytes,
      },
      (signal) => this.#ensureAvailable(signal),
    );
    this.#importTimeoutMs = config.importTimeoutMs;
    this.#tools = [
      ...recipeTools(new RecipeService(this.#client), this.#executor, this.#importTimeoutMs),
      ...organizerTools(new OrganizerService(this.#client), this.#executor),
    ];
  }

  #importTimeoutMs: number;

  async start(signal: AbortSignal): Promise<void> {
    await this.#refresh(signal);
  }

  async #ensureAvailable(signal: AbortSignal): Promise<void> {
    await this.#refresh(AbortSignal.any([signal, AbortSignal.timeout(10_000)]));
    if (this.#incompatible) {
      throw new Error("Mealie deployment is incompatible; upgrade to 3.23.0 or newer");
    }
    if (this.#state.status !== "healthy") {
      throw new Error(this.#state.detail ?? "Mealie is unavailable");
    }
  }

  async #refresh(signal: AbortSignal): Promise<void> {
    try {
      const about = await this.#client.about(signal);
      const version = versionOf(about);
      if (!version || compareVersion(version, [3, 23, 0]) < 0) {
        this.#incompatible = true;
        this.#state = {
          status: "degraded",
          detail: "Mealie version 3.23.0 or newer is required",
        };
      } else {
        this.#incompatible = false;
        this.#state = { status: "healthy" };
      }
    } catch (error) {
      this.#state = {
        status: "degraded",
        detail:
          error instanceof Error
            ? error.message.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
            : "Mealie is unavailable",
      };
    }
  }

  async stop(): Promise<void> {
    // fetch has no persistent connection owned by the provider.
  }

  health(): Record<string, ComponentHealth> {
    return { service: this.#state };
  }

  tools(): readonly ToolDefinition[] {
    return this.#tools;
  }

  get importTimeoutMs(): number {
    return this.#importTimeoutMs;
  }
}

function versionOf(value: unknown): number[] | undefined {
  const record = asRecord(value);
  const candidate = [record.version, record.versionNumber, record.appVersion].find(
    (entry) => typeof entry === "string" || typeof entry === "number",
  );
  if (typeof candidate !== "string" && typeof candidate !== "number") return undefined;
  const match = String(candidate).match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] : undefined;
}

function compareVersion(left: number[], right: number[]): number {
  for (let index = 0; index < right.length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}
