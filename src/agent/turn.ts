import type { ChatRepository, OutboxRepository } from "../persistence/repositories.js";
import type { AcceptedTelegramInput } from "../telegram/types.js";
import { enqueueRenderedAgentResponse, enqueueResponse } from "../delivery/intents.js";
import type { SessionRegistry } from "./session-registry.js";
import { extractFinalText } from "./pi-runtime.js";
import { attributedUserPrompt, type MemoryTurnContextRegistry } from "../memory/context.js";
import { OVERVIEW_ID, type MemoryRepository } from "../memory/repository.js";

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
    private readonly memory?: {
      repository: MemoryRepository;
      contexts: MemoryTurnContextRegistry;
    },
  ) {}

  async handle(input: AcceptedTelegramInput, sessionId: string): Promise<void> {
    const managed = await this.sessions.get(sessionId, this.chats?.modelPreference(input.chatId));
    let contextToken: symbol | undefined;
    try {
      let prompt = input.text;
      if (this.memory) {
        let overview;
        try {
          overview = this.memory.repository.read(OVERVIEW_ID);
        } catch {
          throw new Error("Household overview is unavailable");
        }
        if (!overview) throw new Error("Household overview is unavailable");
        contextToken = this.memory.contexts.set(sessionId, {
          chatId: input.chatId,
          senderId: input.senderId,
          ...(input.senderLabel ? { senderLabel: input.senderLabel } : {}),
          updateId: input.updateId,
          overview,
        });
        prompt = attributedUserPrompt(input);
      }
      await managed.session.prompt(prompt);
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
        error instanceof Error && error.message === "Household overview is unavailable"
          ? "Household memory is unavailable, so this request was not sent to the model."
          : "Sorry, I could not complete that request. No action will be retried automatically.",
      );
      throw new Error("Agent turn failed before a successful completion was recorded", {
        cause: error,
      });
    } finally {
      if (contextToken && this.memory) this.memory.contexts.clear(sessionId, contextToken);
    }
  }
}
