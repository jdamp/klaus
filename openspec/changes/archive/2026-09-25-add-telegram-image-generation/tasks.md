# Tasks

## 1. Neutral Contracts, Configuration, and Trusted Context

- [x] 1.1 Add optional discriminated `imageGeneration` configuration with the Codex backend selector and prompt, request-time, response-byte, and decoded-image limits; verify configuration tests cover defaults, omission, unsupported backends, invalid limits, public output, and examples without exposing provider credentials.
- [x] 1.2 Define provider-neutral image request/result/generator types plus shared PNG/JPEG signature and byte-bound validation; verify unit tests accept valid bounded images and reject empty, unsupported, mismatched, and oversized bytes without referencing Codex fields.
- [x] 1.3 Add a provider-independent session-keyed trusted turn-context reader containing chat, message, update, and sender identity, install and token-clear it in `AgentTurnHandler`, and reconcile it with the existing memory and visual-input paths; verify turn tests cover context availability during a tool call, cleanup after success/failure/cancellation, and unchanged inbound visual handling.
- [x] 1.4 Extend the native-tool execution path to provide `toolCallId` and trusted update attribution where required while keeping existing providers source-compatible; verify capability and audit tests cover success, timeout, cancellation, and bounded metadata without leaking binary results.

## 2. Durable Photo Outbox

- [x] 2.1 Add an additive SQLite migration for text/photo delivery kind, binary photo payload, and media type while defaulting every existing row to text; verify fresh-database and prior-schema migration tests preserve pending, leased, sent, formatted, and keyboard-bearing text rows.
- [x] 2.2 Refactor outbox draft and leased-message APIs into validated discriminated text/photo unions, add idempotent photo enqueue/lookup using the existing unique dedupe key, and fail closed on malformed stored combinations; verify repository tests cover both variants, duplicate publication, reply identity, BLOB round trips, and malformed rows.
- [x] 2.3 Update retention cleanup to erase old sent/cancelled photo bytes and media metadata while retaining pending payloads, and extend backup/restore coverage for pending photos; verify maintenance and backup tests prove recoverability before delivery and content removal after the retention cutoff.

## 3. Telegram Photo Delivery

- [x] 3.1 Add `sendPhoto` to the Telegram delivery contract and implement bounded multipart upload with a typed `Blob`, deterministic filename, trusted chat, and JSON reply parameters without manually setting the multipart boundary; verify HTTP fixtures inspect form fields, filename/media type, cancellation, Telegram envelopes, and error messages without rendering image content.
- [x] 3.2 Dispatch leased text and photo variants through their matching Telegram operations in `OutboxWorker` while preserving lease, exponential backoff, sent message IDs, shutdown, and health behavior; verify mixed-outbox tests cover successful text/photo delivery, photo retry from identical stored bytes, independent retry counts, and no generator invocation.
- [x] 3.3 Add defensive Telegram-compatible byte and media validation before photo upload while retaining the stricter enqueue-time bound; verify oversized or unsupported payload tests perform no Telegram request and do not alter unrelated text intents.

## 4. Isolated Codex Image Adapter

- [x] 4.1 Implement a Codex-specific image generator that resolves `openai-codex` authentication through `ModelRuntime.getAuth`, derives account routing only inside the adapter, and posts the fixed `gpt-image-2` auto-settings request to the non-redirecting Codex image endpoint; verify injected-runtime/fetch tests assert request URL, headers, payload, cancellation, and absence of direct auth-file access.
- [x] 4.2 Implement incremental provider-response bounds, strict exactly-one-image parsing, pre-decode base64 bounds, strict decoding, and neutral PNG/JPEG output conversion; verify fixtures cover fragmented reads, missing/empty/multiple data, invalid base64, mismatched magic bytes, oversized encoded/decoded content, and one valid response.
- [x] 4.3 Bound and redact adapter failures so tokens, account identifiers, prompts, response bodies, and image data cannot enter thrown messages or diagnostics; verify authentication, redirect, HTTP, malformed-token, quota, and private-response fixtures contain only safe status/category details.
- [x] 4.4 Add privacy-safe adapter/capability health that checks authentication without generating paid media, degrades on auth or call failure, and recovers after a valid call; verify tests prove startup outage isolation, no generation probe, healthy-capability continuity, and later recovery.

## 5. Image Generation Capability

- [x] 5.1 Implement the optional `ImageGenerationProvider` and model-visible `generate_image` schema with only a bounded `prompt`; verify catalogue/session tests show the tool absent when unconfigured, present when enabled, compatible with other tools, and free of provider/model/endpoint/destination parameters.
- [x] 5.2 Implement generate-validate-publish execution using trusted turn context and an update/tool-call dedupe identity, returning `queued` only after durable insertion and `already_queued` for an existing intent; verify fake-generator tests cover private/group reply targets, cross-chat argument impossibility, publication failure, and one image per invocation.
- [x] 5.3 Propagate combined turn/deadline cancellation through generation and make the enqueue boundary determinate; verify race tests show cancellation before enqueue creates no photo while cancellation after committed tool completion leaves the image deliverable.
- [x] 5.4 Persist only the ordinary tool call and bounded queue result in conversation/audit state, recording image metadata rather than bytes; verify database/session assertions find no base64 or image BLOB outside the outbox and no `sent` claim in the tool result.

## 6. Runtime Composition and Operations

- [x] 6.1 Compose the configured neutral generator, Codex adapter, trusted context, outbox publisher, audit/redaction services, and capability health without changing unconfigured deployments or core readiness; verify runtime tests cover absent configuration, configured healthy/degraded startup, duplicate tool-name protection, shutdown cancellation, and text-chat availability during image failure.
- [x] 6.2 Update local/container examples and the k3s manifest with disabled-by-default image-generation settings and persistent-storage sizing guidance; verify every example parses and deployment tests contain no credential, prompt, account identifier, or generated content.
- [x] 6.3 Update README and operations guidance with capability behavior, Pi/Codex authentication, queue-versus-send semantics, limits, privacy/retention, health, re-login, smoke testing, and the drain-or-cancel rollback sequence; verify documented configuration parses and documented commands match the application CLI.
- [x] 6.4 Add an end-to-end fixture test from an admitted Telegram turn through fake generation, durable photo enqueue, restart/lease, multipart Telegram delivery, and final text delivery; verify the test also proves duplicate updates do not regenerate or redeliver and existing inbound visual-input scenarios still pass.

## 7. Verification and Staged Rollout

- [x] 7.1 Run formatting, linting, type checking, all tests, production build, and strict OpenSpec validation for `add-telegram-image-generation`; verify every command succeeds without modifying or dropping the existing visual-input work.
- [x] 7.2 Re-authenticate `openai-codex` in the protected Pi auth location, then run a privacy-safe live adapter smoke test with disposable content; verify exactly one bounded image is returned and no credential, account claim, prompt, response body, or image data is written to diagnostics.
- [x] 7.3 Back up SQLite, enable image generation in staging, and verify a private and group request each receive one photo replying to the correct message, an intentionally interrupted delivery resumes after restart without regeneration, and text conversations continue during an image-provider failure.
- [x] 7.4 Inspect staged logs, health output, tool audits, session entries, outbox text fields, and backup/retention behavior; verify generated bytes exist only in eligible outbox BLOBs/backups, sent media is erased after retention, and rollback can drain or cancel all pending photo intents before an older binary starts.
