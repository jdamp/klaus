# Paperless Document Management Spec Delta

## Purpose

Provide a bounded, authenticated connection to the current official Paperless-ngx API for household document discovery, reading, non-destructive organization, and traceable ingestion.

## ADDED Requirements

### Requirement: Operators can enable a shared authenticated Paperless integration

The system SHALL expose native Paperless capabilities only when an operator configures an HTTP(S) application base URL and mounted API-token file. It SHALL use one shared Paperless account for both authorized private chats and the allowlisted household group, retain immutable sender/chat authorization for every operation, and respect the server's object permissions. The token and secret-file location MUST NOT appear in model context, tool arguments, public configuration, persisted content, audits, health details, or logs.

#### Scenario: Paperless is not configured

- **WHEN** the operator omits Paperless configuration
- **THEN** no Paperless tools are available and unrelated integrations and existing Telegram visual input continue normally

#### Scenario: Authorized private or household group request

- **WHEN** an allowlisted sender invokes Paperless in an allowlisted private chat or explicitly triggers Klaus in the allowlisted household group
- **THEN** the operation uses the configured shared account and replies only in the originating chat

#### Scenario: Missing trusted authorization

- **WHEN** a Paperless tool is invoked without an active trusted turn or its sender/chat is not allowlisted
- **THEN** the operation is rejected before any Paperless request or Telegram attachment retrieval

#### Scenario: Credential handling

- **WHEN** Paperless authenticates a request or returns an error containing the configured credential
- **THEN** the token and its file location are absent from model-visible results and retained or diagnostic output

### Requirement: The integration uses the current official versioned API

The system SHALL send token-authenticated requests explicitly selecting API v10 and verify compatibility through authenticated version headers and required response contracts before operations are used. An unsupported version or incompatible response contract SHALL produce an actionable incompatibility condition, without alternate legacy request paths. The integration MUST NOT depend on a third-party Paperless MCP server.

#### Scenario: Supported current API

- **WHEN** the configured instance accepts API v10 and returns compatible version headers and data
- **THEN** the integration can become healthy and serve its enabled native tools

#### Scenario: Unsupported API version

- **WHEN** the instance rejects API v10 or reports a missing or incompatible API version header
- **THEN** affected tools report incompatibility and do not attempt v9 or deprecated legacy endpoints

#### Scenario: Incompatible task contract

- **WHEN** the server returns a task response that cannot be interpreted under the supported v10 contract
- **THEN** the tool reports a contract error without interpreting legacy free-text messages as successful document creation

### Requirement: Documents can be searched with bounded household filters

The system SHALL search documents using one selected text-search mode, optional created-date bounds, tags with explicit all-or-any semantics, correspondent, and document type. Organizer references SHALL accept stable identifiers or exact names; unresolved or ambiguous references MUST reject the query instead of silently broadening it. Results SHALL contain bounded summaries, plain-text search excerpts where available, stable document identities, and pagination metadata, without returning complete OCR content for every hit.

#### Scenario: Combined household search

- **WHEN** the user searches for text with a date range and tag or correspondent filters
- **THEN** the tool resolves the references, applies all supplied filters, and returns a bounded page with pagination information

#### Scenario: Conflicting search modes

- **WHEN** a caller supplies more than one mutually exclusive search mode
- **THEN** the tool rejects the input before executing a broader or unintended query

#### Scenario: Organizer reference is ambiguous

- **WHEN** a filter name matches multiple visible organizers or no exact organizer
- **THEN** the tool reports the unresolved reference with bounded candidate information and does not omit that filter

### Requirement: Document metadata and OCR text can be read in bounded chunks

The system SHALL retrieve a document by stable positive identifier and return bounded metadata and Unicode-safe OCR chunks with explicit continuation information. Retrieval SHALL use latest-version content by default and support an explicitly selected historical version. Truncation, missing OCR, inaccessible documents, and upstream response-limit failures MUST be distinguished without inventing content.

#### Scenario: Document text exceeds one result chunk

- **WHEN** a readable document contains more OCR text than the requested bounded chunk
- **THEN** the result identifies the document and version, marks remaining content, and supplies a next offset without corrupting text or metadata

