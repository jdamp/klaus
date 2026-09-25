import type {
  BotIdentity,
  TelegramInlineKeyboardMarkup,
  TelegramParseMode,
  TelegramUpdate,
} from "./types.js";
import { validateGeneratedImage } from "../image-generation/types.js";

export type TelegramFile = { file_path: string; file_size?: number };

export type TelegramBotCommand = { command: string; description: string };
export type TelegramBotCommandScope =
  { type: "default" } | { type: "all_private_chats" } | { type: "all_group_chats" };

type TelegramEnvelope<T> = { ok: true; result: T } | { ok: false; description?: string };

export interface TelegramApi {
  getMe(signal?: AbortSignal): Promise<BotIdentity>;
  setMyCommands(
    commands: readonly TelegramBotCommand[],
    scope: TelegramBotCommandScope,
    signal?: AbortSignal,
  ): Promise<void>;
  getUpdates(
    offset: number,
    timeoutSeconds: number,
    signal?: AbortSignal,
  ): Promise<TelegramUpdate[]>;
  getFile?(fileId: string, signal?: AbortSignal): Promise<TelegramFile>;
  downloadFile?(
    filePath: string,
    maxBytes: number,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Uint8Array>;
  sendMessage(
    chatId: string,
    text: string,
    replyToMessageId?: string,
    signal?: AbortSignal,
    replyMarkup?: TelegramInlineKeyboardMarkup,
    parseMode?: TelegramParseMode,
  ): Promise<string>;
  sendPhoto?(
    chatId: string,
    bytes: Uint8Array,
    mediaType: "image/png" | "image/jpeg",
    replyToMessageId?: string,
    signal?: AbortSignal,
  ): Promise<string>;
  sendChatAction(chatId: string, action: "typing", signal?: AbortSignal): Promise<void>;
  answerCallbackQuery(callbackQueryId: string, text?: string, signal?: AbortSignal): Promise<void>;
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

  async setMyCommands(
    commands: readonly TelegramBotCommand[],
    scope: TelegramBotCommandScope,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#call<boolean>("setMyCommands", { commands, scope }, signal);
  }

  getUpdates(
    offset: number,
    timeoutSeconds: number,
    signal?: AbortSignal,
  ): Promise<TelegramUpdate[]> {
    return this.#call(
      "getUpdates",
      { offset, timeout: timeoutSeconds, allowed_updates: ["message", "callback_query"] },
      signal,
    );
  }

  async getFile(fileId: string, signal?: AbortSignal): Promise<TelegramFile> {
    return this.#call<TelegramFile>("getFile", { file_id: fileId }, signal);
  }

  async downloadFile(
    filePath: string,
    maxBytes: number,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    try {
      const response = await this.fetcher(
        `https://api.telegram.org/file/bot${this.token}/${filePath}`,
        {
          method: "GET",
          redirect: "error",
          signal: combined,
        },
      );
      if (!response.ok)
        throw new Error(`Telegram file download failed with HTTP ${response.status}`);
      const declaredLength = response.headers.get("content-length");
      if (declaredLength && Number(declaredLength) > maxBytes) {
        throw new Error("Telegram file exceeds the configured visual input limit");
      }
      if (!response.body) throw new Error("Telegram file download returned no body");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          total += next.value.byteLength;
          if (total > maxBytes) {
            await reader.cancel();
            throw new Error("Telegram file exceeds the configured visual input limit");
          }
          chunks.push(next.value);
        }
      } finally {
        reader.releaseLock();
      }
      const result = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return result;
    } catch (error) {
      if (combined.aborted) {
        throw new Error("Telegram file download timed out or was cancelled", { cause: error });
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async sendChatAction(chatId: string, action: "typing", signal?: AbortSignal): Promise<void> {
    await this.#call<boolean>("sendChatAction", { chat_id: chatId, action }, signal);
  }

  async answerCallbackQuery(
    callbackQueryId: string,
    text?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#call<boolean>(
      "answerCallbackQuery",
      { callback_query_id: callbackQueryId, ...(text ? { text } : {}) },
      signal,
    );
  }

  async sendMessage(
    chatId: string,
    text: string,
    replyToMessageId?: string,
    signal?: AbortSignal,
    replyMarkup?: TelegramInlineKeyboardMarkup,
    parseMode?: TelegramParseMode,
  ): Promise<string> {
    const result = await this.#call<{ message_id: number }>(
      "sendMessage",
      {
        chat_id: chatId,
        text,
        ...(replyToMessageId ? { reply_parameters: { message_id: replyToMessageId } } : {}),
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
        ...(parseMode ? { parse_mode: parseMode } : {}),
      },
      signal,
    );
    return result.message_id.toString();
  }

  async sendPhoto(
    chatId: string,
    bytes: Uint8Array,
    mediaType: "image/png" | "image/jpeg",
    replyToMessageId?: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const image = validateGeneratedImage({ bytes, mediaType }, 10 * 1024 * 1024);
    const form = new FormData();
    form.set("chat_id", chatId);
    form.set(
      "photo",
      new Blob([new Uint8Array(image.bytes).buffer], { type: image.mediaType }),
      mediaType === "image/png" ? "generated.png" : "generated.jpg",
    );
    if (replyToMessageId) {
      form.set("reply_parameters", JSON.stringify({ message_id: replyToMessageId }));
    }
    const response = await this.fetcher(`https://api.telegram.org/bot${this.token}/sendPhoto`, {
      method: "POST",
      body: form,
      redirect: "error",
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) throw new Error(`Telegram sendPhoto failed with HTTP ${response.status}`);
    const envelope = (await response.json()) as TelegramEnvelope<{ message_id: number }>;
    if (!envelope.ok) {
      throw new Error(`Telegram sendPhoto failed: ${envelope.description ?? "unknown"}`);
    }
    return envelope.result.message_id.toString();
  }
}
