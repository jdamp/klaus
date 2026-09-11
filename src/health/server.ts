import { createServer, type Server, type ServerResponse } from "node:http";

import type { ComponentHealth, ServiceComponent } from "../app/lifecycle.js";

export type HealthSnapshot = {
  live: boolean;
  ready: boolean;
  integrations: Record<string, ComponentHealth>;
};

export class HealthServer implements ServiceComponent {
  readonly name = "health";
  #server?: Server;

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly snapshot: () => HealthSnapshot | Promise<HealthSnapshot>,
  ) {}

  start(): Promise<void> {
    this.#server = createServer((request, response) => {
      void this.#respond(request.url ?? "/", response);
    });
    return new Promise((resolve, reject) => {
      this.#server!.once("error", reject);
      this.#server!.listen(this.port, this.host, () => resolve());
    });
  }

  async #respond(path: string, response: ServerResponse): Promise<void> {
    const health = await this.snapshot();
    const status =
      path === "/live"
        ? health.live
          ? 200
          : 503
        : path === "/ready"
          ? health.ready
            ? 200
            : 503
          : 404;
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(path === "/live" ? { live: health.live } : health));
  }

  stop(): Promise<void> {
    if (!this.#server) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.#server!.close((error) => (error ? reject(error) : resolve()));
    });
  }

  health(): ComponentHealth {
    return { status: this.#server?.listening ? "healthy" : "unhealthy" };
  }

  address(): ReturnType<Server["address"]> {
    return this.#server?.address() ?? null;
  }
}
