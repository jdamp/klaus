## Why

The household needs a shared, readable notebook of useful knowledge that survives individual chat sessions. The agent should preserve preferences, decisions, and discussion findings, keep a small overview always available, and let participants inspect exactly what it remembers.

## What Changes

- Add one shared memory containing readable topic notes with stable IDs, titles, prose bodies, optional tags, revisions, timestamps, and lightweight source attribution. Every authorized participant can read and maintain every note.
- Keep one bounded `Overview` note available at the start of each conversational turn. Ordinary notes remain independently storable when the overview is full.
- Expose `memory_list`, `memory_read`, `memory_search`, `memory_save`, and `memory_delete` for browsing, retrieval, and revision-checked editing.
- Add `/memory` for paginated browsing and `/memory <note-id>` for directly reading stored content without model paraphrasing or a model invocation.
- Preserve speaker attribution in working conversation history and compaction so discussions can be summarized accurately when participants alternate.
- Guide the agent to save explicit remember requests and useful discussion conclusions, distinguish tentative ideas from decisions, revise related notes, and acknowledge successful changes. Autonomous capture is best-effort.
- Keep raw chat sessions separate while making deliberately saved knowledge shared. Define deletion as removal from the notebook and future retrieval, without promising erasure of earlier conversation mentions or backups.
- Use the existing SQLite database and local full-text search, without adding transcript indexing, embeddings, a knowledge graph, or a background summarizer.

## Capabilities

### New Capabilities

- `agent-memory`: Shared readable notes, one overview, browse/read/search/save/delete tools, revision checks, capture guidance, and durable notebook behavior.

### Modified Capabilities

- `agent-conversations`: Permit shared saved knowledge alongside separate chat sessions, preserve historical speaker attribution, and retain notebook access across `/new`.
- `telegram-session-commands`: Add `/memory` to the command catalogue and expose direct notebook browsing and reading.
- `agent-prompt-configuration`: Define the configured prompt as the base instructions, with the same per-turn overview and speaker context added for built-in and custom prompts.

## Impact

- Adds note and lightweight mutation-receipt storage plus an FTS5 index to the existing SQLite persistence and backup boundary, including an additive compatibility migration from the legacy reserved title `Household overview` to `Overview`.
- Extends the Pi adapter, turn handling, application composition, and native tool registration with notebook access and per-turn context.
- Extends Telegram command parsing, registration, help, and local command delivery with paginated plain-text notebook inspection.
- Adds bounded note/overview/response configuration and operational documentation. No per-participant memory permissions, entity taxonomy, supersession workflow, or scheduled cleanup service is introduced.
- Adds behavioral evaluation for useful capture, attribution, uncertainty preservation, correction, and recall, alongside repository and integration tests.
