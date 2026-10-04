# Telegram Document Uploads Spec Delta

## Purpose

Allow authorized household Telegram interactions to supply bounded current-message attachments for explicit Paperless uploads without exposing file-source authority to the model or disrupting existing visual conversations.

## ADDED Requirements

### Requirement: Paperless-enabled chats admit supported upload attachments

When Paperless is configured, the system SHALL admit PDF documents, JPEG and PNG image documents, and Telegram photos after existing chat/sender authorization and group-trigger checks. PDF admission SHALL not require an image-capable model. Without Paperless configuration, non-image documents SHALL retain their existing ignored behavior, and supported image input SHALL remain unchanged. Other non-image formats SHALL not become generic file input.

#### Scenario: Authorized private PDF with caption

- **WHEN** an authorized user sends a PDF with an upload-request caption in an authorized private chat with Paperless configured
- **THEN** the system accepts the caption and attachment descriptor for one agent turn without treating the PDF as a model image

#### Scenario: Explicitly triggered household group attachment

- **WHEN** an authorized group PDF or supported image message mentions Klaus or replies to the bot
- **THEN** the system admits that message under the existing group-trigger policy and retains its originating chat and message identity

#### Scenario: Paperless is disabled

- **WHEN** an authorized user sends a PDF without Paperless configured
- **THEN** the message does not become a generic attachment turn or trigger a file download

#### Scenario: Other document format is supplied

- **WHEN** a user sends a non-image document outside the supported PDF upload format
- **THEN** the integration does not retrieve it or treat it as generic file input

### Requirement: Attachment sources are bound to the current trusted turn

The upload operation SHALL access only the attachment admitted with its active Telegram message and SHALL verify trusted chat/sender authority before retrieval or submission. It MUST NOT accept model-selected Telegram file IDs, cross-chat or previous-turn handles, filesystem paths, arbitrary URLs, attachment bytes, or destination accounts. Attachment access SHALL expire when the turn ends or is cancelled.

#### Scenario: Current attachment is uploaded

- **WHEN** the upload tool runs in an authorized active turn with a supported attachment
- **THEN** it retrieves only the source admitted with that turn and submits only to the configured Paperless instance

#### Scenario: Caller supplies another source

- **WHEN** tool arguments attempt to select an arbitrary file ID, path, URL, another chat's attachment, or a destination account
- **THEN** argument validation or trusted-context checks reject the request before retrieval or submission

#### Scenario: Attachment context expires

- **WHEN** a tool is invoked after the source turn has settled, restarted, or been cancelled
- **THEN** it cannot retrieve or upload the previous turn's attachment

### Requirement: Attachment retrieval and validation have independent bounds

The system SHALL reject known oversized attachments before download, enforce configured streamed byte and retrieval-time limits even when size metadata is absent or inaccurate, validate bytes against the supported transport format, and sanitize filenames before multipart submission. Authorization and durable update claiming MUST precede retrieval. A validation or retrieval failure SHALL produce a bounded local explanation and no upload request.

#### Scenario: Known attachment is oversized

- **WHEN** Telegram message or file metadata reports a size above the configured upload limit
- **THEN** Klaus rejects the source before downloading or uploading its bytes

#### Scenario: Stream exceeds its bound

- **WHEN** a download exceeds the actual byte or time limit despite smaller or missing declared metadata
- **THEN** retrieval stops, the user receives an explicit failure, and no Paperless POST occurs

#### Scenario: PDF metadata hides a different encoding

- **WHEN** an attachment declared as a PDF does not match a supported PDF signature
- **THEN** validation rejects it before upload without passing the bytes into the model

#### Scenario: Filename contains paths or control characters

- **WHEN** a valid attachment supplies an unsafe or excessively long filename
- **THEN** upload uses a bounded sanitized filename or safe fallback without interpreting it as a path

### Requirement: Uploads require explicit conversational user intent

The system SHALL offer attachment upload as an explicit user-requested operation, not automatic archiving. A caption requesting upload SHALL be available to the agent together with safe attachment metadata. A bare attachment or unrelated image request SHALL not itself imply an upload request; Klaus SHALL ask for intent when necessary. Retrieved document text, filenames, or other untrusted content MUST NOT be treated as user upload consent.

#### Scenario: User requests document ingestion

- **WHEN** an authorized user captions a supported attachment with an explicit request to upload it to Paperless
- **THEN** Klaus can invoke the bounded upload operation and report its actual submission result

#### Scenario: User sends an uncaptioned PDF

- **WHEN** an authorized user sends a bare PDF
- **THEN** Klaus asks what the user wants to do with the attachment rather than archiving it automatically

#### Scenario: User asks about an image without requesting upload

- **WHEN** an authorized user asks Klaus to explain a supported image
- **THEN** the existing visual conversation proceeds without an automatic Paperless upload

#### Scenario: Filename contains an upload instruction

- **WHEN** attachment metadata includes text instructing Klaus to upload or change its rules but the user has not requested upload
- **THEN** that metadata is treated as data rather than user intent

### Requirement: Upload transport preserves visual-input and conversation privacy behavior

PDF bytes, base64, and credentialed Telegram file URLs MUST NOT enter model context, tool arguments, operational text, logs, audits, health output, shared memory, or upload-receipt storage. PDF turns SHALL expose only the user caption and bounded sanitized attachment metadata until Paperless later provides requested OCR text. Existing image-to-model delivery, format validation, and image-model compatibility failures SHALL remain unchanged; transient upload bytes SHALL be released when the turn ends.

#### Scenario: PDF reaches a text-only model

- **WHEN** an authorized upload-request PDF targets a text-only model
- **THEN** the model receives caption and safe metadata only and can request upload without seeing the binary file

#### Scenario: Supported image targets a text-only model

- **WHEN** an admitted supported visual image targets a model without image support
- **THEN** Klaus retains the existing explicit incompatibility response rather than silently bypassing it through the upload channel

#### Scenario: WEBP visual input is used

- **WHEN** an authorized user sends valid WEBP visual input
- **THEN** existing visual behavior remains supported while a Paperless upload attempt reports that the initial upload-format set does not include WEBP

#### Scenario: Turn ends after file retrieval

- **WHEN** a turn completes or is cancelled after a supported attachment was retrieved
- **THEN** its transient bytes and upload access are released and no binary content is added to upload receipts or diagnostic records

### Requirement: Attachment handling preserves update idempotency and reply origin

Duplicate, edited, unauthorized, bot-authored, or untriggered ambient group messages MUST NOT cause attachment retrieval, upload, or an additional agent turn. Every upload-related explanation and receipt SHALL return only to the originating chat with existing reply context. Multiple calls and restarts SHALL honor the Paperless submission deduplication contract rather than relying only on per-call audits.

#### Scenario: Telegram redelivers an attachment update

- **WHEN** an attachment update is already durably claimed
- **THEN** the duplicate creates no extra retrieval, turn, or submission

#### Scenario: Ambient attachment appears in the group

- **WHEN** an allowlisted group member sends a file without an existing explicit bot trigger
- **THEN** Klaus ignores it without downloading, persisting its content, or uploading it

#### Scenario: Upload result requests another destination

- **WHEN** model text or tool arguments attempt to direct an upload receipt to another chat
- **THEN** responses still use only the originating trusted chat and reply context
