## Context

See `proposal.md` for motivation and `specs/telegram-chat-access/spec.md` for the behavioral contract. Accepted updates are durably claimed and submitted to a `KeyedQueue` keyed by chat. The queue callback selects the active session, dispatches the agent turn, and finalizes update state. Completed output is placed in a durable outbox and delivered independently. The Telegram client currently supports `getMe`, `getUpdates`, and `sendMessage`, but not `sendChatAction`.

Telegram chat actions are transient and expire unless refreshed. They are presentation feedback rather than durable delivery, so their lifecycle and failure handling must remain separate from both agent correctness and the outbox.

## Goals / Non-Goals

**Goals:**

- Align typing-action lifetime with active execution of the per-chat queue callback.
- Keep refresh work bounded, cancellable, and independent between chats.
- Preserve existing admission, idempotency, serialization, update-finalization, and shutdown behavior when Telegram rejects or cannot receive an action.
- Make lifecycle behavior testable without real time or Telegram access.

**Non-Goals:**

- Indicate queue position or begin typing while a turn waits behind earlier same-chat work.
- Persist, retry, or recover typing actions across restarts.
- Keep typing active while a completed response waits for an outbox retry.
- Add configurable action types or refresh intervals.
- Report model token streaming or intermediate tool-specific statuses.

## Decisions

### Add native chat-action support to the Telegram adapter

Extend the Telegram API abstraction and HTTP client with a `sendChatAction` operation that calls Telegram's endpoint with the originating chat ID and the `typing` action. Keep the chat-action sender contract narrow enough to fake independently in routing tests.

Using a literal status message was rejected because it would create persistent chat noise and require deletion or editing. Reusing `sendMessage` was rejected because Telegram provides purpose-built transient feedback.

### Encapsulate the refresh lifecycle in a best-effort typing activity helper

Introduce a small Telegram-layer helper that starts an immediate action publication, refreshes it on a fixed interval shorter than Telegram's visibility lifetime (approximately four seconds), and cancels its timer and any in-flight request when work settles. The helper wraps asynchronous work and preserves that work's original fulfillment or rejection regardless of action-publication failures.

Action requests must run independently from the wrapped turn so a slow or failed initial action cannot delay model execution. Refreshes should be sequential rather than overlapping. Cancellation and timer functions should be injectable or controllable with fake timers for deterministic tests.

An inline untracked `setInterval` in the router was rejected because it makes overlap, cancellation, rejection handling, and test cleanup easy to get wrong. Sending only once was rejected because long turns would lose the indicator after Telegram expires it.

### Wrap execution inside the keyed queue, not admission or delivery

Invoke the typing helper from inside `TelegramRouter`'s queued callback around session selection, dispatch, and update-state finalization. This is the boundary where a turn becomes active: code before it admits, claims, and queues work; code after dispatch belongs to asynchronous response delivery.

Starting at admission was rejected because same-chat work may still be waiting. Integrating with `AgentTurnHandler` was rejected because it would couple agent orchestration to Telegram presentation and omit routing work such as `/new` session selection. Integrating with `OutboxWorker` was rejected because delivery retries are not active agent execution and could produce prolonged or recovered indicators unrelated to current work.

### Treat typing as non-durable, non-critical feedback

Do not write action attempts to SQLite, use the outbox, alter update state, or degrade core Telegram health when an action fails. Swallow expected publication and cancellation errors within the activity helper. Existing turn errors continue through the router's current safe finalization path.

This favors processing availability over indicator observability. If operational diagnostics are added later, they must remain bounded and contain no message content or credentials.

## Risks / Trade-offs

- **[A response may arrive shortly after the indicator stops]** -> Stop when processing and durable enqueue settle; the outbox normally polls quickly, while delivery outages must not extend an execution indicator.
- **[Telegram timing behavior may vary]** -> Refresh conservatively at roughly four seconds, below the documented action lifetime, and avoid relying on an explicit remote "stop" operation.
- **[A hung HTTP request could outlive the turn]** -> Give each active lifecycle an abort controller and cancel in-flight action publication when wrapped work settles or shutdown aborts the turn.
- **[Concurrent chats increase transient Telegram calls]** -> Maintain one sequential refresh loop per actively executing chat; existing per-chat serialization prevents duplicate active loops for the same chat.
- **[Best-effort failures have limited visibility]** -> Prefer preserving turn behavior; cover failure isolation thoroughly in tests and defer bounded diagnostics unless operational evidence shows a need.

## Migration Plan

1. Deploy the additive Telegram client and routing changes with no data or configuration migration.
2. Verify immediate, refreshed, and stopped typing behavior using fake Telegram and controlled-turn tests before staged bot validation.
3. Roll back by deploying the previous artifact; no persistent typing state or schema cleanup is required.
