import type { OutboxRepository } from "../persistence/repositories.js";
import type { AcceptedTelegramInput } from "../telegram/types.js";
import { enqueueResponse } from "../delivery/intents.js";
import type { SessionRegistry } from "./session-registry.js";
import { extractFinalText } from "./pi-runtime.js";

export class AgentTurnHandler {
  constructor(
    private readonly sessions: SessionRegistry,
    private readonly outbox: OutboxRepository,
  ) {}

  async handle(input: AcceptedTelegramInput, sessionId: string): Promise<void> {
    const managed = await this.sessions.get(sessionId);
    try {
      await managed.session.prompt(input.text);
      const response = extractFinalText(managed.session.messages);
      if (!response) throw new Error("The model returned no final text");
      managed.persist();
      enqueueResponse(this.outbox, input, response);
    } catch {
      enqueueResponse(
        this.outbox,
        input,
        "Sorry, I could not complete that request. No action will be retried automatically.",
      );
      throw new Error("Agent turn failed before a successful completion was recorded");
    }
  }
}
