export type TrustedTurnContext = {
  chatId: string;
  messageId: string;
  updateId: string;
  senderId: string;
  senderLabel?: string;
};

export class TurnContextRegistry {
  readonly #contexts = new Map<string, { token: symbol; value: TrustedTurnContext }>();

  set(sessionId: string, value: TrustedTurnContext): symbol {
    const token = Symbol(sessionId);
    this.#contexts.set(sessionId, { token, value });
    return token;
  }

  get(sessionId: string): TrustedTurnContext | undefined {
    return this.#contexts.get(sessionId)?.value;
  }

  require(sessionId: string): TrustedTurnContext {
    const context = this.get(sessionId);
    if (!context) throw new Error("Trusted turn context is unavailable");
    return context;
  }

  clear(sessionId: string, token: symbol): void {
    if (this.#contexts.get(sessionId)?.token === token) this.#contexts.delete(sessionId);
  }
}
