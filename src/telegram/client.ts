import type { BotIdentity, TelegramUpdate } from "./types.js";

type TelegramEnvelope<T> = { ok: true; result: T } | { ok: false; description?: string };

export interface TelegramApi {
  getMe(signal?: AbortSignal): Promise<BotIdentity>;
  getUpdates(
    offset: number,
    timeoutSeconds: number,
    signal?: AbortSignal,
  ): Promise<TelegramUpdate[]>;
  sendMessage(
    chatId: string,
    text: string,
    replyToMessageId?: string,
    signal?: AbortSignal,
  ): Promise<string>;
  sendChatAction(chatId: string, action: "typing", signal?: AbortSignal): Promise<void>;
}

export class TelegramHttpClient implements TelegramApi {
  constructor(
    private readonly token: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async #call<T>(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const response = await this.fetcher(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) throw new Error(`Telegram ${method} failed with HTTP ${response.status}`);
    const envelope = (await response.json()) as TelegramEnvelope<T>;
    if (!envelope.ok)
      throw new Error(`Telegram ${method} failed: ${envelope.description ?? "unknown"}`);
    return envelope.result;
  }

  async getMe(signal?: AbortSignal): Promise<BotIdentity> {
    const user = await this.#call<{ id: number; username?: string }>("getMe", {}, signal);
    if (!user.username) throw new Error("Telegram bot has no username");
    return { id: user.id.toString(), username: user.username };
  }

  getUpdates(
    offset: number,
    timeoutSeconds: number,
    signal?: AbortSignal,
  ): Promise<TelegramUpdate[]> {
    return this.#call(
      "getUpdates",
      { offset, timeout: timeoutSeconds, allowed_updates: ["message"] },
      signal,
    );
  }

  async sendChatAction(chatId: string, action: "typing", signal?: AbortSignal): Promise<void> {
    await this.#call<boolean>("sendChatAction", { chat_id: chatId, action }, signal);
  }

  async sendMessage(
    chatId: string,
    text: string,
    replyToMessageId?: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const result = await this.#call<{ message_id: number }>(
      "sendMessage",
      {
        chat_id: chatId,
        text,
        ...(replyToMessageId ? { reply_parameters: { message_id: replyToMessageId } } : {}),
      },
      signal,
    );
    return result.message_id.toString();
  }
}
