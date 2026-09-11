import type { ManagedSession, PiSessionFactory } from "./pi-runtime.js";

export class SessionRegistry {
  readonly #cache = new Map<string, ManagedSession>();

  constructor(
    private readonly factory: Pick<PiSessionFactory, "create">,
    private readonly maximum = 8,
  ) {}

  async get(sessionId: string): Promise<ManagedSession> {
    const existing = this.#cache.get(sessionId);
    if (existing) {
      this.#cache.delete(sessionId);
      this.#cache.set(sessionId, existing);
      return existing;
    }
    const created = await this.factory.create(sessionId);
    this.#cache.set(sessionId, created);
    while (this.#cache.size > this.maximum) {
      const oldest = this.#cache.entries().next().value;
      if (!oldest) break;
      oldest[1].dispose();
      this.#cache.delete(oldest[0]);
    }
    return created;
  }

  dispose(): void {
    for (const session of this.#cache.values()) session.dispose();
    this.#cache.clear();
  }

  async abortAll(): Promise<void> {
    await Promise.allSettled([...this.#cache.values()].map((session) => session.abort()));
  }
}
