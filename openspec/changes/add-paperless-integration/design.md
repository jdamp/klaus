# Design

## Context

See `proposal.md` for motivation and scope. Klaus already supports native capability providers and a separately configured MCP surface. `src/integrations/mealie/` supplies the closest pattern: an authenticated HTTP client, domain services, schema-validated tools, `NativeToolExecutor`, health checks, and mounted-secret loading. `AgentToolCatalog.tools({ sessionId })` permits session-bound tools.

Telegram admission currently rejects non-image documents before dispatch. Supported images flow through `TelegramVisualInputLoader` into image-capable model turns; `TelegramApi.getFile` and `downloadFile` already provide bounded in-memory retrieval. `TrustedTurnContext` has chat/message/update/sender identity but no attachments. Updates are durably claimed before dispatch, whereas tool audits currently track individual invocations and do not deduplicate attachment submissions across distinct tool calls.

The user confirmed search, reading, organization, and upload, with one shared household authority in both authorized private chats and the single allowlisted household group. This does not authorize unknown group members or additional chats. Shared bot access also does not grant household users direct access to documents owned by the automation account in the Paperless UI; that must be configured separately by the operator.

### Verified upstream contract

The official latest release checked during discovery was v3.2.1. Its documentation and source establish:

- `Authorization: Token <token>` and `Accept: application/json; version=10`.
- Authenticated responses advertise `X-Api-Version` and `X-Version`; unsupported requested versions produce HTTP 406.
- `/api/documents/` supports mutually exclusive `text`, `title_search`, `query`, and `more_like_id` search modes. Deprecated `title_content` is not the new-client path.
- Root document retrieval exposes latest-version OCR content by default; `?version=<id>` selects a historical version.
- Multipart `POST /api/documents/post_document/` accepts `document` and optional metadata, returning a consumption-task UUID rather than a created document.
- `/api/tasks/?task_id=<uuid>` is paginated in API v10. Task statuses are lowercase `pending`, `started`, `success`, `failure`, and `revoked`; structured results and `related_document_ids` replace older task-result assumptions.

References:

- <https://github.com/paperless-ngx/paperless-ngx/releases/tag/v3.2.1>
- <https://github.com/paperless-ngx/paperless-ngx/blob/v3.2.1/docs/api.md>
- <https://github.com/paperless-ngx/paperless-ngx/blob/v3.2.1/src/documents/views.py>
- <https://github.com/paperless-ngx/paperless-ngx/blob/v3.2.1/src/documents/filters.py>
- <https://github.com/paperless-ngx/paperless-ngx/blob/v3.2.1/src/documents/serialisers.py>
- <https://github.com/paperless-ngx/paperless-ngx/blob/v3.2.1/src/documents/models.py>

No household Paperless endpoint, token, schema, or installed version has been inspected. Compatibility and smoke evidence must be obtained before enabling it; do not infer that the latest upstream release is the installed release.

## Goals / Non-Goals

**Goals:**

- Reuse existing native-tool lifecycle, auditing, and secret handling without coupling Paperless availability to other capabilities.
- Keep executable authority narrow: fixed endpoint methods, validated identifiers/fields, trusted attachment binding, and server-enforced object permissions.
- Make OCR reads resumable and upload outcomes recoverable without retaining attachment bytes in SQLite or depending on a long-running consumer wait.
- Preserve existing Telegram image semantics and delivery behavior.

**Non-Goals:**

- Add a generic integration framework, MCP wrapper, PDF renderer, OCR engine, or arbitrary HTTP bridge.
- Treat model interpretation of document text or upload intent as a new security authority. See the behavioral-policy distinction below.
- Change the outbound media outbox or add unsolicited completion notifications/background task polling.
- Support legacy API fallbacks; the full feature exclusion list is in the proposal.

## Decisions

### 1. Implement a first-party native provider

Add `src/integrations/paperless/{client,types,provider}.ts` and document/organizer services and tool definitions. Register it only when `paperless` configuration is present. Use the capability interface rather than widening a union of every provider class unnecessarily. Reuse `nativeTool` and `NativeToolExecutor`; specialize mutation failure classification in domain services without changing unrelated providers.

Alternative: an in-house MCP server would provide cross-agent reuse but adds transport/discovery/packaging work and another service boundary. Existing third-party MCP servers introduce an unnecessary version-maintenance dependency. Neither benefits this Klaus-only scope.

### 2. Use explicit API v10 compatibility and fixed HTTP authority

