## Why

Telegram currently advertises different command sets in private and group chats because stale server-side command scopes are not owned by the application, while Klaus itself recognizes only the unadvertised `/new` command. Users need one truthful command surface for controlling the current chat's Pi session without routing control commands through the model.

## What Changes

- Register one application-owned Telegram command catalogue for private and group chats: `/start`, `/status`, `/model`, `/compact`, `/stop`, and `/new`, while retaining `/help` as an unadvertised alias for `/start`.
- Parse addressed group forms such as `/status@botname` and handle supported commands locally rather than as model prompts.
- Report the active model, reasoning level, cumulative session token usage and cost, and current context utilization through `/status` without invoking the model.
- Provide a paginated inline Telegram model selector through `/model`, retain exact `/model provider/model-id` selection, and expose every model Pi reports as available from authenticated backends.
- Persist model selection per chat across restarts, cache eviction, compaction, and new conversation sessions; use the configured model only when the chat has no usable selection.
- Make `/compact` invoke Pi's manual compaction operation and make `/stop` interrupt an active turn or compaction without waiting behind that chat's work queue.
- Make `/new` start an empty conversation locally, retain the chat's model selection, and avoid sending the command to the model.
- Admit, authorize, deduplicate, and acknowledge Telegram callback queries used by the model selector with the same chat-and-sender policy as message commands.

## Capabilities

### New Capabilities

- `telegram-session-commands`: Defines the shared command catalogue and the behavior of help, status, model selection, compaction, interruption, and new-session controls.

### Modified Capabilities

- `telegram-chat-access`: Extend authorized, idempotent Telegram admission and response behavior to locally handled commands and model-selector callback queries.
- `agent-conversations`: Preserve a durable per-chat model preference independently of conversation replacement and represent user-requested interruption as a determinate cancellation.

## Impact

- Telegram API integration gains command registration, inline-keyboard message options, callback-query polling and acknowledgement, and possibly selector-message updates.
- Telegram admission, routing, per-chat queueing, turn outcomes, and outbox payloads change to distinguish local control commands from model prompts and to let `/stop` interrupt active work.
- Session services and Pi adapters gain status, model-selection, compaction, cancellation, and model-availability operations.
- SQLite persistence gains durable per-chat model preferences and determinate cancelled-update state, with migration coverage.
- Telegram, session, persistence, runtime, delivery, and end-to-end tests require command, callback, restart, race, and authorization coverage; operator documentation will describe the supported commands and model-selection semantics.
