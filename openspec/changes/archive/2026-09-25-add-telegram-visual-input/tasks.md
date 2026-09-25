# Tasks

## 1. Visual Input Contract and Admission

- [x] 1.1 Add backward-compatible `telegram.visualInput.maxBytes` and `downloadTimeoutMs` configuration with safe defaults and bounds, update configuration tests plus local/container/k3s examples, and verify `npm test -- test/config.test.ts test/deployment.test.ts` passes.
- [x] 1.2 Extend Telegram update and accepted-input types for captions, caption entities, photo variants, image documents, and attachment metadata; verify `npm run typecheck` passes.
- [x] 1.3 Extend admission to authorize captioned and captionless private images, caption-entity mentions and bot replies in groups, caption commands, image-like document hints, and the neutral captionless instruction while preserving text behavior; add admission tests proving unauthorized, ambient, bot-authored, edited, and unsupported non-image media are ignored before retrieval, then verify `npm test -- test/telegram.test.ts` passes.

## 2. Bounded Telegram Image Retrieval

- [x] 2.1 Add Telegram `getFile` resolution and fixed-host file download operations with redirect rejection, abortable timeout, `Content-Length` precheck, streamed byte counting, and sanitized errors; add HTTP-client tests for success, Telegram errors, timeout, redirects, and inaccurate or absent lengths, then verify `npm test -- test/telegram.test.ts` passes.
- [x] 2.2 Implement photo-variant selection that chooses the largest known bounded representation and rejects an entirely oversized set before network access; add tests for known, unknown, and mixed file sizes, then verify the focused visual-loader tests pass.
- [x] 2.3 Implement in-memory JPEG, PNG, and WebP signature validation, canonical MIME derivation, declared-type mismatch rejection, and animated PNG/WebP rejection; add fixture-based unit tests for supported, malformed, mislabeled, animated, and unsupported content, then verify the focused visual-validator tests pass.
- [x] 2.4 Compose selection, retrieval, validation, and base64 conversion into a visual-input loader that never writes media to disk or exposes token/path/content in errors; add bounded-memory and sanitized-failure tests, then verify the focused visual-loader tests pass.

## 3. Multimodal Agent Turns and Failure Semantics

- [x] 3.1 Integrate visual preparation at the front of queued execution, check the effective Pi model's `input` capabilities before retrieval, and pass the validated image through `session.prompt(..., { images })` with the attributed caption; extend turn tests to verify captioned and captionless prompts, sender attribution, no model substitution, and no Telegram retrieval for text-only models, then verify `npm test -- test/turn.test.ts` passes.
- [x] 3.2 Persist successful Pi image messages through the existing session-entry repository and add restart/restore tests proving later same-chat turns retain image context while another chat cannot access it; verify `npm test -- test/persistence.test.ts test/agent.test.ts test/turn.test.ts` passes.
- [x] 3.3 Add typed pre-model visual rejection that durably enqueues a bounded plain-text response, records the update as `failed`, invokes no agent or tool, and never retries; extend router/turn tests for unsupported, oversized, invalid, unavailable, timed-out, and model-incompatible images, then verify `npm test -- test/telegram.test.ts test/turn.test.ts` passes.
- [x] 3.4 Extend dispatch tests to prove an unauthorized, ambient, or duplicate visual update performs no retrieval, same-chat images remain serialized, different chats can progress independently, and media-group updates remain independent; verify `npm test -- test/telegram.test.ts` passes.

## 4. Runtime Integration and Operator Guidance

- [x] 4.1 Wire the visual loader through application composition without changing service startup order or readiness behavior; add composition/runtime tests with a fake Telegram file API and verify `npm test -- test/app/composition.test.ts test/runtime.test.ts` passes.
- [x] 4.2 Document supported formats, captions, private/group invocation, one-update-per-album-item behavior, text-only model errors, configurable limits, in-memory processing, and SQLite/base64 persistence costs in `README.md` and operations guidance; verify documented YAML keys match the parsed example configurations.
- [x] 4.3 Run the complete repository quality gate with `npm run check` and perform the documented visual smoke matrix for private photo, image document, group caption mention, group reply, oversize rejection, malformed input, duplicate delivery, restart continuity, and text-only model selection.