Proposed optional configuration: `baseUrl`, optional `publicUrl`, `apiTokenFile`, `requestTimeoutMs`, `uploadTimeoutMs`, `maxResponseBytes`, `maxResultBytes`, `maxUploadBytes`, and `downloadTimeoutMs`. Initial defaults: 30 seconds for ordinary requests, 60 seconds for upload submission, 15 seconds for Telegram retrieval, 2 MiB HTTP response, 64 KiB model result, and 10 MiB attachment bytes. Bound configurable values; cap uploads at the hosted Telegram Bot API's supported download ceiling, initially 20 MiB. These are implementation defaults, not an upstream size guarantee.

Reject non-HTTP(S) URLs, embedded credentials, query strings, and fragments; normalize trailing slashes and preserve an explicitly configured base path. Validate `publicUrl` independently as a user-accessible application root, including a supported deployment subpath. Generate authenticated UI document links beneath it; never invent a public origin or emit credentialed download/share links. Without `publicUrl`, return document IDs without an internal-service fallback link.

Send the token only as an authorization header. Reject redirects; never follow response-provided pagination URLs. Construct bounded page requests locally using validated page numbers. Decode and project allowlisted response fields instead of returning remote objects wholesale; reject oversized responses while reading and cancel the reader.

Probe an authenticated, low-privilege document-list request with a minimal field projection/page size, not an administrative status endpoint. Require successful API v10 negotiation and valid version headers before tool use. HTTP 406 or a mismatched/missing API header is an incompatible condition; 401/403 is an authentication/permission condition. Report version/contract diagnostics without raw response bodies. Keep checks bounded and refresh availability after failures so recovery does not require a restart.

Compatibility targets the verified v10 schema, not a guessed minimum release number. A future server claiming v10 but returning an incompatible shape fails closed with an actionable contract error. Do not silently fall back to v9 or an older third-party client's data model.

### 3. Expose a small domain tool catalog

Proposed tools and shapes:

| Tool | Responsibility |
| --- | --- |
| `paperless_search_documents` | One search mode plus dates, tags with all/any semantics, correspondent, document type, bounded page/size, and allowlisted ordering. |
| `paperless_get_document` | Stable positive document ID, optional version ID, and bounded OCR offset/length; return metadata and a next offset when text remains. |
| `paperless_update_document` | Single-document PATCH of supplied title, created date, tags, correspondent, and document type; read back and verify. |
| `paperless_list_organizers` | Bounded list/search of tags, correspondents, or document types. |
| `paperless_create_organizer` | Explicit bounded creation after an exact-name recheck. |
| `paperless_rename_organizer` | PATCH only the name of a stable organizer ID and verify. |
| `paperless_upload_document` | Submit only the trusted current attachment with optional title/date/organizer assignments. No source/destination argument. |
| `paperless_get_upload_status` | Resolve an origin-chat-scoped durable receipt, query its known task UUID, and verify any resulting document. |

Resolve supplied organizer references as positive IDs or exact names. Reject ambiguous/missing matches with bounded candidate information, rather than dropping filters or creating records automatically. Resolve the entire mutation before sending it. Prefer explicit organizer-creation tools over hidden creation during assignment.

Omitted document fields remain unchanged. `tags: []` clears tags; `correspondent: null` and `documentType: null` clear those relationships. Dates use validated ISO calendar dates. Patch only supplied fields, not a read-modify-write copy of the remote document. Tag assignment is an explicit complete replacement; users wanting additions first read current tags. Creation/rename never configures matching algorithms, inbox behavior, hierarchical parents, owner, or permissions. Duplicate exact names return an existing identity or ambiguity instead of automatic repeat creation.

Search responses include concise IDs/titles/dates/organizers, normalized plain-text highlights, pagination, and optional browser links, not all OCR text. Retrieve metadata and custom-field values read-only; return latest-version text by default and identify a requested historical version. Slice OCR at Unicode-safe character offsets with a byte cap, preserving valid structured pagination information even when truncated. A response exceeding the HTTP ceiling fails explicitly; do not promise local OCR pagination can recover an upstream document too large to retrieve.

### 4. Add a turn-bound attachment channel without changing vision rules

```text
Telegram update
      |
      v
Existing chat/sender authorization and group trigger
      |
      v
Durable update claim --> accepted attachment descriptor
      |                         |
      v                         v
Agent caption + metadata    turn-bound bounded loader
      |                         |
      +--> native upload tool --+--> upload receipt --> Paperless task
```