#### Scenario: Historical version is requested

- **WHEN** the caller requests a valid version of a readable document
- **THEN** the tool returns text for that version and identifies it rather than silently returning latest-version text

#### Scenario: Document is unavailable or has no OCR text

- **WHEN** a document is not found, access is denied, or its OCR content is empty
- **THEN** the result reports the corresponding condition without fabricating document content

#### Scenario: HTTP response exceeds its bound

- **WHEN** the upstream document response exceeds the configured wire-response limit
- **THEN** retrieval stops and reports a bounded failure rather than claiming the full document was read

### Requirement: Document references use operator-configured browser links

The system SHALL include a browser document link when an operator configures a public application URL, preserving its configured deployment path. Without that URL, results SHALL identify documents without guessing a public address or exposing an internal service origin. Links MUST NOT contain API credentials or create public shares.

#### Scenario: Public URL is configured

- **WHEN** a search, read, update, or consumed-upload result identifies a document and a public application URL is configured
- **THEN** it includes the corresponding browser document link beneath that application URL

#### Scenario: Only an internal API URL is configured

- **WHEN** a document result is returned without a public application URL
- **THEN** the result contains the stable document identity but no guessed browser link or credentialed download link

### Requirement: Document organization is explicit and non-destructive

The system SHALL support changing a single document's title, created date, tags, correspondent, and document type. It SHALL modify only supplied fields, preserve omitted fields, interpret an empty tag list as clearing tags and explicit null relationship values as clearing those relationships, resolve all references before mutation, and verify the resulting state before reporting complete success. It MUST NOT overwrite OCR content, ownership, permissions, or unrelated metadata.

#### Scenario: Selected fields are updated

- **WHEN** the caller supplies a title and tag assignments while omitting other fields
- **THEN** the system updates and verifies only the supplied fields and leaves omitted fields unchanged

#### Scenario: Assignments are cleared

- **WHEN** the caller supplies an empty tag list or an explicit null correspondent or document type
- **THEN** only the supplied relationships are cleared and omitted relationships remain unchanged

#### Scenario: A mutation reference cannot be resolved

- **WHEN** any supplied organizer reference is ambiguous or missing
- **THEN** the entire update is rejected before document mutation and no organizer is created implicitly

#### Scenario: Verification fails after mutation

- **WHEN** Paperless accepts an update but verification fails or does not confirm the requested state
- **THEN** the tool reports a partial or indeterminate outcome with the known document identity and failed stage instead of complete success

### Requirement: Organizational records can be listed created and renamed

The system SHALL provide bounded list/search, explicit creation, and name-only renaming for tags, correspondents, and document types. Creation SHALL recheck exact names and return an existing unambiguous identity or an ambiguity outcome instead of blindly creating duplicates. Creation and rename MUST NOT configure deletion, permission changes, ownership, matching rules, tag hierarchy, or inbox behavior.

#### Scenario: Organizer is explicitly created

- **WHEN** a caller requests a new organizer whose exact name has no existing visible match
- **THEN** the system creates it with supported safe defaults and returns its verified identity and name

#### Scenario: Existing organizer name is supplied for creation

- **WHEN** an exact-name recheck finds one existing organizer
- **THEN** the operation returns that identity without submitting another creation request

#### Scenario: Organizer is renamed

- **WHEN** a caller supplies a valid organizer identity and new name
- **THEN** the system updates only the name and returns verified identity and name without changing permissions or matching behavior

### Requirement: Upload submission is distinct from document consumption

The system SHALL upload a validated trusted Telegram attachment using the official multipart ingestion endpoint with optional supported document metadata. A successful submission SHALL return a durable receipt and consumption-task identity marked accepted or queued, not a claim that OCR or document creation is complete. The system SHALL offer an origin-chat-scoped read-only status operation for known receipts across later turns and restarts.

#### Scenario: Upload is accepted

- **WHEN** Paperless accepts the attachment and returns a valid task UUID
- **THEN** the tool durably records and returns the receipt and task identity with an accepted or queued outcome

#### Scenario: Consumption has not completed

