## Why

Agent turns can take long enough that Telegram users receive no visible acknowledgement and may assume Klaus missed the message. Showing Telegram's native typing status during active execution provides immediate, non-persistent progress feedback without adding chat messages.

## What Changes

- Publish Telegram's native `typing` chat action when an accepted turn begins active execution.
- Refresh the action while the turn remains active so it does not expire during long model or tool work.
- Stop refreshing when turn processing settles, whether successfully or unsuccessfully.
- Keep chat-action publication best-effort so indicator failures never alter agent processing, update state, or response delivery.
- Do not show the indicator while a turn is merely waiting in the per-chat queue or for rejected, ignored, or duplicate updates.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `telegram-chat-access`: Add user-visible processing feedback for actively executing accepted Telegram turns, including lifecycle and failure-isolation behavior.

## Impact

- Telegram API client contract and HTTP client implementation.
- Telegram routing and per-chat execution lifecycle.
- Application dependency wiring for the chat-action publisher.
- Telegram dispatch, client, failure, concurrency, and shutdown tests.
- No new runtime dependency, durable state, configuration, or public ingress is required.