Add a document-upload attachment descriptor to accepted inputs, retaining PDFs only when Paperless is configured. Image messages retain their existing visual descriptor and can also supply a trusted upload source. First-release upload formats are PDF, JPEG, and PNG, including Telegram photos; WEBP remains supported as visual input but is not promised as an upload format. Broad office formats, TIFF, and URL-based ingestion are deferred. Record these as conservative defaults in operator help rather than claiming Paperless cannot ingest other formats.

Extend the turn context with `chatType` and a server-owned attachment handle whose identity derives from the admitted update/message, not a model argument. Bind upload tools using the session ID. Enforce context existence and both allowlists in the Paperless provider as defense in depth; session identity alone is not authorization. Clear handles and memoized bytes when the turn settles, including cancellation. Cross-chat handles, previous-turn files, arbitrary Telegram IDs, paths, URLs, and caller-selected accounts are unavailable.

For PDFs, prompt the model with the caption and bounded sanitized attachment metadata only. Never inject PDF bytes, base64, extracted local text, or a Telegram download URL into model context. Validate and fetch bytes lazily when the upload tool executes. For supported images, keep the existing model-compatibility check and image prompting behavior; reuse a validated download within the turn when practical. A text-only model can request a PDF upload, but must not bypass existing image-model incompatibility behavior for visual messages. WEBP visual input remains unchanged and an attempted upload receives an unsupported-upload-format result.

The user requests uploads naturally in the attachment caption, such as “upload this invoice to Paperless and tag it Utilities.” Tool descriptions and application-owned integration instructions require explicit user intent; a bare attachment uses a neutral prompt asking what to do and does not imply archiving. This is conversational behavior, not a deterministic natural-language authorization classifier. Hard security authority remains operator enablement, immutable chat/sender checks, and current-attachment binding. Do not add a model-provided `confirmed: true` flag and claim it grants user consent. Tests must cover bare-attachment behavior and prompt injection, but cannot prove universal model compliance.

Alternative: automatic archiving every attachment is simpler but changes user intent and may persist unrelated photos. Mandatory command syntax or interactive confirmation would give a stronger consent boundary, but is not part of this initial conversational UX; add it separately if required. Because upload access expires with the turn, a user responding to a bare-attachment clarification must resend the attachment with an upload caption; uploading files from earlier messages or replies is deferred and must be explained rather than silently attempted.

Validate reported sizes before download and enforce actual streamed byte/time bounds through both Telegram metadata and retrieval. Validate PDF/image signatures and sanitize filenames (strip paths/control characters, bound length, use a safe generated fallback). Signature checks establish supported transport format, not that an arbitrary PDF is benign; Paperless owns full parser/OCR validation. Do not use filesystem staging. Do not load PDFs through `TelegramVisualInputLoader` or require a vision-capable model for them.

### 5. Separate durable submission deduplication from asynchronous consumption

Add an upload-receipt repository/table with a unique key over provider, trusted Telegram update, and source attachment identity; retain origin chat/message/sender metadata, receipt ID, submission state, task UUID when known, resulting document IDs, bounded outcome details, and timestamps. No token, attachment bytes, download URL, raw task payload, or arbitrary document text belongs in the receipt.

Perform validation and reference resolution before claiming a submission. Atomically persist a `submitting` receipt immediately before the POST. Only the transaction winner may POST; different toolCallIds for the same attachment return the recorded outcome. Keep the deduplication key independent of model-selected metadata, so changing tags cannot force a second upload of the same attachment. Attach the trusted updateId to tool audits instead of relying solely on toolCallId.

Submission states:

```text
validated --> submitting --> accepted(task UUID) --> task pending/started
                    |                |                       |
                    v                v                       v
             indeterminate     read-only status       consumed / failed / revoked
```

Return an accepted/queued receipt and task UUID immediately after durable storage; do not poll indefinitely inside upload submission. `paperless_get_upload_status` accepts the receipt ID returned to that originating chat, including across later turns/restarts. It does not expose arbitrary task-list scanning. A temporary empty task result means not yet visible, not upload failure. Recognized pending/started states remain pending. Success is “consumed” only when structured task document references resolve to readable documents; account for duplicate/failed/revoked outcomes without parsing legacy human-readable success strings. Project only safe result fields.

Startup marks orphaned `submitting` rows indeterminate and never re-POSTs. A lost response, abort/timeout after dispatch, unrecognized success payload, or crash before task UUID persistence is indeterminate, even if the server may have accepted bytes. Definitive pre-submission validation or server rejection is a failure. Status lookup timeout is a read failure and preserves a previously accepted receipt. Never describe locally stopping a request as cancelling the server's task. Failed/indeterminate receipts block automatic re-submission of that same attachment; a user can investigate Paperless and deliberately send a new message if another upload is needed.

