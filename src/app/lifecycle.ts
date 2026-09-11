export type ComponentHealth = {
  status: "healthy" | "degraded" | "unhealthy";
  detail?: string;
};

export interface ServiceComponent {
  readonly name: string;
  start(signal: AbortSignal): Promise<void>;
  stop(): Promise<void>;
  health?(): ComponentHealth | Promise<ComponentHealth>;
}

export class Application {
  readonly #components: readonly ServiceComponent[];
  readonly #controller = new AbortController();
  #started: ServiceComponent[] = [];
  #stopping?: Promise<void>;

  constructor(components: readonly ServiceComponent[]) {
    const names = new Set<string>();
    for (const component of components) {
      if (names.has(component.name)) {
        throw new Error(`Duplicate component name: ${component.name}`);
      }
      names.add(component.name);
    }
    this.#components = [...components];
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  async start(): Promise<void> {
    if (this.#started.length > 0) {
      throw new Error("Application is already started");
    }

    try {
      for (const component of this.#components) {
        await component.start(this.#controller.signal);
        this.#started.push(component);
      }
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  stop(): Promise<void> {
    this.#stopping ??= this.#stopOnce();
    return this.#stopping;
  }

  async #stopOnce(): Promise<void> {
    this.#controller.abort();
    const errors: unknown[] = [];

    for (const component of this.#started.reverse()) {
      try {
        await component.stop();
      } catch (error) {
        errors.push(error);
      }
    }
    this.#started = [];

    if (errors.length > 0) {
      throw new AggregateError(errors, "One or more components failed to stop");
    }
  }

  async health(): Promise<Record<string, ComponentHealth>> {
    const result: Record<string, ComponentHealth> = {};
    for (const component of this.#components) {
      result[component.name] = component.health ? await component.health() : { status: "healthy" };
    }
    return result;
  }
}
