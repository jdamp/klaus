## Why

Agent responses commonly use CommonMark such as `**bold**`, but Telegram currently receives the raw text without a parse mode or entities and displays that markup literally. Responses need to preserve intended formatting without making delivery retries or oversized-response handling invalid.

## What Changes

- Render completed agent responses from CommonMark into a safe Telegram-supported rich-text representation before delivery.
- Send rendered responses with the corresponding Telegram parse mode while preserving reply context, ordering, and durable outbox retry behavior.
- Split oversized rendered responses into independently valid formatted Telegram messages.
- Leave locally generated command and operational responses as plain text unless they explicitly opt into rich-text rendering.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `telegram-chat-access`: Completed agent responses render supported Markdown formatting in Telegram and preserve valid formatting when split across messages.

## Impact

- Affects agent-response rendering and chunking, outbox payload persistence, the Telegram API client contract, and delivery worker interfaces.
- Adds renderer, transport, persistence, and end-to-end tests for formatting, escaping, retries, and oversized responses.
- Adds a direct, pinned Markdown parsing dependency for the final-agent response renderer.
