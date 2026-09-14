import type { ManagedSession } from "./pi-runtime.js";

export type ModelPreference = { provider: string; modelId: string };

type SessionFactory = {
  create(sessionId: string, preferredModel?: ModelPreference): Promise<ManagedSession>;
};

export class SessionRegistry {
  readonly #cache = new Map<string, ManagedSession>();
  readonly #creating = new Map<string, Promise<ManagedSession>>();
  readonly #userCancellations = new Set<string>();

  constructor(
    private readonly factory: SessionFactory,
    private readonly maximum = 8,
  ) {}

  async get(sessionId: string, preferredModel?: ModelPreference): Promise<ManagedSession> {
    const existing = this.#cache.get(sessionId);
    if (existing) {
      this.#cache.delete(sessionId);
      this.#cache.set(sessionId, existing);
      return existing;
    }
    const inFlight = this.#creating.get(sessionId);
    if (inFlight) return inFlight;

    const creation = this.factory.create(sessionId, preferredModel).then((created) => {
      this.#cache.set(sessionId, created);
      while (this.#cache.size > this.maximum) {
        const oldest = this.#cache.entries().next().value;
        if (!oldest) break;
        oldest[1].dispose();
        this.#cache.delete(oldest[0]);
      }
      return created;
    });
    this.#creating.set(sessionId, creation);
    try {
      return await creation;
    } finally {
      this.#creating.delete(sessionId);
    }
  }

  peek(sessionId: string): ManagedSession | undefined {
    return this.#cache.get(sessionId);
  }

  async abortForUser(sessionId: string): Promise<boolean> {
    const managed = this.#cache.get(sessionId);
    if (!managed || managed.session.isIdle) return false;
    this.#userCancellations.add(sessionId);
    try {
      await managed.abort();
      return true;
    } catch (error) {
      this.#userCancellations.delete(sessionId);
      throw error;
    }
  }

  consumeUserCancellation(sessionId: string): boolean {
    return this.#userCancellations.delete(sessionId);
  }

  dispose(): void {
    for (const session of this.#cache.values()) session.dispose();
    this.#cache.clear();
    this.#creating.clear();
    this.#userCancellations.clear();
  }

  async abortAll(): Promise<void> {
    await Promise.allSettled([...this.#cache.values()].map((session) => session.abort()));
  }
}
