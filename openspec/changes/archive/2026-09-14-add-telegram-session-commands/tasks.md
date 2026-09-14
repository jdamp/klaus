## 1. Persistence and Delivery Foundations

- [x] 1.1 Add a transactional SQLite migration for per-chat model preferences, optional outbox inline-keyboard payloads, and the `cancelled` Telegram-update state; verify migration tests preserve existing rows, constraints, and indexes.
- [x] 1.2 Extend chat/update repositories to read and write model preferences and determinate cancellation outcomes; verify persistence tests cover independent chats, restart reads, unavailable-preference retention, and non-replay of cancelled updates.
- [x] 1.3 Extend outbox drafts, leases, and Telegram sending options with validated inline keyboards; verify delivery tests cover JSON round trips, retry/deduplication, and rejection of invalid reply markup.

## 2. Telegram Command and Callback Transport

- [x] 2.1 Define one visible command catalogue plus the hidden `/help` alias and implement entity-based parsing for private and bot-addressed group forms; verify admission tests cover case normalization, arguments, another bot's suffix, unknown private commands, and unsupported group commands.
- [x] 2.2 Add Telegram client operations for scoped `setMyCommands`, keyboard-bearing `sendMessage`, and best-effort `answerCallbackQuery`; verify HTTP-client tests assert methods, scopes, payloads, and abort signals without exposing the token.
- [x] 2.3 Extend update types and long polling for callback queries and normalize callback admission with bot-message, chat, and sender checks; verify authorized callbacks are accepted while unauthorized, malformed, foreign-message, edited, and duplicate interactions cannot change state.
- [x] 2.4 Synchronize the identical default, all-private, and all-group command scopes after bot identity resolution and before polling; verify component tests cover successful startup and fail-visible registration errors.

## 3. Session Control Operations

- [x] 3.1 Extend the managed-session boundary with read-only model/reasoning/status data, Pi session statistics, available-model refresh, direct model selection, compaction, activity inspection, and targeted abort; verify adapter tests exercise the public Pi APIs and bounded refresh fallback.
- [x] 3.2 Apply the chat's available preferred model during new and restored session creation, falling back without erasing an unavailable preference; verify tests cover cache eviction, process-style restoration, independent chat models, and retention across `/new`.
- [x] 3.3 Implement local `/start`, `/help`, `/status`, and `/new` handling and formatting without `AgentSession.prompt()`; verify command tests assert help parity, complete token/context fields, unknown-context rendering, zero model calls, and fresh-session acknowledgement.
- [x] 3.4 Implement deterministic model sorting, paginated inline keyboards, bounded callback identifiers, exact `/model provider/model-id` selection, and stale/collision failure handling; verify unit tests make every available model reachable and leave preferences unchanged on invalid selection.
- [x] 3.5 Implement `/compact` using Pi manual compaction and durable session persistence; verify tests distinguish successful and no-op compaction, include compaction usage in later status, and never append command text to conversation history.

## 4. Routing and Cancellation

- [x] 4.1 Route local commands and model callbacks separately from ordinary agent turns while resolving active session IDs inside queued work; verify router tests cover same-chat ordering, cross-chat concurrency, callback idempotency, and a message accepted after queued `/new` using the new session.
- [x] 4.2 Route `/stop` outside the per-chat queue and add a consumable user-cancellation marker distinct from shutdown aborts; verify concurrency tests show immediate targeted abort, idle-chat behavior, unaffected other chats, and queued follow-up work continuing normally.
- [x] 4.3 Persist settled entries and completed tool outcomes for user-aborted turns, suppress partial/generic failure responses, and record the source update as `cancelled`; verify turn and MCP tests distinguish user cancellation from failure, timeout, and shutdown-induced indeterminate state.
- [x] 4.4 Wire command dispatch, model preferences, callback acknowledgement, outbox keyboards, and startup catalogue synchronization into application construction and lifecycle; verify composition and shutdown tests preserve start/stop order and health behavior.

## 5. End-to-End Verification and Documentation

- [x] 5.1 Add end-to-end tests proving private and addressed group commands have equal behavior, commands do not invoke the conversational model, model selection is per chat and survives `/new`, status reports Pi usage, and unauthorized callbacks remain inert.
- [x] 5.2 Document the visible command set, direct and inline model selection, per-chat persistence, status accounting limits, compaction cost, stop non-rollback semantics, and rollback command-scope reset; verify documentation examples match the shared command catalogue.
- [x] 5.3 Run `npm run check` and strict OpenSpec validation for `add-telegram-session-commands`; verify formatting, lint, type checking, tests, production build, and all change requirements pass.
