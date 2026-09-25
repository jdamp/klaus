import { UserCancelledTurnError } from "../agent/turn.js";
import { VisualInputError } from "./visual-input.js";
import type { KeyedQueue } from "../dispatch/keyed-queue.js";
import type { ChatRepository, UpdateRepository } from "../persistence/repositories.js";
import { admitUpdate, type AdmissionPolicy } from "./admission.js";
import type { TelegramCommandHandler } from "./command-handler.js";
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
    private readonly commands?: Pick<TelegramCommandHandler, "handle" | "stop">,
    private readonly acknowledgeCallback?: (callbackQueryId: string) => Promise<void>,
  ) {}

  async route(update: TelegramUpdate, bot: BotIdentity): Promise<boolean> {
    const input = admitUpdate(update, this.policy, bot);
    if (!input) return false;

    if (input.kind === "callback") {
      void this.acknowledgeCallback?.(input.callbackQueryId).catch(() => undefined);
    }

    if (
      !this.updates.claim({
        updateId: input.updateId,
        chatId: input.chatId,
        senderId: input.senderId,
        messageId: input.messageId,
        text: input.text,
      })
    ) {
      return false;
    }

    const admittedSessionId = this.chats.ensure(input.chatId, input.chatType);
    if (input.kind === "command" && input.command.name === "stop" && this.commands) {
      try {
        await this.commands.stop(input, admittedSessionId);
        this.updates.finish(input.updateId, "complete");
      } catch (error) {
        this.updates.finish(
          input.updateId,
          "failed",
          error instanceof Error ? error.message : "Stop command failed",
        );
      }
      return true;
    }

    void this.queue.enqueue(input.chatId, () =>
      this.typing.run(input.chatId, async () => {
        try {
          const sessionId = this.chats.activeSession(input.chatId);
          if ((input.kind === "command" || input.kind === "callback") && this.commands) {
            await this.commands.handle(input, sessionId);
          } else {
            await this.dispatch(input, sessionId);
          }
          this.updates.finish(input.updateId, "complete");
        } catch (error) {
          if (error instanceof UserCancelledTurnError) {
            this.updates.finish(input.updateId, "cancelled", error.message);
            return;
          }
          if (error instanceof VisualInputError) {
            this.updates.finish(input.updateId, "failed", error.message);
            return;
          }
          this.updates.finish(
            input.updateId,
            "indeterminate",
            error instanceof Error ? error.message : "Unknown processing error",
          );
        }
      }),
    );
    return true;
  }
}
