## Context

See proposal.md for motivation. Final agent text currently passes unchanged through `enqueueResponse`, character-based splitting, the durable outbox, and `TelegramHttpClient.sendMessage`. The client does not include a Telegram parse mode, so the Bot API treats CommonMark delimiters as plain text. The outbox stores text and reply markup but no formatting mode; retrying a message must reproduce its presentation exactly.

The existing delivery contract preserves reply context, ordering, idempotent outbox retries, and the complete text of oversized responses. Telegram's Markdown dialect is not CommonMark-compatible, particularly for strong emphasis and required escaping.

## Goals / Non-Goals

**Goals:**

- Render supported final-agent CommonMark semantics safely in Telegram.
- Keep formatting selection durable across outbox lease, retry, and restart.
- Produce chunks that Telegram can parse independently without losing displayed text or supported formatting.
- Preserve plain-text behavior for command and operational output by default.

**Non-Goals:**

- Streaming, editing, or deleting Telegram messages.
- Rendering arbitrary raw HTML or every Markdown extension.
- Changing incoming-message parsing, authorization, session contents, or local-command wording.

## Decisions

### Render CommonMark to Telegram HTML, not Telegram Markdown

Introduce a renderer for final agent output that parses a defined CommonMark subset and emits only Telegram-supported HTML tags. Escape all ordinary text and render raw HTML and unsupported constructs as literal text. Map headings, emphasis, strong emphasis, code, links, and lists to Telegram-compatible output. Because Telegram HTML has no native list element, emit each list item with a bullet glyph and non-breaking-space indentation so top-level and nested items retain visible hierarchy; unsafe or unsupported link targets become visible literal text rather than executable markup.

Telegram's `Markdown` and `MarkdownV2` modes are rejected because their syntax and escaping requirements do not match ordinary CommonMark such as `**bold**`. Supplying CommonMark directly would still display or reject valid model output. Sending entities instead of HTML is an alternative, but it requires accurate UTF-16 offset accounting through persistence and chunking; constrained HTML is simpler to inspect, persist, and test.

Use a direct, pinned Markdown parser dependency rather than importing a transitive package. The renderer owns its token-to-Telegram mapping and escaping; it must not forward a parser's arbitrary HTML output.

### Make presentation mode part of a durable outbox message

Extend outbox drafts, stored messages, leases, sender interfaces, and the Telegram client with an optional parse mode. Rendered agent chunks use `HTML`; existing and local plain-text messages leave the mode unset. Persist this value with each outbox record so a retry after restart uses the same text and parse mode.

Always setting HTML for every message is rejected: local command text can include model or provider values that resemble markup, and broad opt-in would require every plain-text producer to perform HTML escaping.

### Split rendered structure, not serialized markup

Render and chunk the final-agent response before enqueueing it. Chunking operates on renderer-controlled HTML tags and visible text, and closes then reopens active formatting around each chunk as needed. It never cuts through an HTML tag, entity, or link target. When formatted or code content cannot fit, divide it into valid same-semantic fragments. Each resulting chunk is independently parseable by Telegram and remains within the existing message limit as measured for delivered text.

Splitting arbitrary raw HTML strings is rejected because it can leave unbalanced tags and cause Telegram to reject a chunk. Splitting CommonMark first is also rejected because an emphasis span or code fence can cross a boundary and cannot be rendered correctly chunk-by-chunk without preserving parser state.

### Preserve existing delivery semantics

The response producer chooses rich text only after a successful final agent result. The outbox worker forwards the persisted mode with the existing text, reply reference, abort signal, keyboard, leasing, and retry behavior. Local responses continue to use the plain mode. Telegram parse failures remain delivery failures subject to existing observability and retry behavior; renderer tests prevent generated payloads from causing them.

## Risks / Trade-offs

- [Telegram supports a narrower HTML subset than browsers] -> Emit a small explicit tag allowlist and verify exact request payloads in client tests.
- [Malformed or model-supplied markup could create unintended formatting or links] -> Parse CommonMark, escape all text, reject raw HTML as markup, and validate link protocols before generating an anchor.
- [Large formatted responses are harder to split than plain text] -> Test nested formatting, long unbroken code, Unicode, links, and boundaries; require every chunk to parse independently.
- [A new outbox column requires compatible rollout] -> Make the stored mode nullable, treat null as plain text, and retain existing rows unchanged during migration.

## Migration Plan

1. Add the nullable presentation-mode migration and pass it through repository and transport contracts.
2. Add renderer and structured chunking tests before routing agent output through it.
3. Deploy the additive change; existing queued rows remain plain text and new completed agent responses render as HTML.
4. To roll back, deploy the previous binary; it ignores the nullable new column and delivers newly queued text as it already does. Rows requiring HTML mode should be allowed to send before rollback or be cleared only with operator review, because the previous binary cannot preserve their formatting.
