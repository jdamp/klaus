# Design

## Context

Telegram currently models only message text and entities, and admission rejects any message without non-empty `text`. The router synchronously admits and durably claims an update before queued execution. `AgentTurnHandler` then sends only a string to Pi and persists Pi's complete session entries in SQLite.

Telegram represents a photo as several size variants and an image file as a `document`; both require `getFile` followed by a token-authenticated file download. Pi 0.85 accepts base64 `ImageContent` through `AgentSession.prompt(text, { images })`, and persists that image in the user message. Pi's model metadata exposes image compatibility through `model.input`, but Pi does not validate or resize images passed directly through this SDK API.

The existing security order remains authoritative: admission, durable update claim, per-chat queue execution, model/tool work, and durable response delivery. See the proposal and capability deltas for externally observable behavior.

## Goals / Non-Goals

**Goals:**

- Add visual input without weakening allowlist, group-trigger, deduplication, queueing, or sender-attribution boundaries.
- Keep Telegram retrieval bounded and entirely in memory.
- Make the effective model's visual compatibility explicit before downloading media.
- Preserve successful visual turns through the existing Pi session persistence path.
- Distinguish deterministic visual-input rejection from an indeterminate model/tool failure.

**Non-Goals:**

- Re-encoding, resizing, OCR, object detection, or generating image thumbnails locally.
- Audio, video, video-note, sticker, GIF, animated PNG/WebP, or multi-image prompt support.
- Combining Telegram `media_group_id` updates into one turn; each admitted update remains independent.
- Automatically changing the selected model or introducing a separate vision model.
- Adding a durable media blob store or temporary files.

## Decisions

### 1. Represent admitted media as metadata until queued execution

Extend Telegram message types with `caption`, `caption_entities`, `photo`, and `document`. Extend conversational `AcceptedTelegramInput` with an optional visual attachment descriptor containing the Telegram file identifier, declared size/type, filename where present, and photo variants needed for bounded selection. The descriptor contains no bytes.

Admission will treat `text`/`entities` and `caption`/`caption_entities` as parallel content sources. It will parse supported commands from either source before conversational dispatch; a command in an image caption remains a local command and the image is not downloaded. Group mentions are recognized only from Telegram entities associated with the selected text or caption. A captionless group image can therefore trigger Klaus only by replying to a bot-authored message.

Private photos and image-like documents can be admitted without text. The accepted input uses the cleaned caption when present and a stable neutral instruction, `Please respond to the attached image.`, otherwise. Image-like documents include documents declared with an `image/*` MIME type or a JPEG/PNG/WebP filename extension; final support is decided from downloaded bytes.

Alternative: download during admission. Rejected because it would place network I/O before the durable claim and could retrieve unauthorized, ambient, or duplicate content.

### 2. Claim before retrieval and retrieve only at the front of the chat queue

The router keeps its current ordering: admit metadata, claim the update, ensure the chat, then enqueue work. Visual preparation runs inside the queued turn and typing activity, so waiting images consume neither download bandwidth nor memory. Duplicate updates fail the claim and never reach retrieval.

The turn first resolves the effective session model and verifies that `model.input` contains `image`. A text-only model produces a local rejection before calling Telegram's file API. This preserves the user's model preference and avoids downloading data that cannot be processed.

Alternative: download immediately after claim but before queueing. Rejected because multiple queued images could consume memory concurrently and Telegram work would no longer follow the chat's serialized execution boundary.

### 3. Add a dedicated bounded Telegram visual loader

Add file retrieval operations to the Telegram API boundary:

1. Resolve a trusted Telegram `file_id` with `getFile`.
2. Download the returned `file_path` only from Telegram's fixed file endpoint.
3. Reject redirects, apply an abortable configured timeout, inspect `Content-Length` when present, and count streamed bytes independently.
4. Return bytes only after the complete response fits the limit.

For Telegram photos, sort variants by pixel area and choose the largest variant whose known `file_size` fits the limit. If size is absent, the best-resolution candidate remains eligible and the streaming bound is authoritative. If all known variants exceed the limit, reject without `getFile` or download. Documents use their single file descriptor and are rejected before retrieval when their known size is too large.

Introduce backward-compatible configuration defaults under `telegram.visualInput`:

- `maxBytes`: 10 MiB, constrained to a positive value no greater than Telegram's hosted Bot API file-download limit.
- `downloadTimeoutMs`: 15 seconds.

The loader holds one bounded byte buffer at a time and converts it to base64 only after validation. It never writes media to disk and never includes the bot token, Telegram file path, or image bytes in logs or errors.

