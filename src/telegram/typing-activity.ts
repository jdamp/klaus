export interface ChatActionSender {
  sendChatAction(chatId: string, action: "typing", signal?: AbortSignal): Promise<void>;
}

function waitForAbortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
  });
}

function settleOrAbort(operation: Promise<unknown>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      signal.removeEventListener("abort", finish);
      resolve();
    };
    signal.addEventListener("abort", finish, { once: true });
    void operation.then(finish, finish);
  });
}

export class TelegramTypingActivity {
  constructor(
    private readonly sender: ChatActionSender,
    private readonly refreshMilliseconds = 4_000,
  ) {
    if (refreshMilliseconds < 1) throw new Error("Typing refresh interval must be positive");
  }

  async run<T>(chatId: string, work: () => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const refresh = this.#refresh(chatId, controller.signal);
    try {
      return await work();
    } finally {
      controller.abort();
      await refresh;
    }
  }

  async #refresh(chatId: string, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let publication: Promise<void>;
      try {
        publication = this.sender.sendChatAction(chatId, "typing", signal);
      } catch {
        publication = Promise.resolve();
      }
      await settleOrAbort(publication, signal);
      if (!signal.aborted) await waitForAbortableDelay(this.refreshMilliseconds, signal);
    }
  }
}
