## 1. Project Foundation

- [ ] 1.1 Initialize the TypeScript/Node.js package, pin Pi SDK and runtime dependencies, and add production/build scripts; verify dependency installation and a clean production build succeed.
- [ ] 1.2 Configure formatting, linting, type checking, and the unit/integration test runner; verify each quality command succeeds on the initial scaffold.
- [ ] 1.3 Create the modular application entry point and lifecycle interfaces for Telegram, sessions, capabilities, persistence, scheduling, delivery, and health; verify a composition test can start and stop the service with fake adapters.

## 2. Configuration, Secrets, and Persistence

- [ ] 2.1 Implement validated operator configuration for decimal-string Telegram IDs, model selection, MCP definitions and tool allowlists, skill paths, calendar/reminder settings, limits, and data paths; verify valid fixtures load and security-critical omissions prevent startup.
- [ ] 2.2 Implement file-backed secret references and centralized redaction utilities; verify Telegram, model, MCP, and Home Assistant credential fixtures never appear in serialized config, logs, errors, or health output.
- [ ] 2.3 Add SQLite initialization in WAL mode with versioned migrations for chats, Telegram updates, session entries, tool executions, outbox messages, calendar events, reminder rules, and reminder occurrences; verify a fresh database reaches the expected schema and repeated migration is safe.
- [ ] 2.4 Implement repositories and transactions for chats, Telegram update claiming, and ordered Pi session entries; verify uniqueness constraints prevent duplicate update claims and preserve deterministic session entry order.
- [ ] 2.5 Implement repositories for tool audits, outbox delivery, calendar synchronization, and reminder occurrences; verify lease, retry, completion, cancellation, and deduplication transitions with repository tests.

## 3. Telegram Admission and Dispatch

- [ ] 3.1 Implement the Telegram long-polling adapter with required update types, bot identity discovery, offset management, and bounded shutdown; verify mocked polling resumes from the durable offset and does not require an inbound HTTP listener.
- [ ] 3.2 Implement admission checks for bot/edited updates and the combined chat-plus-sender allowlists; verify unauthorized and automated message content is neither persisted nor dispatched.
- [ ] 3.3 Implement entity-aware group trigger detection for bot mentions, replies to bot-authored messages, and supported commands; verify plain text resembling the bot name and ambient group messages are ignored.
- [ ] 3.4 Normalize accepted private and group inputs and claim them in the durable inbox before processing; verify redelivery of the same Telegram update does not create another queued turn.
- [ ] 3.5 Implement keyed per-chat dispatch queues that serialize one chat while allowing separate chats to progress concurrently; verify ordering and cross-chat concurrency with deterministic tests.
- [ ] 3.6 Implement the new-session Telegram command scoped to the current authorized chat; verify it changes only that chat's active session and cannot be invoked from an unauthorized context.

## 4. Headless Pi Conversation Runtime

- [ ] 4.1 Implement a Pi SDK adapter that creates headless `AgentSession` instances with all built-in coding tools disabled and only supplied application tools enabled; verify shell, read, write, edit, and generic HTTP capabilities are absent from agent state.
- [ ] 4.2 Implement SQLite-to-`SessionManager.inMemory` hydration and persistence of Pi session and compaction entries at turn boundaries; verify a multi-turn session restored after restart has equivalent usable context.
- [ ] 4.3 Implement the chat-to-session registry and bounded in-memory session cache with disposal; verify private and group chats restore distinct sessions without cross-chat messages.
- [ ] 4.4 Configure Pi model runtime, system instructions, retry limits, context budget, and automatic compaction through validated application settings; verify a long synthetic conversation compacts older entries while retaining the recent structured tool-call/result tail.
- [ ] 4.5 Configure Pi resource loading for read-only operator skill paths and explicit reload, with model-driven installation disabled; verify valid skills are discoverable and an invalid skill produces diagnostics without expanding tool authority.
- [ ] 4.6 Translate accepted Telegram inputs into Pi prompts and finalized Pi events into durable response intents; verify agent failures produce a safe user-facing response without recording a successful turn or action.

## 5. MCP and Tool Policy

- [ ] 5.1 Implement the managed Streamable HTTP MCP client lifecycle with URL validation, mounted-token authentication, safe redirect behavior, and a fake MCP server test proving credentials remain transport-only.
- [ ] 5.2 Implement startup/reconnect tool discovery, stable server namespaces, and fail-closed per-server allowlists; verify duplicate names do not collide and newly discovered unlisted tools remain absent from Pi sessions.
- [ ] 5.3 Adapt enabled MCP schemas and calls into Pi tools with local argument validation, cancellation propagation, timeouts, and result-size truncation; verify invalid, cancelled, timed-out, oversized, and successful fake calls produce the expected structured results.
- [ ] 5.4 Add application-level tool execution hooks and redacted audit transitions recorded before and after calls; verify audits distinguish success, failure, timeout, cancellation, and indeterminate interruption without storing credentials.
- [ ] 5.5 Implement MCP connection health, bounded reconnection backoff, and unavailable-capability responses; verify a Home Assistant MCP outage leaves Telegram and unrelated agent conversations operational in degraded mode.
- [ ] 5.6 Add a configurable Home Assistant MCP definition and integration test fixture representing non-critical light, vacuum, desk, and list operations; verify only the reviewed fixture allowlist is exposed to the model.

