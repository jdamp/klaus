import type { ServiceComponent } from "../app/lifecycle.js";
import type { OutboxRepository } from "../persistence/repositories.js";
import type { TelegramInlineKeyboardMarkup, TelegramParseMode } from "../telegram/types.js";

export interface MessageSender {
  sendMessage(
    chatId: string,
    text: string,
    replyToMessageId?: string,
    signal?: AbortSignal,
    replyMarkup?: TelegramInlineKeyboardMarkup,
    parseMode?: TelegramParseMode,
  ): Promise<string>;
}

export class OutboxWorker implements ServiceComponent {
  readonly name = "delivery";
  #controller?: AbortController;
  #loop?: Promise<void>;
  #lastError: string | undefined;

  constructor(
    private readonly outbox: OutboxRepository,
    private readonly sender: MessageSender,
    private readonly pollMs = 250,
    private readonly leaseMs = 30_000,
  ) {}

  start(signal: AbortSignal): Promise<void> {
    this.#controller = new AbortController();
    signal.addEventListener("abort", () => this.#controller?.abort(), { once: true });
    this.#loop = this.#run(this.#controller.signal);
    return Promise.resolve();
  }

  async runOnce(now = new Date(), signal?: AbortSignal): Promise<boolean> {
    const message = this.outbox.lease(now, this.leaseMs);
    if (!message) return false;
    try {
      const sentId = await this.sender.sendMessage(
        message.chatId,
        message.text,
        message.replyToMessageId,
        signal,
        message.replyMarkup,
        message.parseMode,
      );
      this.outbox.sent(message.id, sentId);
      this.#lastError = undefined;
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Delivery failed";
      this.#lastError = detail;
      const delay = Math.min(60_000, 1_000 * 2 ** Math.min(message.attempts - 1, 6));
      this.outbox.retry(message.id, new Date(now.getTime() + delay), detail);
    }
    return true;
  }

  async #run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const worked = await this.runOnce(new Date(), signal);
      if (!worked) await new Promise((resolve) => setTimeout(resolve, this.pollMs));
    }
  }

  async stop(): Promise<void> {
    this.#controller?.abort();
    await this.#loop;
  }

  health() {
    return this.#lastError
      ? ({ status: "degraded", detail: this.#lastError } as const)
      : ({ status: "healthy" } as const);
  }
}
