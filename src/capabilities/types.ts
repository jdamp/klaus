import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import type { ComponentHealth } from "../app/lifecycle.js";

export type CapabilityBinding = {
  sessionId?: string;
  signal?: AbortSignal;
};

export interface CapabilityProvider {
  readonly id: string;
  start(signal: AbortSignal): Promise<void>;
  stop(): Promise<void>;
  health(): Record<string, ComponentHealth>;
  tools(binding?: CapabilityBinding): readonly ToolDefinition[];
}

export interface CapabilityCatalog {
  start(signal: AbortSignal): Promise<void>;
  stop(): Promise<void>;
  health(): Record<string, ComponentHealth>;
  tools(binding?: CapabilityBinding): ToolDefinition[];
}
