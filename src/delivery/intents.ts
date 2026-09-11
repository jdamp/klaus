import type { OutboxRepository } from "../persistence/repositories.js";
import { splitTelegramText } from "./render.js";

export function enqueueResponse(
  outbox: OutboxRepository,
  input: { updateId: string; chatId: string; messageId: string },
  text: string,
): void {
  splitTelegramText(text).forEach((chunk, sequence) => {
    outbox.enqueue({
      dedupeKey: `response:${input.updateId}:${sequence}`,
      chatId: input.chatId,
      replyToMessageId: input.messageId,
      sequence,
      text: chunk,
    });
  });
}
