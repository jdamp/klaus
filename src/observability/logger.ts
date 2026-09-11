import { randomUUID } from "node:crypto";

import type { SecretRedactor } from "../security/secrets.js";

export type LogSink = (line: string) => void;

export class Logger {
  constructor(
    private readonly redactor: SecretRedactor,
    private readonly sink: LogSink = console.log,
  ) {}

  correlationId(): string {
    return randomUUID();
  }

  log(level: "debug" | "info" | "warn" | "error", event: string, data: unknown = {}): void {
    this.sink(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level,
        event,
        data: this.redactor.redact(data),
      }),
    );
  }
}
