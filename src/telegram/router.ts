import type { ChatRepository, UpdateRepository } from "../persistence/repositories.js";
import type { KeyedQueue } from "../dispatch/keyed-queue.js";
import { admitUpdate, type AdmissionPolicy } from "./admission.js";
import type { AcceptedTelegramInput, BotIdentity, TelegramUpdate } from "./types.js";
import type { TelegramTypingActivity } from "./typing-activity.js";

export class TelegramRouter {
  constructor(
    private readonly policy: AdmissionPolicy,
    private readonly updates: UpdateRepository,
    private readonly chats: ChatRepository,
    private readonly queue: KeyedQueue,
    private readonly typing: TelegramTypingActivity,
    private readonly dispatch: (input: AcceptedTelegramInput, sessionId: string) => Promise<void>,
  ) {}

  route(update: TelegramUpdate, bot: BotIdentity): Promise<boolean> {
    const input = admitUpdate(update, this.policy, bot);
    if (!input) return Promise.resolve(false);
    if (
      !this.updates.claim({
        updateId: input.updateId,
        chatId: input.chatId,
        senderId: input.senderId,
        messageId: input.messageId,
        text: input.text,
      })
    ) {
      return Promise.resolve(false);
    }

    const sessionId = this.chats.ensure(input.chatId, input.chatType);
    void this.queue.enqueue(input.chatId, () =>
      this.typing.run(input.chatId, async () => {
        try {
          const activeSession =
            input.command === "new" ? this.chats.newSession(input.chatId) : sessionId;
          await this.dispatch(input, activeSession);
          this.updates.finish(input.updateId, "complete");
        } catch (error) {
          this.updates.finish(
            input.updateId,
            "indeterminate",
            error instanceof Error ? error.message : "Unknown processing error",
          );
        }
      }),
    );
    return Promise.resolve(true);
  }
}
