import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";

import type { ToolAuditRepository, ToolOutcome } from "../persistence/repositories.js";
import type { SecretRedactor } from "../security/secrets.js";

export class NativeToolError extends Error {
  constructor(
    message: string,
    readonly outcome: Extract<ToolOutcome, "partial" | "indeterminate" | "cancelled" | "timeout">,
    readonly result?: unknown,
  ) {
    super(message);
    this.name = "NativeToolError";
  }
}

export type NativeExecutionOptions = {
  timeoutMs: number;
  maxResultBytes: number;
};

export type NativeAuditContext = {
  updateId?: string;
  toolCallId?: string;
};

export class NativeToolExecutor {
  constructor(
    private readonly audits: ToolAuditRepository,
    private readonly redactor: SecretRedactor,
    private readonly providerId: string,
    private readonly options: NativeExecutionOptions,
    private readonly beforeRun?: (signal: AbortSignal) => void | Promise<void>,
  ) {}

  async run<T>(
    operation: string,
    args: unknown,
    callback: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
    overrides?: Partial<NativeExecutionOptions>,
    auditContext?: NativeAuditContext,
  ): Promise<T | { truncated: true; content: string }> {
    const auditId = this.audits.start(
      this.providerId,
      operation,
      this.redactor.redact(args),
      auditContext?.updateId,
      auditContext?.toolCallId,
    );
    const timeout = AbortSignal.timeout(overrides?.timeoutMs ?? this.options.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      await this.beforeRun?.(combined);
      const value = this.redactor.redact(await callback(combined)) as T;
      const serialized = JSON.stringify(value) ?? "null";
      const maxResultBytes = overrides?.maxResultBytes ?? this.options.maxResultBytes;
      if (Buffer.byteLength(serialized, "utf8") > maxResultBytes) {
        const bounded = {
          truncated: true as const,
          content: Buffer.from(serialized, "utf8").subarray(0, maxResultBytes).toString("utf8"),
        };
        this.audits.finish(auditId, "success", bounded);
        return bounded;
      }
      this.audits.finish(auditId, "success", value);
      return value;
    } catch (error) {
      const outcome: ToolOutcome =
        error instanceof NativeToolError
          ? error.outcome
          : signal?.aborted
            ? "cancelled"
            : timeout.aborted
              ? "timeout"
              : "failure";
      const result = error instanceof NativeToolError ? error.result : undefined;
      this.audits.finish(auditId, outcome, {
        ...(result === undefined ? {} : { result: this.redactor.redact(result) }),
        error: this.redactor.redact(error instanceof Error ? error.message : "Native tool failed"),
      });
      throw error;
    }
  }
}

export function nativeTool<T>(options: {
  executor: NativeToolExecutor;
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  parse: (value: unknown) => T;
  execute: (args: T, signal: AbortSignal) => Promise<unknown>;
  timeoutMs?: number;
}): ToolDefinition {
  return defineTool({
    name: options.name,
    label: options.name,
    description: options.description,
    parameters: options.parameters,
    execute: async (toolCallId, params, signal) => {
      const args = options.parse(params);
      try {
        const result = await options.executor.run(
          options.name,
          args,
          (combined) => options.execute(args, combined),
          signal,
          options.timeoutMs ? { timeoutMs: options.timeoutMs } : undefined,
          { toolCallId },
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          details: { provider: "native", outcome: "success" },
        };
      } catch (error) {
        if (error instanceof NativeToolError && error.result !== undefined) {
          return {
            content: [{ type: "text", text: JSON.stringify(error.result) }],
            details: { provider: "native", outcome: error.outcome },
          };
        }
        throw error;
      }
    },
  });
}
