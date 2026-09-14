## Why

The household agent currently preserves bounded conversation state per chat, but it cannot retain durable knowledge independently of those sessions or recall important findings after a new session begins. A shared, curated memory will let the agent remember household facts, preferences, people, decisions, and discussion summaries without storing or searching a second copy of complete conversation history.

## What Changes

- Add one durable household-wide memory shared by every authorized participant and chat.
- Organize memory records by topic or entity, with a concise summary, optional distilled detail, importance, provenance, lifecycle state, and timestamps.
- Make bounded core memory and the current speaker's trusted identity available on every model turn without copying it into Pi session history.
- Add native tools that let the agent remember, search, update, and forget memory on explicit user request or when the model identifies durable information worth retaining.
- Keep detailed memory searchable through local SQLite full-text search while excluding raw conversation transcripts from the memory index.
- Keep Pi chat sessions isolated as working context while treating an explicitly saved memory as shared household knowledge that survives `/new` and is available from other authorized chats.
- Preserve the existing prohibition on storing authentication secrets and require visible acknowledgement when memory is created, changed, or forgotten.

## Capabilities

### New Capabilities

- `agent-memory`: Defines shared household memory records, always-available core context, topic/entity search, controlled mutation tools, speaker identity, lifecycle behavior, and privacy boundaries between isolated session history and intentionally shared memory.

### Modified Capabilities

None. The related `agent-conversations` capability currently exists only in the in-flight `build-home-chat-agent` change rather than under the durable spec inventory. This change defines the shared-memory exception explicitly in `agent-memory`; the capabilities must retain the distinction between isolated raw session content and intentionally saved household memory when the foundational change is archived.

## Impact

- Adds SQLite schema and repository behavior for memory records and a local full-text search index; it does not add a transcript archive, vector database, embedding provider, or background summarization service.
- Extends the Pi runtime adapter with application-owned per-turn context injection and native memory tools while keeping coding tools and operator extensions disabled.
- Extends Telegram identity handling or validated configuration so immutable sender IDs resolve to trusted household participant labels on each turn.
- Adds memory configuration for context and result bounds, plus backup, restore, retention, audit, and operational documentation updates.
- Requires tests for cross-chat sharing, speaker changes in group chats, bounded core context, search relevance, mutation acknowledgement, restart recovery, `/new` behavior, and secret exclusion.