## 6. Telegram Response Delivery

- [ ] 6.1 Implement deterministic Telegram-safe rendering and ordered splitting of completed responses while preserving triggering-message reply metadata; verify boundary cases reconstruct the original response in order within platform limits.
- [ ] 6.2 Implement the durable Telegram outbox worker with leasing, bounded retry/backoff, and successful-send recording; verify transient failures resume after restart without rerunning the agent.
- [ ] 6.3 Connect finalized agent responses and operational error responses to the outbox; verify each accepted invocation targets only its originating chat.
- [ ] 6.4 Add an end-to-end reactive test using fake Telegram, model, and MCP services; verify authorization, group triggers, tool execution, session persistence, reply delivery, and duplicate-update suppression as one flow.

## 7. Calendar Synchronization and Reminders

- [ ] 7.1 Define the normalized `CalendarSource` contract and implement a read-only Home Assistant calendar adapter with independent file-backed authentication; verify fake REST responses cover timed, all-day, recurring-expanded, empty, and failed queries.
- [ ] 7.2 Implement rolling-window startup and periodic calendar synchronization with minimal event caching and revision/fingerprint reconciliation; verify moved and removed events update or cancel only unsent derived reminders.
- [ ] 7.3 Implement reminder-rule validation and matching for configured calendar entities, event fields, destinations, templates, offsets, and local delivery times; verify matching and non-matching garbage-collection fixtures generate the expected occurrences.
- [ ] 7.4 Implement household IANA timezone calculations for timed and all-day events; verify reminder times remain correct across daylight-saving transitions.
- [ ] 7.5 Implement the durable scheduler, occurrence leasing, misfire grace behavior, and reminder-to-outbox rendering; verify short outages send eligible reminders while stale occurrences are skipped and future ones continue normally.
- [ ] 7.6 Add an integration test from calendar synchronization through Telegram delivery; verify one calendar occurrence and rule produce at most one successful notification and no Pi or LLM invocation.

## 8. Observability and Runtime Lifecycle

- [ ] 8.1 Add structured, privacy-aware logging and correlation identifiers for updates, turns, tools, reminders, and deliveries; verify automated redaction tests contain no configured secrets or ignored message content.
- [ ] 8.2 Implement liveness, core readiness, and per-integration degraded health reporting; verify SQLite or invalid core configuration blocks readiness while an optional MCP/calendar outage is reported as degraded.
- [ ] 8.3 Implement bounded graceful shutdown across polling, dispatch queues, active Pi turns, MCP clients, scheduler leases, outbox delivery, and SQLite; verify a termination integration test exits cleanly and leaves work in a deterministic recoverable or non-replay state.
- [ ] 8.4 Add retention and maintenance operations for old accepted transcripts, tool audit metadata, completed updates, deliveries, and reminder records; verify maintenance preserves active sessions, current summaries, pending work, and deduplication guarantees.

## 9. Packaging and Deployment

- [ ] 9.1 Create a pinned multi-stage container build with a non-root runtime user, read-only application filesystem, writable data mount, and health check; verify the image builds and starts against temporary configuration and storage.
- [ ] 9.2 Add documented example configuration and secret-file layout with safe placeholders, including Telegram ID discovery guidance and Home Assistant MCP/calendar settings; verify the examples pass configuration validation without containing real credentials.
- [ ] 9.3 Add a single-replica k3s deployment example with persistent storage, mounted Secrets, restricted security context, graceful termination, and replacement semantics; verify manifest rendering and policy checks succeed.
- [ ] 9.4 Add a VM/systemd deployment example using the same container image, protected credential mounts, persistent data, restart policy, and shutdown timeout; verify the unit/container configuration passes static validation.
- [ ] 9.5 Document SQLite backup, restore, migration, upgrade, and rollback procedures; verify a backup-and-restore smoke test recovers sessions, outbox state, and reminder state into a fresh runtime.

## 10. Final Verification

- [ ] 10.1 Run the complete formatting, lint, type-check, unit, integration, and migration suites and verify all project quality gates pass from a clean checkout.
- [ ] 10.2 Execute security acceptance tests for unknown chats/users, ambient group messages, tool allowlist expansion, disabled coding tools, malicious tool output, and secret redaction; verify every case fails closed as specified.
- [ ] 10.3 Execute restart acceptance tests during Telegram processing, agent completion, MCP execution, response delivery, calendar synchronization, and reminder delivery; verify no restart causes duplicate agent/tool execution or duplicate successful notifications.
- [ ] 10.4 Perform a staged smoke test with the real Telegram bot and reviewed Home Assistant MCP endpoint before household rollout; verify authorized DM/group behavior and enabled non-critical operations while unauthorized and unlisted operations remain inaccessible.
