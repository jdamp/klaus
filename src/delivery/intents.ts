import type { OutboxRepository } from "../persistence/repositories.js";
import type { TelegramInlineKeyboardMarkup } from "../telegram/types.js";
import { renderTelegramMarkdown, splitTelegramHtml, splitTelegramText } from "./render.js";

type ResponseInput = { updateId: string; chatId: string; messageId: string };

function enqueueChunks(
  outbox: OutboxRepository,
  input: ResponseInput,
  chunks: readonly string[],
  replyMarkup?: TelegramInlineKeyboardMarkup,
  parseMode?: "HTML",
): void {
  chunks.forEach((chunk, sequence) => {
    outbox.enqueue({
      dedupeKey: `response:${input.updateId}:${sequence}`,
      chatId: input.chatId,
      replyToMessageId: input.messageId,
      sequence,
      text: chunk,
      ...(parseMode ? { parseMode } : {}),
      ...(replyMarkup && sequence === chunks.length - 1 ? { replyMarkup } : {}),
    });
  });
}

export function enqueueResponse(
  outbox: OutboxRepository,
  input: ResponseInput,
  text: string,
  replyMarkup?: TelegramInlineKeyboardMarkup,
): void {
  enqueueChunks(outbox, input, splitTelegramText(text), replyMarkup);
}

export function enqueueRenderedAgentResponse(
  outbox: OutboxRepository,
  input: ResponseInput,
  text: string,
): void {
  enqueueChunks(outbox, input, splitTelegramHtml(renderTelegramMarkdown(text)), undefined, "HTML");
}