Backups include receipts, not transient bytes. Apply retention to detailed outcomes while preserving deduplication tombstones for as long as the corresponding update is protected from replay; do not shorten existing update idempotency guarantees. No background worker is needed: task completion is checked on request. If a response-delivery failure occurs after accepted upload, later status inspection reuses the receipt rather than creating another document.

### 6. Treat remote content as data and report mutations honestly

Schema validation and fixed client endpoints, not document instructions, determine executable authority. Application-owned guidance identifies OCR, filenames, organizer names, notes, highlights, and task diagnostics as untrusted data; none can expand permissions or select a new upload source. Strip markup from snippets; structured values remain data through existing Telegram rendering.

Use `NativeToolExecutor` for bounded results and audits, but report creation/PATCH success only after verified state. A committed mutation whose read-back fails reports partial or indeterminate with known identity and stage; it does not claim success or roll back/delete automatically. Error/result objects must be redacted before reaching the tool, audit, logs, health, or persistent session; do not rely only on audit-side redaction while rethrowing a raw upstream error. Reject unknown writable fields and keep tokens/secret paths out of errors.

Document content returned to the model will enter existing persisted sessions/tool audits and may be sent to the configured model provider. This is inherent in reading through Klaus; document it explicitly. Do not mirror the entire Paperless library into memory or SQLite, and do not automatically add extracted private content to shared memory.

## Risks / Trade-offs

- [One automation account exposes a shared document set] -> All enabled household chats share its authority by explicit user decision; keep both Telegram allowlists and server object permissions, and document that all group members can read bot replies even if they cannot invoke it.
- [Natural-language upload intent and OCR prompt injection are not deterministic consent enforcement] -> Use explicit-intent guidance, neutral bare-attachment behavior, adversarial tests, narrow tools, and trusted source binding; a future approval UI would be a separate change.
- [Paperless ingestion workflows may override supplied metadata or trigger external effects] -> Resolve/validate inputs, report final document state during status checks, and review workflows using disposable test documents before household rollout.
- [The installed server may not support the verified API] -> Fail closed at compatibility/contract checks; record actual installed version/schema before activation rather than quietly using legacy paths.
- [The server may accept a POST before Klaus loses its response] -> Persist the submission claim first, report uncertainty, and never automatically replay; exactly-once remote execution cannot be guaranteed without server idempotency support.
- [Large OCR documents or image downloads pressure memory/context] -> Separate wire, tool-result, text-chunk, attachment, and time limits; retrieve lazily and free transient buffers.
- [Automation-owned uploads may be invisible to household browser accounts] -> Configure visibility/default workflows outside Klaus; never add ownership/permission mutations to compensate silently.
- [No background polling means no unsolicited completion message] -> Return a durable receipt and support later status checks; avoid introducing another worker/outbox behavior.

## Migration Plan

1. Add an additive SQLite receipt migration and repository, covered by restart, retention, backup, and upgrade tests. Existing databases and unrelated providers must continue to work without Paperless configuration.
2. Implement and test against mocked official v10 responses, including paginated tasks and version-aware document text. Run formatting, lint, typecheck, tests, and build, then a BuildKit final-image/container smoke test.
3. Provide opt-in config examples and a separate read-only secret mount. Do not place a real token, hostname, household IDs, or installed version into committed artifacts.
4. Against a reviewed staging endpoint, obtain actual version/schema evidence with a least-privilege account and disposable documents/organizers. Verify read/search, creation/rename/assignment, PDF/image upload and status, denial behavior, private/group admission, secret redaction, and isolated outage behavior.
5. Enable only after operator review of shared visibility, Paperless workflows, limits, and installed-version compatibility. This change's planning/apply workflow does not itself authorize household deployment or creation of production documents.
6. Roll back by removing optional Paperless configuration/secret mount and reverting the application image if necessary. Keep the additive receipt table; do not drop accepted/indeterminate upload history or delete remotely created documents automatically.

## Open Questions

- What are the actual staging/household base URL, public application URL, and installed version? These are activation inputs; an incompatible instance remains disabled until upgraded to the supported contract.
- Which Paperless default permissions/workflows should make automation-owned documents visible to the existing household UI accounts? The operator configures this outside the integration; Klaus does not change object permissions.
