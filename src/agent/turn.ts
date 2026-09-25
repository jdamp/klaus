import type { ChatRepository, OutboxRepository } from "../persistence/repositories.js";
import type { AcceptedTelegramInput } from "../telegram/types.js";
import { VisualInputError, visualInputErrorMessage } from "../telegram/visual-input.js";
import type { TelegramVisualInputLoader } from "../telegram/visual-input.js";
import { enqueueRenderedAgentResponse, enqueueResponse } from "../delivery/intents.js";
import type { SessionRegistry } from "./session-registry.js";
import type { TurnContextRegistry } from "./turn-context.js";
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
    private readonly visualInput?: TelegramVisualInputLoader,
    private readonly turnContexts?: TurnContextRegistry,
  ) {}

  async handle(input: AcceptedTelegramInput, sessionId: string): Promise<void> {
    const managed = await this.sessions.get(sessionId, this.chats?.modelPreference(input.chatId));
    let contextToken: symbol | undefined;
    let turnContextToken: symbol | undefined;
    try {
      turnContextToken = this.turnContexts?.set(sessionId, {
        chatId: input.chatId,
        messageId: input.messageId,
        updateId: input.updateId,
        senderId: input.senderId,
        ...(input.senderLabel ? { senderLabel: input.senderLabel } : {}),
      });
      let prompt = input.text;
      const images = input.visual
        ? await this.#loadVisualInput(input, managed.session.model)
        : undefined;
      if (this.memory) {
        let overview;
        try {
          overview = this.memory.repository.read(OVERVIEW_ID);
        } catch {
          throw new Error("Memory overview is unavailable");
        }
        if (!overview) throw new Error("Memory overview is unavailable");
        contextToken = this.memory.contexts.set(sessionId, {
          chatId: input.chatId,
          senderId: input.senderId,
          ...(input.senderLabel ? { senderLabel: input.senderLabel } : {}),
          updateId: input.updateId,
          overview,
        });
        prompt = attributedUserPrompt(input);
      }
      await managed.session.prompt(prompt, images ? { images } : undefined);
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
      if (error instanceof VisualInputError) {
        enqueueResponse(this.outbox, input, visualInputErrorMessage(error));
        throw error;
      }
      if (this.sessions.consumeUserCancellation(sessionId)) {
        managed.persist();
        throw new UserCancelledTurnError();
      }
      enqueueResponse(
        this.outbox,
        input,
        error instanceof Error && error.message === "Memory overview is unavailable"
          ? "Memory is unavailable, so this request was not sent to the model."
          : "Sorry, I could not complete that request. No action will be retried automatically.",
      );
      throw new Error("Agent turn failed before a successful completion was recorded", {
        cause: error,
      });
    } finally {
      this.outbox.releasePhotosForUpdate(input.updateId);
      if (contextToken && this.memory) this.memory.contexts.clear(sessionId, contextToken);
      if (turnContextToken && this.turnContexts)
        this.turnContexts.clear(sessionId, turnContextToken);
    }
  }

  async #loadVisualInput(
    input: AcceptedTelegramInput,
    model: { input?: readonly string[] } | undefined,
  ) {
    if (!input.visual) return undefined;
    if (!model?.input?.includes("image")) {
      throw new VisualInputError(
        "model-incompatible",
        "The selected model does not support image input. Choose an image-capable model with /model.",
      );
    }
    if (!this.visualInput) {
      throw new VisualInputError("unavailable", "Visual input is unavailable.");
    }
    return [await this.visualInput.load(input.visual)];
  }
}