- **WHEN** a known task is pending, started, or not yet visible in task lookup
- **THEN** status inspection reports that processing is not complete and does not resubmit the attachment

#### Scenario: Consumption succeeds

- **WHEN** a known task reports success and its structured document references can be verified as readable documents
- **THEN** the status result reports consumption success with verified document identities and optional browser links

#### Scenario: Consumption fails or is revoked

- **WHEN** a known task reports failure, duplicate rejection, or revocation
- **THEN** the result reports the actual terminal outcome with bounded safe details and no automatic retry

#### Scenario: Receipt is checked from another chat

- **WHEN** a caller requests an upload receipt originating in a different chat
- **THEN** the status operation denies that receipt without enumerating other tasks or disclosing its metadata

### Requirement: Uploads are deduplicated and uncertain submissions are not replayed

The system SHALL durably reserve a submission identity derived from the trusted accepted update and attachment before dispatching an upload. Repeated or concurrent calls for that attachment SHALL reuse its recorded outcome rather than send another upload, even when tool-call identifiers or requested metadata differ. A lost response, interruption, timeout, cancellation after dispatch, or crash before task persistence SHALL be reported as indeterminate and MUST NOT cause automatic re-submission or a claim that the remote task was cancelled.

#### Scenario: Upload tool is called twice

- **WHEN** two calls target the same accepted attachment with different tool-call IDs or metadata
- **THEN** at most one upload request is dispatched and both calls use the same durable submission record

#### Scenario: Klaus restarts during submission

- **WHEN** a submission was reserved but no definitive response was persisted before restart
- **THEN** its outcome becomes indeterminate and startup or later tool execution does not replay the POST

#### Scenario: Read-only task lookup times out

- **WHEN** status inspection fails after a task UUID has already been recorded
- **THEN** the accepted receipt remains available for another status check and the upload is not reclassified as unsubmitted

#### Scenario: Upload history is backed up or retained

- **WHEN** application backup, restore, or retention operates on upload receipts
- **THEN** accepted task references remain recoverable, attachment bytes are absent, and deduplication metadata is preserved for the existing update replay-protection period

### Requirement: Paperless operations are bounded auditable and isolated

The system SHALL validate inputs, propagate cancellation, enforce request/upload deadlines and separate response/result limits, redact secrets before any result or error escapes, and audit operations with their actual outcomes. It SHALL use only operator-configured destinations and supported endpoints, reject redirects, and treat remote document text and metadata as untrusted data rather than authority to perform additional actions. An optional Paperless outage SHALL degrade affected capabilities without preventing unrelated conversations or integrations from operating.

#### Scenario: Upstream outage

- **WHEN** the configured instance is unavailable
- **THEN** affected calls report unavailability, integration health is degraded, and unrelated Klaus capabilities continue operating

#### Scenario: Request redirects or supplies a foreign pagination URL

- **WHEN** Paperless redirects an authenticated request or returns a next-page URL pointing elsewhere
- **THEN** Klaus does not forward credentials to that destination and follows only locally constructed requests beneath the configured application base

#### Scenario: Untrusted document instructs an action

- **WHEN** OCR text, a filename, a search highlight, or task content contains instructions to change authority or ingest another source
- **THEN** that content remains document data, grants no new executable permissions, and cannot supply a filesystem path, URL, or Telegram file identity to the upload operation

#### Scenario: Operation produces a bounded or uncertain outcome

- **WHEN** a request is cancelled, exceeds limits, or has a partial or indeterminate mutation result
- **THEN** the audit and model-visible response identify the actual outcome without treating it as complete success or exposing configured secrets

### Requirement: The native surface excludes destructive and administrative operations

The first release MUST NOT expose document or organizer deletion, ownership/permission changes, public sharing, arbitrary API requests, bulk editing, workflow administration, custom-field schema/value mutations, storage-path management, document-version uploads, or PDF delivery back to Telegram.

#### Scenario: Out-of-scope operation is requested

- **WHEN** the user or model requests an excluded operation through the Paperless integration
- **THEN** no corresponding native operation executes and the integration does not expand its authority through generic HTTP or filesystem tools
