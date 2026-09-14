import type { StateRepository } from "../persistence/repositories.js";
import type { ServiceComponent } from "../app/lifecycle.js";
import { TELEGRAM_COMMANDS } from "./commands.js";
import type { TelegramApi, TelegramBotCommandScope } from "./client.js";
import type { BotIdentity, TelegramUpdate } from "./types.js";

export class TelegramPoller implements ServiceComponent {
  readonly name = "telegram";
  #controller?: AbortController;
  #loop?: Promise<void>;
  #identity?: BotIdentity;
  #failure: string | undefined;

  constructor(
    private readonly api: TelegramApi,
    private readonly state: StateRepository,
    private readonly timeoutSeconds: number,
    private readonly onUpdate: (update: TelegramUpdate, bot: BotIdentity) => Promise<void>,
  ) {}

  get identity(): BotIdentity | undefined {
    return this.#identity;
  }

  async start(signal: AbortSignal): Promise<void> {
    this.#identity = await this.api.getMe(signal);
    const scopes: TelegramBotCommandScope[] = [
      { type: "default" },
      { type: "all_private_chats" },
      { type: "all_group_chats" },
    ];
    for (const scope of scopes) {
      await this.api.setMyCommands(
        TELEGRAM_COMMANDS.map(({ name, description }) => ({ command: name, description })),
        scope,
        signal,
      );
    }
    this.#controller = new AbortController();
    signal.addEventListener("abort", () => this.#controller?.abort(), { once: true });
    this.#loop = this.#run(this.#controller.signal);
  }

  async pollOnce(signal?: AbortSignal): Promise<number> {
    if (!this.#identity) this.#identity = await this.api.getMe(signal);
    const offset = Number(this.state.get("telegram.offset") ?? "0");
    const updates = await this.api.getUpdates(offset, this.timeoutSeconds, signal);
    for (const update of updates) {
      await this.onUpdate(update, this.#identity);
      this.state.set("telegram.offset", String(update.update_id + 1));
    }
    return updates.length;
  }

  async #run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.pollOnce(signal);
        this.#failure = undefined;
      } catch (error) {
        if (signal.aborted) return;
        this.#failure = error instanceof Error ? error.message : "Telegram polling failed";
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
  }

  async stop(): Promise<void> {
    this.#controller?.abort();
    await this.#loop;
  }

  health() {
    return this.#failure
      ? ({ status: "unhealthy", detail: this.#failure } as const)
      : ({ status: this.#identity ? "healthy" : "unhealthy" } as const);
  }
}
