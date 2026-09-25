# Proposal

## Why

Klaus currently discards Telegram messages that do not contain non-empty text, so household members cannot ask it to inspect a photo or an image sent as a file. Pi already supports image attachments and the configured default model is image-capable, making bounded Telegram image ingestion the missing integration.

## What Changes

- Accept authorized Telegram photos and static JPEG, PNG, or WebP documents as conversational inputs, with or without captions.
- Apply the existing private-chat and explicit group-trigger rules to image captions and replies before downloading any content.
- Resolve and download accepted Telegram files with explicit byte and time limits, then validate their supported media type before model invocation.
- Attach validated images directly to Pi prompts while preserving sender attribution and using a neutral instruction when no caption is present.
- Return a determinate local response for unsupported, oversized, unavailable, or model-incompatible images without invoking tools or silently dropping visual content.
- Preserve accepted visual turns through the existing durable Pi session mechanism.
- Keep audio, video, video notes, stickers, animated images, and media-group aggregation out of scope.

## Capabilities

### New Capabilities

- `telegram-visual-input`: Supported visual media, bounded retrieval and validation, multimodal prompt construction, model compatibility, and media-specific failure behavior.

### Modified Capabilities

- `telegram-chat-access`: Extend private and group message admission from text-only content to supported visual messages and caption entities while preserving authorization and explicit-trigger guarantees.
- `agent-conversations`: Clarify that accepted image content is durable conversation state and remains isolated by Telegram chat.

## Impact

- Telegram update and accepted-input types, admission logic, API client file retrieval, routing, and runtime wiring.
- Agent turn construction and Pi prompt options.
- Configuration for visual download size and timeout bounds.
- SQLite session-entry size and backup growth because Pi stores image content in conversation history.
- Telegram, turn, persistence/restart, configuration, and application composition tests.
- Operator documentation and local/k3s configuration examples.
- No speech-to-text service or new audio dependency is introduced.
