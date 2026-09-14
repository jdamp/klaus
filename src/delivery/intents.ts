import type { OutboxRepository } from "../persistence/repositories.js";
import type { TelegramInlineKeyboardMarkup } from "../telegram/types.js";
import { splitTelegramText } from "./render.js";

export function enqueueResponse(
  outbox: OutboxRepository,
  input: { updateId: string; chatId: string; messageId: string },
  text: string,
  replyMarkup?: TelegramInlineKeyboardMarkup,
): void {
  const chunks = splitTelegramText(text);
  chunks.forEach((chunk, sequence) => {
    outbox.enqueue({
      dedupeKey: `response:${input.updateId}:${sequence}`,
      chatId: input.chatId,
      replyToMessageId: input.messageId,
      sequence,
      text: chunk,
      ...(replyMarkup && sequence === chunks.length - 1 ? { replyMarkup } : {}),
    });
  });
}
