## 1. Project Foundation

- [x] 1.1 Initialize the TypeScript/Node.js package, pin Pi SDK and runtime dependencies, and add production/build scripts; verify dependency installation and a clean production build succeed.
- [x] 1.2 Configure formatting, linting, type checking, and the unit/integration test runner; verify each quality command succeeds on the initial scaffold.
- [x] 1.3 Create the modular application entry point and lifecycle interfaces for Telegram, sessions, capabilities, persistence, delivery, and health; verify a composition test can start and stop the service with fake adapters.

## 2. Configuration, Secrets, and Persistence

- [ ] 2.1 Implement validated operator configuration for decimal-string Telegram IDs, provider/model/reasoning selection, Pi authentication path, MCP definitions and tool allowlists, skill paths, limits, and data paths; verify valid fixtures load and security-critical omissions prevent startup.
- [ ] 2.2 Implement file-backed service secret references and centralized redaction utilities; verify Telegram and MCP credential fixtures never appear in serialized config, logs, errors, or health output.
- [ ] 2.3 Add SQLite initialization in WAL mode with versioned migrations for chats, Telegram updates, session entries, tool executions, and outbox messages; verify a fresh database reaches the expected schema and repeated migration is safe.
- [ ] 2.4 Implement repositories and transactions for chats, Telegram update claiming, and ordered Pi session entries; verify uniqueness constraints prevent duplicate update claims and preserve deterministic session entry order.
- [ ] 2.5 Implement repositories for tool audits and outbox delivery; verify lease, retry, completion, cancellation, and deduplication transitions with repository tests.

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
- [ ] 4.5 Implement Pi-managed provider authentication with a configurable writable auth path and a separate bootstrap command; verify refreshed OAuth state survives restart and API-key providers require no application-specific credential parsing.
- [ ] 4.6 Configure Pi resource loading for read-only operator skill paths and explicit reload, with model-driven installation disabled; verify valid skills are discoverable and an invalid skill produces diagnostics without expanding tool authority.
- [ ] 4.7 Translate accepted Telegram inputs into Pi prompts and finalized Pi events into durable response intents; verify agent failures produce a safe user-facing response without recording a successful turn or action.

## 5. MCP and Tool Policy

- [ ] 5.1 Implement the managed Streamable HTTP MCP client lifecycle with URL validation, mounted-token authentication, safe redirect behavior, and a fake MCP server test proving credentials remain transport-only.
- [ ] 5.2 Implement startup/reconnect tool discovery, stable server namespaces, and fail-closed per-server allowlists; verify duplicate names do not collide and newly discovered unlisted tools remain absent from Pi sessions.
- [ ] 5.3 Adapt enabled MCP schemas and calls into Pi tools with local argument validation, cancellation propagation, timeouts, and result-size truncation; verify invalid, cancelled, timed-out, oversized, and successful fake calls produce the expected structured results.
- [ ] 5.4 Add application-level tool execution hooks and redacted audit transitions recorded before and after calls; verify audits distinguish success, failure, timeout, cancellation, and indeterminate interruption without storing credentials.
- [ ] 5.5 Implement MCP connection health, bounded reconnection backoff, and unavailable-capability responses; verify an MCP outage leaves Telegram and unrelated agent conversations operational in degraded mode.
- [ ] 5.6 Add a generic configurable MCP integration fixture representing non-critical household operations; verify only its reviewed fixture allowlist is exposed to the model and no Home Assistant-specific adapter exists.

## 6. Telegram Response Delivery

- [ ] 6.1 Implement deterministic Telegram-safe rendering and ordered splitting of completed responses while preserving triggering-message reply metadata; verify boundary cases reconstruct the original response in order within platform limits.
- [ ] 6.2 Implement the durable Telegram outbox worker with leasing, bounded retry/backoff, and successful-send recording; verify transient failures resume after restart without rerunning the agent.
- [ ] 6.3 Connect finalized agent responses and operational error responses to the outbox; verify each accepted invocation targets only its originating chat.
- [ ] 6.4 Add an end-to-end reactive test using fake Telegram, model, and MCP services; verify authorization, group triggers, tool execution, session persistence, reply delivery, and duplicate-update suppression as one flow.

## 7. Observability and Runtime Lifecycle

- [ ] 7.1 Add structured, privacy-aware logging and correlation identifiers for updates, turns, tools, and deliveries; verify automated redaction tests contain no configured secrets or ignored message content.
- [ ] 7.2 Implement liveness, core readiness, and per-integration degraded health reporting; verify SQLite, provider authentication, or invalid core configuration blocks readiness while an optional MCP outage is reported as degraded.
- [ ] 7.3 Implement bounded graceful shutdown across polling, dispatch queues, active Pi turns, MCP clients, outbox delivery, and SQLite; verify a termination integration test exits cleanly and leaves work in a deterministic recoverable or non-replay state.
- [ ] 7.4 Add retention and maintenance operations for old accepted transcripts, tool audit metadata, completed updates, and deliveries; verify maintenance preserves active sessions, current summaries, pending work, and deduplication guarantees.

## 8. Packaging and Deployment

- [ ] 8.1 Create a pinned multi-stage container build with a non-root runtime user, read-only application filesystem, writable data and Pi-authentication mounts, and a health check; verify the image builds and starts against temporary configuration and storage.
- [ ] 8.2 Add documented local-development and example configuration/secret layouts with safe placeholders, including Telegram ID discovery, Pi OAuth bootstrap, and generic MCP settings; verify the examples pass configuration validation without containing real credentials.
- [ ] 8.3 Add a single-replica k3s deployment example with persistent application and Pi-authentication storage, mounted Secrets, restricted security context, graceful termination, and replacement semantics; verify manifest rendering and policy checks succeed.
- [ ] 8.4 Document SQLite backup, restore, migration, upgrade, and rollback procedures; verify a backup-and-restore smoke test recovers sessions, outbox state, and audit state into a fresh runtime.

## 9. Final Verification

- [ ] 9.1 Run the complete formatting, lint, type-check, unit, integration, and migration suites and verify all project quality gates pass from a clean checkout.
- [ ] 9.2 Execute security acceptance tests for unknown chats/users, ambient group messages, tool allowlist expansion, disabled coding tools, malicious tool output, and secret redaction; verify every case fails closed as specified.
- [ ] 9.3 Execute restart acceptance tests during Telegram processing, agent completion, MCP execution, and response delivery; verify no restart causes duplicate agent/tool execution or duplicate successful responses.
- [ ] 9.4 Document and perform a staged smoke-test checklist for the real Telegram bot and any reviewed generic MCP endpoint before household rollout; verify authorized DM/group behavior and enabled non-critical operations while unauthorized and unlisted operations remain inaccessible.
