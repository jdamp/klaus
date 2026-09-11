import type { ServiceComponent } from "./lifecycle.js";

export type TelegramService = ServiceComponent;
export type SessionService = ServiceComponent;
export type CapabilityService = ServiceComponent;
export type PersistenceService = ServiceComponent;
export type DeliveryService = ServiceComponent;
export type HealthService = ServiceComponent;

export type ApplicationServices = {
  persistence: PersistenceService;
  sessions: SessionService;
  capabilities: CapabilityService;
  delivery: DeliveryService;
  telegram: TelegramService;
  health: HealthService;
};
