## Context

See [proposal.md](proposal.md) for motivation and the [telemetry-tracing spec](specs/telemetry-tracing/spec.md) for behavior. Pi owns conversation model streaming and emits session events; the application creates each session in `PiSessionFactory` and invokes it from `AgentTurnHandler`. `AgentToolCatalog` assembles native and MCP tools, while `McpRegistry` owns connection and remote call boundaries. `CodexImageGenerator` makes a separate provider request. SQLite `tool_executions` currently stores full redacted argument and result JSON, but production code reads those rows only to mark unfinished actions indeterminate at startup.

The existing privacy specs prohibit prompts in image diagnostics. The selected content policy intentionally permits redacted text in the configured trace backend, while excluding image bytes and keeping stdout, health, and delivery errors content-free.

## Goals / Non-Goals

**Goals:**

- One trace per accepted turn, with model and tool work in the same tree; safe IDs allow comparison with local interrupted-action records.
- A standard OTLP/HTTP export path that works with MLflow or a collector and does not affect the agent when export fails.
- Text content in enabled traces, with deterministic redaction and size limits at a single serialization boundary.
- A local audit row that remains useful after a crash without retaining duplicate argument and result bodies.

**Non-Goals:**

- Using MLflow APIs or SDK objects in application code.
- Exporting image bytes, base64, authentication material, or arbitrary binary attachments.
- Guaranteed delivery of telemetry when the endpoint is unavailable or the process is killed.
- Replacing SQLite conversation, update, memory, outbox, or tool outcome state.

## Decisions

### Use the OpenTelemetry Node SDK and OTLP/HTTP exporter

Initialize a tracer provider before application components start, with `service.name=klaus-agent`, an asynchronous batch processor, bounded queue and export timeout, and a no-op tracing path when no endpoint is configured. Use `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, `OTEL_EXPORTER_OTLP_TRACES_HEADERS`, and `OTEL_SERVICE_NAME` as operator settings. Validate the endpoint as HTTP(S), reject credentials embedded in its URL, and register configured header values with `SecretRedactor`. Put exporter setup and a bounded flush in an application lifecycle component that starts before work and stops after it. Exporter failure is diagnosed through sanitized stderr/stdout metadata and optional degraded telemetry health; it does not change core readiness.

For MLflow, configure the standard endpoint as `<tracking-uri>/v1/traces` and include `x-mlflow-experiment-id` in OTLP headers. The same code can send to a collector. Alternative considered: direct MLflow tracing SDK, which would couple runtime behavior and configuration to that service.

### Instrument Pi at the model stream boundary and tools at the catalog boundary

Create an active turn span around `AgentTurnHandler.handle`. After `createAgentSession`, wrap the public `session.agent.streamFunction` while preserving Pi's original function, options, stream event sequence, result, and cancellation. Pi uses that stream function for conversational calls and compaction, so each logical stream gets a model span and the actual model context, final response, model identity, usage, and outcome. Label compaction using its surrounding Pi session operation or call context. Pi's outer retry creates another stream invocation and can be distinguished; provider-internal retries inside one Pi stream may remain opaque and must not be invented as separate spans. Verify this behavior with a focused test against the installed Pi version before broad integration.

Decorate tools once as they leave `AgentToolCatalog` so native, memory, image, and MCP tools receive `execute_tool` spans regardless of whether they throw or return an error result. Add a child MCP client span at remote `callTool`, and separate connection, discovery, and reconnection spans in `McpRegistry`. Add a child generation span around `CodexImageGenerator.generate`. Avoid a second generic span in each native executor. Preserve error and cancellation distinctions from existing audit outcomes.

Alternative considered: reconstruct model spans solely from Pi `message_start`/`message_end` events. Those events do not reliably expose the exact model request context or compaction and cannot identify every request boundary.

### Capture content deliberately at a single safe boundary

Represent model and tool text in the applicable OpenTelemetry GenAI attributes and use a project namespace only where no convention applies. Serialize text and JSON content through one sanitizer before setting any span attribute or event: remove registered secret values and credential-named fields, omit binary/image parts and base64 payloads, bound each field by a documented UTF-8 byte limit, and set a truncation flag when clipped. Do not attach raw exceptions, headers, endpoint query strings, Telegram IDs, or arbitrary provider payloads. Use update ID, session ID, tool call ID, and generated audit ID for correlation; do not attach chat or sender IDs. Keep full content out of the ordinary structured logger.

The trace endpoint becomes a store of private household content. The deployment guide will require a protected endpoint, restricted viewer access, and backend retention. Alternative considered: metadata-only tracing, which would not satisfy the selected content policy or show the model/tool exchanges the operator wants to inspect.

### Keep only local audit outcome metadata

Migrate `tool_executions` to omit `arguments_json` and `result_json`, preserving ID, update/tool-call IDs, server/tool identity, status, and timestamps. Update every audit producer to write only those fields. The startup transition from `started` to `indeterminate` remains local and independent of the trace backend. Preserve existing audit rows' safe columns through the migration and remove historical payloads by rebuilding the table; do not touch other tables. Keep a trace correlation attribute containing the audit ID rather than storing trace content in SQLite.

Alternative considered: remove the table entirely. That would lose the local record of an interrupted external action when OTLP export fails or is delayed, and would weaken the existing operational restart contract.

## Risks / Trade-offs

- [Private content reaches a remote trace store] → Make trace export opt-in, sanitize before span creation, document endpoint access and retention, and test common credential and binary payload shapes. Unknown secrets embedded in ordinary prose cannot be identified with certainty; operators must treat the backend as sensitive.
- [Pi internals or stream semantics change] → Use its public stream function property, preserve event ordering and result behavior, and add an integration test that exercises normal generation, tool follow-up, and compaction. Pin behavior to the installed version and recheck on upgrades.
- [Some provider retries are opaque] → Trace logical Pi stream calls and visible outer retries; do not claim individual provider HTTP attempts unless Pi exposes them in a supported hook.
- [Exporter backpressure or failure loses spans] → Use a bounded asynchronous queue, safe diagnostics, and deadline-limited shutdown flush. Model and tool execution continue regardless.
- [Content makes traces large] → Bound each content field and signal truncation. Record metadata and outcome even when content is truncated.
- [Audit migration limits direct rollback] → Take the normal SQLite backup before upgrading. An older binary that requires the removed columns needs restoration to a fresh volume, following the existing rollback procedure.

## Migration Plan

1. Back up SQLite and Pi authentication state. Configure an OTLP/HTTP endpoint reachable from the single replica; for MLflow, confirm a compatible version, experiment ID, and protected access.
2. Deploy the new image and its SQLite migration. Tracing remains off when no endpoint is set, so the audit table can be migrated independently of exporter availability.
3. Enable OTLP configuration for the workload. Verify one disposable turn with a model call, tool call, and failure produces a linked trace with redacted text and no binary or credentials; check the local indeterminate-action record remains available after interruption.
4. If rollback is needed, stop the new pod. Restore the pre-upgrade database to a fresh volume before deploying a binary that expects the old audit columns; use the existing `Recreate` deployment strategy.
