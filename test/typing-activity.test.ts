import { afterEach, describe, expect, it, vi } from "vitest";

import { TelegramTypingActivity } from "../src/telegram/typing-activity.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((success, failure) => {
    resolve = success;
    reject = failure;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Telegram typing activity", () => {
  it("publishes immediately, refreshes sequentially, and stops after fulfillment", async () => {
    vi.useFakeTimers();
    const firstPublication = deferred();
    const work = deferred<string>();
    const calls: Array<{ chatId: string; action: string; signal?: AbortSignal }> = [];
    const activity = new TelegramTypingActivity(
      {
        sendChatAction: (chatId, action, signal) => {
          calls.push({ chatId, action, ...(signal ? { signal } : {}) });
          return calls.length === 1 ? firstPublication.promise : Promise.resolve();
        },
      },
      4_000,
    );

    const result = activity.run("10", () => work.promise);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ chatId: "10", action: "typing" });

    await vi.advanceTimersByTimeAsync(8_000);
    expect(calls).toHaveLength(1);

    firstPublication.resolve();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(calls).toHaveLength(2);

    work.resolve("done");
    await expect(result).resolves.toBe("done");
    expect(calls[1]?.signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(calls).toHaveLength(2);
  });

  it("preserves rejection and stops refreshing after failed work", async () => {
    vi.useFakeTimers();
    const activity = new TelegramTypingActivity({
      sendChatAction: async () => undefined,
    });

    await expect(
      activity.run("10", async () => {
        throw new Error("turn failed");
      }),
    ).rejects.toThrow("turn failed");

    await vi.advanceTimersByTimeAsync(8_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("isolates rejected and synchronously thrown publications from work", async () => {
    let calls = 0;
    const rejected = new TelegramTypingActivity({
      sendChatAction: async () => {
        calls += 1;
        throw new Error("Telegram unavailable");
      },
    });
    await expect(rejected.run("10", async () => "ok")).resolves.toBe("ok");

    const thrown = new TelegramTypingActivity({
      sendChatAction: () => {
        calls += 1;
        throw new Error("synchronous fake failure");
      },
    });
    await expect(thrown.run("10", async () => "still ok")).resolves.toBe("still ok");
    expect(calls).toBe(2);
  });

  it("aborts a hanging publication without changing the work outcome", async () => {
    let actionSignal: AbortSignal | undefined;
    const activity = new TelegramTypingActivity({
      sendChatAction: async (_chatId, _action, signal) => {
        actionSignal = signal;
        await new Promise(() => undefined);
      },
    });

    await expect(activity.run("10", async () => "done")).resolves.toBe("done");
    expect(actionSignal?.aborted).toBe(true);
  });
});
