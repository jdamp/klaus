# Proposal

## Why

Klaus cannot currently find, explain, organize, or ingest household documents in Paperless-ngx. A first-party integration against the current official REST API provides those capabilities without relying on an outdated third-party MCP server.

## What Changes

- Add an optional native Paperless provider using a mounted API token and explicitly versioned requests against the official API v10 contract.
- Provide bounded document search, metadata and OCR-text retrieval, and browser links when a public URL is configured.
- Support non-destructive document organization: titles, document dates, tags, correspondents, and document types; list, create, and rename the associated organizational records.
- Accept Telegram PDF and supported image attachments for explicitly requested uploads, bound and validate their retrieval, and bind the upload tool to the current trusted message rather than model-selected file IDs, URLs, or filesystem paths.
- Report upload acceptance separately from document consumption, retain task references for later checks, and prevent repeat submission of the same accepted attachment across tool calls and restarts.
- Use a shared least-privilege Paperless account in both authorized private chats and the existing allowlisted household group. Preserve sender/chat authorization, group triggers, originating-chat replies, and update idempotency.
- Extend existing credential redaction, tool auditing, cancellation, operational limits, and optional-capability health to Paperless.

## Capabilities

### New Capabilities

- `paperless-document-management`: Authenticated current-API integration, document search/read/organization, bounded upload submission and task tracking, and safe operational outcomes.
- `telegram-document-uploads`: Authorized attachment admission and retrieval for Paperless uploads, trusted turn binding, explicit upload intent, and preservation of existing visual-input behavior.

### Modified Capabilities

- `telegram-chat-access`: Extend existing authorization and private/group invocation requirements to supported upload attachments without admitting ambient group files or broadening user/chat access.

## Impact

- New provider, client, document/organizer services, tools, and response types under `src/integrations/paperless/`, following the native Mealie pattern.
- Optional configuration and secret loading in `src/config.ts` and `src/runtime/application.ts`; session-aware provider registration through the capability catalog.
- Attachment admission/types/loading in `src/telegram/` and trusted attachment context in `src/agent/`; additive persistence for upload receipts and restart-safe submission deduplication.
- New contract, safety, persistence, and regression tests alongside the existing Mealie, Telegram, visual-input, and agent tests.
- Operator documentation and opt-in example/deployment configuration; no new MCP server, startup downloads, or third-party Paperless dependency.

### Non-goals

- Document or organizer deletion, permission/ownership changes, public sharing, arbitrary API access, arbitrary remote/local file ingestion, bulk editing, document-version uploads, or workflow administration.
- PDF delivery back to Telegram, local OCR/PDF parsing, custom-field schema/value mutation, storage-path management, or per-user Paperless identities.
- Legacy API adapters or changes to the existing MCP integrations. This change does not deploy to the household instance or assume its version, URL, or credentials are already known.
