# Proposal

## Why

Klaus can understand Telegram images but cannot create and return an image when a household member asks for one. Adding an explicitly enabled image-generation capability, with provider-specific behavior isolated behind a neutral boundary and generated media delivered through the existing durable outbox, enables this workflow without coupling agent tools or Telegram delivery to Codex.

## What Changes

- Add an optional `generate_image` application tool that accepts a bounded text prompt and produces one image per invocation.
- Add a provider-neutral image-generation service contract and an initial OpenAI Codex adapter using Pi-managed `openai-codex` authentication and Codex's dedicated image endpoint.
- Keep provider URLs, authentication headers, image-model identifiers, and provider response formats inside the adapter and composition configuration rather than exposing them through the generic service or model-visible tool schema.
- Extend durable outbound delivery with an image intent that stores validated image bytes in SQLite and uploads them to the originating Telegram chat with `sendPhoto`.
- Report generation as queued only after the image is durably enqueued; preserve delivery retries and deduplication across process restarts.
- Add operator configuration for enabling image generation and bounding prompts, generation time, provider response size, and Telegram-compatible output size.
- Expose optional capability health and failures without disrupting text conversations or other healthy tools.
- Keep image editing, image-to-image generation, arbitrary provider options, multiple images per tool call, proactive delivery to another chat, and generated-image admission into conversational context out of scope.

## Capabilities

### New Capabilities

- `image-generation`: Operator-controlled, provider-neutral text-to-image generation through a bounded agent tool, with isolated provider authentication and failure behavior.
- `telegram-image-delivery`: Durable, idempotent, privacy-preserving delivery of generated images to the originating Telegram chat.

### Modified Capabilities

None. Existing application-tool, conversation, runtime-authentication, and durable-delivery requirements already cover the shared execution, authentication, auditing, and persistence foundations used by this change.

## Impact

- Affects application configuration, capability composition, Pi model-runtime authentication use, health reporting, tool auditing, and operator documentation.
- Adds an image-generation domain boundary plus an initial provider-specific Codex adapter; no provider-specific fields are added to the public tool schema or generic image contract.
- Extends the SQLite outbox schema, repository types, retention cleanup, backup coverage, delivery worker, and Telegram HTTP client for bounded binary photo payloads.
- Uses existing Node.js platform APIs and installed Pi packages; no new runtime dependency is expected.
- Requires a valid `openai-codex` OAuth session for the initial backend. The current local credential must be refreshed by signing in again before a live provider smoke test.
- Interacts with uncommitted Telegram visual-input work in the current tree, so implementation must preserve and test both inbound and outbound image paths without overwriting those changes.
