## Purpose

Provide inspectable, correlated traces of agent, model, tool, and MCP activity through a backend-independent OpenTelemetry interface.

## ADDED Requirements

### Requirement: Tracing is configurable and backend independent
The system SHALL accept an optional OTLP/HTTP trace destination and exporter headers, SHALL identify itself as a service, and SHALL function without an MLflow client library or MLflow-specific application behavior. When tracing is not configured, the system MUST NOT export trace content.

#### Scenario: Generic collector is configured
- **WHEN** an operator configures a compatible OTLP/HTTP collector
- **THEN** the collector receives valid OpenTelemetry traces without requiring MLflow

#### Scenario: Tracing is disabled
- **WHEN** no trace destination is configured
- **THEN** normal agent behavior continues and no trace payload is exported

### Requirement: Accepted turns produce correlated traces
The system SHALL create a trace for each accepted agent turn and link its model, tool, and MCP spans to that turn. Spans SHALL carry safe correlation identifiers sufficient to relate them to local update, session, and tool audit records without exposing chat or sender identifiers as plain text.

#### Scenario: A turn calls a tool and then the model again
- **WHEN** an accepted turn makes a model call, invokes a tool, and makes a follow-up model call
- **THEN** the exported trace contains distinguishable child spans for both model calls and the tool invocation under the same turn

#### Scenario: Two chats run concurrently
- **WHEN** accepted turns from different chats overlap
- **THEN** their spans retain the correct parent trace and correlation identifiers

### Requirement: Model calls are observable
The system SHALL trace production model calls, including conversational generation, retries, and compaction or summarization requests where the model runtime exposes them. Each model span SHALL report provider, model, duration, outcome, and available token usage using applicable OpenTelemetry GenAI semantic attributes. A request attempt MUST NOT be reported as completed successfully merely because a surrounding turn later succeeds.

#### Scenario: Model responds with token usage
- **WHEN** the provider returns a completed model response with usage counts
- **THEN** the corresponding span records the model identity, usage counts, and successful outcome

#### Scenario: Model request fails and is retried
- **WHEN** a model request fails before a later attempt succeeds
- **THEN** telemetry distinguishes the failed attempt from the successful attempt where the runtime exposes request attempts

#### Scenario: Compaction calls the model
- **WHEN** a turn invokes model-backed compaction
- **THEN** the model work is visible in the trace and identifiable as compaction rather than a user response

### Requirement: Tool and MCP work is observable
The system SHALL trace every model-invoked native and MCP tool execution, including failures and cancellations. MCP connection, discovery, reconnection, and remote tool calls SHALL be distinguishable by configured server identity. A tool span SHALL identify its public tool name, outcome, and elapsed time, and SHALL correlate with its durable local audit record when one exists.

#### Scenario: MCP tool times out
- **WHEN** a remote MCP tool exceeds its configured deadline
- **THEN** its span reports a timeout and identifies the configured server and tool without claiming success

#### Scenario: MCP server is unavailable during discovery
- **WHEN** a configured MCP server cannot connect or list tools
- **THEN** telemetry reports the affected server and failed operation while unrelated capabilities remain available

#### Scenario: Tool result reports an error without throwing
- **WHEN** a tool returns a structured error outcome
- **THEN** the corresponding span reports that error outcome rather than success

### Requirement: Enabled traces include bounded, redacted text content
For each traced model call and tool execution, the system SHALL export its textual input and output content when available, including model instructions, prompt text, assistant text, tool arguments, and tool results. The system MUST redact configured credentials and authentication fields before export, MUST exclude binary image or media bytes, and MUST mark any content truncated to a documented size limit. Ordinary stdout logs, health responses, and delivery errors MUST NOT gain private content through tracing.

#### Scenario: Model call contains household text
- **WHEN** tracing is enabled for an accepted text turn
- **THEN** the model span includes the redacted textual input and output seen by that model call

#### Scenario: A tool returns a large payload
- **WHEN** a tool argument or result exceeds the trace content limit
- **THEN** the exported content is bounded and explicitly marked truncated

#### Scenario: Payload contains credentials or image data
- **WHEN** a traced request or result contains a registered secret, authorization field, or binary media
- **THEN** the secret and binary media are absent from exported traces

### Requirement: Telemetry failures do not affect agent execution
The system SHALL export traces asynchronously with bounded resources and SHALL isolate exporter connection, authentication, timeout, and rejection failures from model calls, tool calls, delivery, and readiness. It SHALL make exporter failure observable through safe operational diagnostics and SHALL make a bounded flush attempt on graceful shutdown.

#### Scenario: Trace endpoint is unavailable
- **WHEN** the trace endpoint fails during an otherwise successful tool call
- **THEN** the tool result and user response remain successful while the export failure is reported safely

#### Scenario: Application shuts down with pending spans
- **WHEN** graceful shutdown begins with completed spans awaiting export
- **THEN** the application attempts to flush them within its shutdown deadline and then terminates without waiting indefinitely

### Requirement: Local audit storage retains only durable outcomes
The system SHALL retain local tool identity, safe correlation identifiers, timing, and outcome needed to investigate interrupted actions after a restart. New audit records MUST NOT persist tool argument or result bodies, and migration SHALL remove such bodies from existing audit rows without changing conversation, memory, update, or outbox state.

#### Scenario: Process stops during a tool action
- **WHEN** the process restarts after a tool record was started but not completed
- **THEN** the local record is marked indeterminate and identifies the affected tool without requiring the trace backend

#### Scenario: Existing database is upgraded
- **WHEN** an existing database containing tool argument and result bodies is migrated
- **THEN** those bodies are removed while safe outcome metadata and unrelated durable state remain intact
