import type { ChatRepository, OutboxRepository } from "../persistence/repositories.js";
import type { AcceptedTelegramInput } from "../telegram/types.js";
import { enqueueRenderedAgentResponse, enqueueResponse } from "../delivery/intents.js";
import type { SessionRegistry } from "./session-registry.js";
import { extractFinalText } from "./pi-runtime.js";

export class UserCancelledTurnError extends Error {
  constructor() {
    super("Agent turn was cancelled by the user");
    this.name = "UserCancelledTurnError";
  }
}

export class AgentTurnHandler {
  constructor(
    private readonly sessions: SessionRegistry,
    private readonly outbox: OutboxRepository,
    private readonly chats?: Pick<ChatRepository, "modelPreference">,
  ) {}

  async handle(input: AcceptedTelegramInput, sessionId: string): Promise<void> {
    const managed = await this.sessions.get(sessionId, this.chats?.modelPreference(input.chatId));
    try {
      await managed.session.prompt(input.text);
      if (this.sessions.consumeUserCancellation(sessionId)) {
        managed.persist();
        throw new UserCancelledTurnError();
      }
      const response = extractFinalText(managed.session.messages);
      if (!response) throw new Error("The model returned no final text");
      managed.persist();
      enqueueRenderedAgentResponse(this.outbox, input, response);
    } catch (error) {
      if (error instanceof UserCancelledTurnError) throw error;
      if (this.sessions.consumeUserCancellation(sessionId)) {
        managed.persist();
        throw new UserCancelledTurnError();
      }
      enqueueResponse(
        this.outbox,
        input,
        "Sorry, I could not complete that request. No action will be retried automatically.",
      );
      throw new Error("Agent turn failed before a successful completion was recorded", {
        cause: error,
      });
    }
  }
}