Alternative: rely on Telegram metadata and `response.arrayBuffer()`. Rejected because metadata and `Content-Length` can be missing or inaccurate, while `arrayBuffer()` cannot enforce a streaming memory bound.

### 4. Treat downloaded bytes as authoritative

A small validator identifies canonical media type from encoding signatures: JPEG SOI structure, the PNG signature, or RIFF/WebP structure. The declared document MIME type and recognized filename extension are admission hints only. A mismatch or malformed structure is rejected. PNG `acTL` and WebP animation metadata are rejected to preserve the static-image scope. The resulting Pi attachment uses only the validator's canonical `image/jpeg`, `image/png`, or `image/webp` MIME type.

No local image decoder is needed because Klaus does not render or transform the image. This avoids a native image-processing dependency while still preventing arbitrary document bytes from being labeled as an image.

Alternative: add `sharp` and normalize every image. Rejected for the initial release because it adds native binaries, decoding exposure, CPU/memory cost, and altered image fidelity without being necessary for bounded pass-through.

### 5. Pass the image through Pi's existing prompt and persistence path

After validation, `AgentTurnHandler` builds the existing attributed text prompt and calls:

```text
session.prompt(attributedPrompt, { images: [validatedImage] })
```

The application-supplied sender envelope and memory context remain text-only trusted context; captions remain JSON-quoted user content. Pi records the attributed text and base64 image in its user message, and `SessionEntryRepository.replace` durably stores that entry exactly as it does other Pi session content. Session restoration therefore reconstructs the visual context without a parallel media store.

Alternative: ask a separate vision model for a description and persist only text. Rejected because it adds a second model decision, loses image fidelity for follow-up questions, and can diverge from the chat's selected model.

### 6. Use typed pre-model rejection with durable local delivery

Introduce a visual-input error category for unsupported type, oversize content, invalid bytes, Telegram retrieval failure/timeout, and model incompatibility. These failures occur before `session.prompt`, memory-tool access, or any other tool execution. The turn handler enqueues a bounded plain-text explanation and reports the typed outcome to the router; the router records the claimed update as `failed`, not `indeterminate`, and does not retry it.

Errors after Pi accepts the prompt retain the existing indeterminate/cancellation semantics. User-facing responses reveal only the safe category, never Telegram URLs, response bodies, tokens, or image content.

Alternative: route all failures through the existing generic agent failure. Rejected because it incorrectly describes deterministic input rejection as potentially action-bearing, obscures actionable format/size/model feedback, and weakens acceptance tests.

## Risks / Trade-offs

- **[SQLite and backup growth from base64 images]** -> Enforce a conservative byte limit, document the roughly one-third base64 expansion, retain one image per update, and rely on existing compaction for active model context. Operators can lower the limit; durable raw visual history remains an intentional trade-off.
- **[Repeated provider cost while recent images remain in context]** -> Keep normal Pi compaction and context limits; document that follow-up continuity carries storage and token cost.
- **[In-memory base64 temporarily duplicates the image buffer]** -> Convert only after bounded validation, process at most one queued image per chat turn, and release the binary buffer after Pi accepts the prompt.
- **[Telegram metadata is incomplete or deceptive]** -> Treat metadata as an early rejection hint and enforce streamed bytes plus signature validation independently.
- **[Provider-specific image limits are stricter than Klaus's limit]** -> Keep Klaus's cap conservative; provider rejection after prompt acceptance follows normal agent-failure semantics rather than being misclassified as local validation.
- **[A crash after claim but before completion leaves no automatic replay]** -> Preserve the existing idempotency policy: startup marks interrupted claims indeterminate, preventing duplicate model/tool execution.
- **[Media albums produce multiple replies]** -> Document the initial one-update/one-turn behavior; aggregation remains a separate change because it needs buffering and new idempotency boundaries.

## Migration Plan

1. Deploy the additive configuration schema with defaults so existing configuration remains valid.
2. Deploy Telegram type/admission, bounded retrieval, validation, and Pi prompt changes together; no database migration is required because successful image content is stored inside existing session-entry JSON.
3. Update local and k3s examples and operator documentation with limits, supported formats, persistence cost, and group-trigger behavior.
4. Smoke-test a captioned and captionless photo, JPEG/PNG/WebP documents, a group caption mention, a group reply, an oversized file, malformed bytes, duplicate delivery, restart continuity, and a text-only selected model.
5. Roll back by deploying the prior application version. Existing sessions containing Pi image content remain valid Pi session entries; the older service will restore them even though it cannot admit new Telegram images.
