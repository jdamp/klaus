## 1. Telegram Chat-Action Adapter

- [x] 1.1 Extend the Telegram API contract and HTTP client with `sendChatAction(chatId, "typing", signal)` and verify a client test asserts the `sendChatAction` method, chat ID, action body, successful result handling, and abort-signal forwarding.
- [x] 1.2 Update existing Telegram API fakes to satisfy the additive contract and verify typecheck and existing Telegram polling and delivery tests remain green.

## 2. Typing Activity Lifecycle

- [x] 2.1 Add a Telegram-layer typing activity helper that publishes immediately, refreshes sequentially at approximately four-second intervals, and cancels its timer and in-flight request when wrapped work settles; verify deterministic timer tests cover immediate publication, long-turn refresh, no overlapping requests, and cleanup after fulfillment and rejection.
- [x] 2.2 Isolate all initial, refresh, and cancellation publication failures from wrapped work results and verify tests prove both successful and failing turns preserve their original outcome when Telegram chat actions reject or hang until aborted.

## 3. Active-Turn Integration

- [x] 3.1 Wrap the complete `TelegramRouter` per-chat queue callback with the typing activity lifecycle and verify dispatch tests show no action before a same-chat turn reaches the queue front, one independent lifecycle per concurrently active chat, and cleanup after successful or failed update finalization.
- [x] 3.2 Verify routing tests show unauthorized, ambient, edited, bot-authored, and duplicate updates publish no typing actions and preserve existing admission and idempotency behavior.
- [x] 3.3 Wire the shared Telegram HTTP client into the router's typing activity dependency and verify application composition typechecks without adding configuration, persistence, or outbox state.

## 4. Lifecycle and Regression Verification

- [x] 4.1 Extend shutdown/restart coverage to verify an active typing request is cancelled when turn execution is aborted, queue shutdown completes, and the interrupted update retains the existing indeterminate recovery behavior.
- [x] 4.2 Run `npm run check` and verify formatting, linting, typechecking, unit/integration tests, and the production build all pass.
