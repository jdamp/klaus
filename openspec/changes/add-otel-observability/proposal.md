## Why

Model and MCP activity is difficult to inspect: startup events go to stdout, while tool audits sit in SQLite with no operator-facing view. OpenTelemetry traces can show complete turns and their calls in MLflow or another OTLP backend without making MLflow an application dependency.

## What Changes

- Add configurable OTLP/HTTP tracing for accepted agent turns, model calls, native tool executions, MCP connections and tool calls, and image generation.
- Export text prompts, model responses, and tool arguments and results in traces, as requested, subject to secret redaction, bounded payloads, and explicit truncation indicators. Never export credentials, authorization headers, image bytes, or other binary media.
- Correlate spans with local update, session, and tool audit records; report model identity, token usage where available, timing, and outcomes including timeout and cancellation.
- Keep the minimal durable SQLite tool outcome history needed for post-crash investigation, but stop retaining duplicate argument and result bodies there. Preserve conversation, update, memory, and outbox state.
- Add operator configuration and deployment guidance for a generic OTLP/HTTP endpoint and MLflow's endpoint and experiment header. An unavailable trace backend must not interrupt chat or tool execution.
- **BREAKING:** Tracing, when enabled, exports private textual conversation and tool content to the configured backend. Existing diagnostic privacy requirements for image prompts and captions must be revised explicitly.

## Capabilities

### New Capabilities

- `telemetry-tracing`: Trace structure, content policy, correlation, export, failure isolation, and operator controls.

### Modified Capabilities

- `agent-conversations`: Permit configured content-bearing traces while keeping durable local operational records minimal and credentials absent.
- `image-generation`: Permit redacted image prompt text in traces while continuing to exclude generated image bytes and provider secrets.
- `telegram-image-delivery`: Permit redacted prompt or caption text in configured traces while continuing to exclude image bytes and private content from ordinary logs, health, and delivery errors.

## Impact

- Changes session and model instrumentation, tool execution wrappers, MCP registry, image generation, configuration, runtime lifecycle, SQLite audit migration, tests, and operator documentation.
- Adds OpenTelemetry SDK and OTLP/HTTP exporter dependencies. MLflow remains optional; any compatible OTLP/HTTP collector may receive traces.
- Operators enabling tracing must protect the trace backend and set its retention and access controls for household content. Existing SQLite migration and rollback procedures apply to the audit schema change.
