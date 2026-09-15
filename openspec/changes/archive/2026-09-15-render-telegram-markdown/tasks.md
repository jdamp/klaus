## 1. Durable rich-text delivery contract

- [x] 1.1 Add and pin the selected CommonMark parser as a direct production dependency and verify `npm ci` installs it from the lockfile without relying on a transitive package.
- [x] 1.2 Add a nullable persisted Telegram parse-mode field to outbox drafts, leases, and the SQLite migration path; verify migration tests retain existing queued rows as plain text and repository round-trip tests retain HTML mode.
- [x] 1.3 Extend the Telegram sender and HTTP client contracts to forward an optional parse mode with `sendMessage`; verify client tests assert the exact JSON payload for both HTML and omitted-mode messages and delivery retry tests preserve the mode.

## 2. Safe CommonMark rendering and chunking

- [x] 2.1 Implement a final-agent CommonMark renderer that emits only escaped Telegram HTML for supported headings, emphasis, strong emphasis, code, links, and lists; verify unit tests cover `**bold**`, nested formatting, safe links, raw HTML, unsupported markup, and literal angle brackets.
- [x] 2.2 Implement structural rich-text chunking that respects the Telegram limit and yields independently valid HTML chunks; verify tests cover nested spans across boundaries, long code blocks, links, Unicode, and reconstruction of displayed text and formatting semantics.
- [x] 2.3 Render flat and nested lists with bullet glyphs and non-breaking-space indentation; verify renderer tests distinguish top-level and nested markers while preserving hierarchy.

## 3. Response integration

- [x] 3.1 Route successful final agent responses through the renderer and enqueue their chunks with HTML mode while preserving reply context, sequence, and deduplication; verify agent/delivery integration tests observe formatted persisted intents.
- [x] 3.2 Keep command acknowledgements and operational failure responses on the existing plain-text path; verify command and failed-turn tests prove text resembling markup is sent without a parse mode.
- [x] 3.3 Update Telegram API fakes and end-to-end coverage for the additive parse-mode contract; verify rich agent output reaches the fake Telegram sender as HTML while local output remains plain.

## 4. Verification

- [x] 4.1 Run `npm run check` and strict OpenSpec validation for `render-telegram-markdown`; verify formatting, linting, type checking, tests, production build, and change artifacts all pass.
