import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import type { ComponentHealth } from "../app/lifecycle.js";
import type {
  CapabilityBinding,
  CapabilityCatalog as CapabilityCatalogContract,
  CapabilityProvider,
} from "./types.js";

export class AgentToolCatalog implements CapabilityCatalogContract {
  readonly #providers: readonly CapabilityProvider[];

  constructor(providers: readonly CapabilityProvider[]) {
    const ids = new Set<string>();
    for (const provider of providers) {
      if (ids.has(provider.id)) throw new Error(`Duplicate capability provider: ${provider.id}`);
      ids.add(provider.id);
    }
    this.#providers = [...providers];
  }

  async start(signal: AbortSignal): Promise<void> {
    for (const provider of this.#providers) await provider.start(signal);
  }

  async stop(): Promise<void> {
    await Promise.allSettled([...this.#providers].reverse().map((provider) => provider.stop()));
  }

  health(): Record<string, ComponentHealth> {
    const result: Record<string, ComponentHealth> = {};
    for (const provider of this.#providers) {
      const providerHealth = provider.health();
      const states = Object.values(providerHealth);
      const degraded = states.find((state) => state.status === "degraded");
      const unhealthy = states.find((state) => state.status === "unhealthy");
      result[provider.id] = unhealthy ?? degraded ?? { status: "healthy" };
      for (const [name, state] of Object.entries(providerHealth)) {
        result[`${provider.id}.${name}`] = state;
      }
    }
    return result;
  }

  tools(binding?: CapabilityBinding): ToolDefinition[] {
    const tools = this.#providers.flatMap((provider) => [...provider.tools(binding)]);
    const names = new Set<string>();
    for (const tool of tools) {
      if (names.has(tool.name)) throw new Error(`Duplicate capability tool: ${tool.name}`);
      names.add(tool.name);
    }
    return tools;
  }
}

export type { CapabilityBinding, CapabilityProvider } from "./types.js";
