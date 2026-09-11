import { describe, expect, it } from "vitest";

import { composeApplication } from "../../src/app/compose.js";
import type { ApplicationServices } from "../../src/app/contracts.js";
import type { ServiceComponent } from "../../src/app/lifecycle.js";

function component(name: string, events: string[]): ServiceComponent {
  return {
    name,
    start(signal) {
      expect(signal.aborted).toBe(false);
      events.push(`start:${name}`);
      return Promise.resolve();
    },
    stop() {
      events.push(`stop:${name}`);
      return Promise.resolve();
    },
  };
}

describe("application composition", () => {
  it("starts in dependency order and stops in reverse order", async () => {
    const events: string[] = [];
    const services = {
      persistence: component("persistence", events),
      sessions: component("sessions", events),
      capabilities: component("capabilities", events),
      delivery: component("delivery", events),
      telegram: component("telegram", events),
      health: component("health", events),
    } satisfies ApplicationServices;

    const application = composeApplication(services);
    await application.start();
    await application.stop();

    expect(events).toEqual([
      "start:persistence",
      "start:sessions",
      "start:capabilities",
      "start:delivery",
      "start:telegram",
      "start:health",
      "stop:health",
      "stop:telegram",
      "stop:delivery",
      "stop:capabilities",
      "stop:sessions",
      "stop:persistence",
    ]);
  });

  it("rolls back already-started components after a startup failure", async () => {
    const events: string[] = [];
    const failing = component("sessions", events);
    failing.start = () => {
      events.push("start:sessions");
      return Promise.reject(new Error("boom"));
    };

    const services = {
      persistence: component("persistence", events),
      sessions: failing,
      capabilities: component("capabilities", events),
      delivery: component("delivery", events),
      telegram: component("telegram", events),
      health: component("health", events),
    } satisfies ApplicationServices;

    const application = composeApplication(services);
    await expect(application.start()).rejects.toThrow("boom");
    expect(events).toEqual(["start:persistence", "start:sessions", "stop:persistence"]);
  });
});
