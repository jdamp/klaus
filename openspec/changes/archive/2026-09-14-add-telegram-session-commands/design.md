## Context

See `proposal.md` for motivation and the delta specs for required behavior. Telegram currently stores a default five-command catalogue and a conflicting private-chat override, but `TelegramHttpClient` neither reads nor writes command metadata. Admission recognizes only `/new`; private slash commands become model prompts, other advertised group commands are ignored, and `/new` both replaces the active session and prompts the new session.

The router serializes work with `KeyedQueue`, captures the active session ID before queued work starts, and reports all turn failures through one generic path. Pi already supplies the required session operations through `AgentSession`: `getSessionStats()`, `getContextUsage()`, `setModel()`, `compact()`, and `abort()`. Telegram polling currently requests only message updates, and the durable outbox can send only plain text messages.

## Goals / Non-Goals

**Goals:**

- Keep command metadata, parsing, help text, and implemented behavior derived from one catalogue.
- Preserve existing chat-and-sender authorization, update idempotency, durable delivery, and per-chat ordering for commands and callbacks.
- Make model preference a durable chat property rather than a conversation-session property.
- Use Pi's public SDK operations and usage accounting instead of reconstructing them.
- Give `/stop` a deliberate cancellation path distinct from crashes and shutdown interruption.

**Non-Goals:**

- Provider login, logout, credential display, or modification from Telegram.
- A model allowlist beyond Pi's authenticated-backend availability result.
- Provider subscription quota or rate-limit reporting; status reports only usage and cost recorded by Pi.
- Reversing tool effects completed before cancellation.
- Resuming or browsing prior conversation sessions from Telegram.

## Decisions

### 1. Use one application command catalogue for registration and routing

Define one immutable catalogue containing command names, descriptions, visibility, and aliases. On Telegram startup, after `getMe` and before polling, register the six visible commands for the default, all-private-chat, and all-group-chat scopes. `/help` remains parseable but is omitted from registration. Failure to synchronize the catalogue fails Telegram component startup rather than silently serving a known-misleading menu.

Command parsing will require a `bot_command` entity at offset zero, split optional arguments after the entity, compare names case-insensitively, and accept either `/name` or `/name@<current-bot-username>`. An addressed command for another bot is not admitted.

Alternatives considered:

- Clearing only the current private override would repair today's symptom but allow future metadata drift.
- Maintaining separate private and group catalogues would preserve the source of the inconsistency.
- Parsing arbitrary slash-prefixed text without Telegram entities would make accidental text look like control input.

### 2. Normalize messages and callback queries before dispatch

Extend Telegram update types and polling to include `callback_query`. Admission will normalize accepted messages and callbacks into a discriminated interaction type carrying update ID, chat ID, sender ID, reply context, and either ordinary text, a parsed command, or decoded model-selector action. Callback admission verifies the callback sender and containing chat against the existing allowlists and verifies that the callback belongs to a bot-authored selector message.

Claim the Telegram `update_id` before any command state change. Callback query IDs are acknowledged through `answerCallbackQuery` on a best-effort basis to clear the client spinner; durable command results continue through the outbox. Unauthorized callbacks may receive a generic rejection acknowledgement but are not persisted and cannot change state.

Alternatives considered:

- Treating callback data as synthetic message text would blur security checks and risk sending it to the model.
- Handling callbacks without durable update claims would permit repeated model changes after redelivery.

### 3. Route local commands separately from agent prompts

Introduce a local command dispatcher backed by session-control and outbox interfaces. `/start`, `/help`, `/status`, `/model`, `/compact`, and `/new`, along with model-selector callbacks, normally execute on the existing per-chat queue. Ordinary messages continue to use the agent turn handler. Unknown private bot commands receive a local help error; unsupported group commands do not become ambient triggers.

Resolve the chat's active session ID inside the queued closure, not when the update is admitted. This ensures a message accepted after a queued `/new` observes the new active session. Local command results use the existing response dedupe key convention and are never appended to Pi conversation entries.

`/stop` is the only out-of-band command. After authorization and durable claim it calls a targeted session-registry abort operation immediately rather than entering the chat queue. Other queued Telegram interactions remain queued.

Alternatives considered:

- Sending commands through `AgentSession.prompt()` would spend tokens, expose control semantics to model interpretation, and cannot implement timely stop.
- Putting `/stop` on the per-chat queue would make it wait for the work it must cancel.

### 4. Persist model preference per chat and make it authoritative for session creation

Add durable chat model-preference storage keyed by chat ID with provider and model ID. Session acquisition receives the chat preference and resolves it against `ModelRuntime.getAvailable()`. If available, it is the desired model for both restored and newly created sessions. If unavailable, session creation uses the configured model without deleting or replacing the preference.

A selection command first resolves an exact available model and calls `AgentSession.setModel()` on the active session. After the session entries are persisted successfully, it stores the chat preference and only then acknowledges success. Cached sessions are therefore updated immediately, while recreated sessions derive the same choice from chat storage. `/new` changes only `active_session_id` and leaves the preference untouched.

The current factory optimization that compares restored model entries only with the configured model will instead compare against the resolved desired model. This avoids reverting chat-selected models after cache eviction while still avoiding duplicate model-change entries.

Alternatives considered:

- Relying only on Pi model-change entries cannot carry a preference across `/new` and is currently overridden during recreation.
- A global preference would couple otherwise isolated private and group chats.
- Erasing an unavailable preference would violate retention and make temporary backend outages destructive.

### 5. Build the model selector from Pi availability with bounded refresh

Opening `/model` requests a bounded network-enabled Pi catalogue refresh, then calls `getAvailable()` and falls back to the last available snapshot with a warning if refresh fails or times out. Sort models by provider and model ID and paginate them into bounded inline keyboards. Direct `/model provider/model-id` uses case-insensitive exact reference matching over the same availability set; ambiguous or unavailable references do not change state.

Telegram callback data is limited to 64 bytes, so model buttons carry a versioned action plus a truncated base64url SHA-256 digest of `provider + NUL + model-id`, not the full identifier. On callback, recompute candidate digests from the current availability set and require exactly one match. Page actions carry only the requested page number. Stale, malformed, unavailable, or colliding choices fail closed and direct the user to reopen `/model`.

Selector and pagination messages are delivered through the outbox with an optional serialized inline keyboard. Pagination may send a new selector page rather than requiring durable edit-message operations; old buttons remain safe because every callback is revalidated.

Alternatives considered:

- Full model references can exceed Telegram's callback-data limit.
- Runtime-only numeric indexes become unsafe when catalogues reorder or the process restarts.
- Persisting every selector snapshot adds expiry and cleanup state without improving the selected model's authoritative validation.

### 6. Use Pi's native status and compaction APIs

`/status` obtains the active managed session and formats `getSessionStats()` plus model and reasoning state. Cumulative input, output, cache-read, cache-write, total tokens, and reported cost include compacted history. `contextUsage.tokens` and `percent` are rendered as unknown when Pi returns null or unavailable, rather than coerced to zero.

`/compact` runs on the chat queue, invokes `AgentSession.compact()`, persists the resulting entries, and maps Pi's no-op preparation result to an informational response. It does not pass custom Telegram text to the summarizer in this change. Compaction may consume model tokens, which appear in later status totals.

Alternatives considered:

- Aggregating raw SQLite JSON independently would duplicate Pi's accounting and context-estimation rules.
- Treating no-op compaction as a generic turn failure would provide misleading operational feedback.

### 7. Track user cancellation independently from shutdown aborts

The session registry will expose targeted inspection and abort without creating a session solely to stop it. A user stop marks a cancellation request for that active session, calls Pi's `abort()`, and waits for settlement. The turn handler detects the user-cancelled outcome, persists settled/aborted entries, suppresses partial and generic failure responses, and raises a typed cancellation result so the router records the original update as `cancelled`. Shutdown-driven `abortAll()` does not set this marker and retains the existing indeterminate shutdown semantics.

The stop interaction itself is completed and receives `Stopped` or `Nothing is running`. MCP tools already receive Pi's abort signal and record cancellation when the request honors it; a tool result completed before abort remains unchanged.

Alternatives considered:

- Recording user cancellation as `failed` loses the distinction needed for support and testing.
- Recording every Pi abort as cancelled would incorrectly make crash or shutdown uncertainty determinate.

### 8. Extend persistence and delivery compatibly

Add a migration for durable chat model preferences, optional outbox inline-keyboard JSON, and a rebuilt `telegram_updates` state constraint that includes `cancelled`. Existing rows and indexes are copied without changing their state. Invalid serialized reply markup is rejected before enqueue rather than passed through from conversation content.

Extend Telegram `sendMessage` options to carry the validated keyboard and add `setMyCommands` and `answerCallbackQuery` methods. Command output and selector messages retain normal outbox leasing, retry, and deduplication behavior; callback spinner acknowledgement remains transient because replaying it after a long delay has no value.

## Risks / Trade-offs

- [The available model catalogue can be large or temporarily stale] -> Use bounded refresh, deterministic sorting, pagination, and explicit cached-result warnings.
- [A selected model becomes unavailable] -> Retain the preference, use the configured fallback for session creation, and expose the effective model in `/status`.
- [Old selector buttons remain visible] -> Revalidate every callback against current availability and fail closed on stale or ambiguous digests.
- [Stop races with turn completion] -> Inspect session activity and use one consumable user-cancellation marker; acknowledge `Nothing is running` when completion wins the race.
- [Cancellation cannot undo a completed external effect] -> Preserve tool audit outcomes and word acknowledgements only as interruption, never rollback.
- [Telegram command registration applies beyond authorized chats] -> Keep runtime authorization authoritative; command visibility grants no access. Register all generic scopes to eliminate the observed precedence mismatch.
- [A menu synchronization outage delays startup] -> Surface the failure through normal component startup/health behavior rather than operating with misleading controls.
- [Schema migration rebuilds the update table] -> Perform it transactionally after backup and verify row counts and indexes in migration tests.

## Migration Plan

1. Back up SQLite using the existing online backup operation.
2. Deploy the schema migration and application changes as one single-replica rollout.
3. On startup, migrate existing updates and chats, synchronize all three Telegram command scopes, then begin polling messages and callbacks.
4. Verify equal private/group menus, local `/status`, model pagination and selection, model retention across `/new`, and targeted `/stop` in staging.
5. For rollback, stop the consumer, restore the previous application image, and reset or delete the new Telegram command scopes so the old binary does not advertise unsupported commands. The added preference table and outbox column remain backward-compatible; cancelled update rows remain non-replayable.
