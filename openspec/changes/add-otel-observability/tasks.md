## 1. Telemetry foundation

- [ ] 1.1 Add OpenTelemetry SDK and OTLP/HTTP exporter dependencies and verify installation, typecheck, and a minimal in-memory export test.
- [ ] 1.2 Implement opt-in endpoint, header, service-name, and content-limit configuration with endpoint validation and secret registration; verify disabled, valid, and unsafe configurations in config tests.
- [ ] 1.3 Add a lifecycle-managed tracer with bounded batching, safe exporter diagnostics, and deadline-limited shutdown flush; verify exporter failure and shutdown do not block application readiness or work.
- [ ] 1.4 Build one trace-content sanitizer for redacted text and JSON, credential fields, media omission, UTF-8 limits, and truncation markers; verify secrets, base64 images, large payloads, and normal text with focused tests.

## 2. Model and turn traces

- [ ] 2.1 Verify on installed Pi that wrapping `session.agent.streamFunction` preserves event order, results, cancellation, tool follow-up, and compaction; add a focused Pi integration test before wiring production spans.
- [ ] 2.2 Add an accepted-turn root span and safe update/session correlation across concurrent chats; verify separate concurrent turns never mix child spans or content.
- [ ] 2.3 Trace each Pi model stream with provider/model, available usage, outcome, redacted actual input/output, and compaction identity; verify normal calls, outer retries, failures, and compaction produce correctly linked spans without inventing provider-internal attempts.
- [ ] 2.4 Trace the direct image-generation provider request with bounded prompt text and safe outcome metadata; verify no image bytes, encoded image data, or authentication values appear in exported spans.

## 3. Tool and MCP traces

- [ ] 3.1 Decorate catalog tools with `execute_tool` spans covering native, memory, image, and MCP calls; verify thrown errors, structured error results, cancellation, arguments, and results map to the correct outcome and parent turn.
- [ ] 3.2 Add MCP connection, discovery, reconnection, and remote-call spans with server/tool identity and bounded redacted content; verify unavailable servers, timeouts, and healthy calls remain isolated.
- [ ] 3.3 Correlate each tool span with the local audit ID and trusted update/tool-call IDs where available; verify a traced tool can be matched to its SQLite outcome row without publishing chat or sender IDs.

## 4. Local audit migration and operations

- [ ] 4.1 Add a SQLite migration that removes historical `arguments_json` and `result_json` while preserving audit identity, timing, status, and unrelated tables; verify upgrade from an existing populated database and idempotent restart.
- [ ] 4.2 Update all audit producers and tests to persist only outcome metadata; verify startup still marks unfinished tool actions indeterminate without an OTLP endpoint.
- [ ] 4.3 Document generic OTLP/HTTP and MLflow endpoint/header setup, private trace access and retention, expected content, rollback backup procedure, and how to inspect local indeterminate outcomes; verify examples against deployment configuration and smoke instructions.
- [ ] 4.4 Run format, lint, typecheck, unit/integration tests, and build; verify a disposable end-to-end trace reaches a test OTLP receiver with linked model/tool/MCP spans, content redaction, and export-failure isolation.
