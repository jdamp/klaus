export class KeyedQueue {
  readonly #tails = new Map<string, Promise<void>>();
  #closed = false;

  enqueue<T>(key: string, work: () => Promise<T>): Promise<T> {
    if (this.#closed) return Promise.reject(new Error("Queue is closed"));
    const previous = this.#tails.get(key) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(work);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.#tails.set(key, tail);
    void tail.finally(() => {
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    });
    return result;
  }

  async close(): Promise<void> {
    this.#closed = true;
    await Promise.all(this.#tails.values());
  }

  get size(): number {
    return this.#tails.size;
  }
}
