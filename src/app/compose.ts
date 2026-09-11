import type { ApplicationServices } from "./contracts.js";
import { Application } from "./lifecycle.js";

export function composeApplication(services: ApplicationServices): Application {
  return new Application([
    services.persistence,
    services.capabilities,
    services.sessions,
    services.delivery,
    services.telegram,
    services.health,
  ]);
}
