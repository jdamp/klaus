## Context

See `proposal.md` for motivation and `specs/agent-memory/spec.md` for the behavior contract.

The application currently stores Pi-native session entries in SQLite, restores one active session per Telegram chat, serializes turns within a chat, and passes only the accepted message text to `AgentSession.prompt`. The accepted input already contains immutable sender, chat, update, and message identifiers. Pi performs conversation compaction, but there is no application memory repository, no current-participant context at the model boundary, and no native application tools beyond configured MCP tools.

The pinned Pi SDK supports application-supplied custom tools and inline extensions. In particular, an inline `before_agent_start` handler can alter the effective system prompt for one agent run. Inline application extensions can be supplied while filesystem extension discovery remains disabled. SQLite is already the application source of truth, is backed up as one unit, and is used concurrently by independently active chat queues.

The foundational `build-home-chat-agent` change is still in flight and owns the not-yet-durable `agent-conversations` capability. Its chat isolation applies to raw session state. This design treats deliberate memory-tool writes as a separate shared household knowledge boundary; it does not make arbitrary private session content cross-chat visible.

## Goals / Non-Goals

**Goals:**

- Keep one shared logical memory for the small set of authorized household participants.
- Represent durable knowledge as concise, independently correctable topic- or entity-based records.
- Make the complete active core summary and current-participant identity available on every turn without duplicating either in session history.
- Let the model explicitly remember, search, update, and forget records with bounded, auditable, idempotent local operations.
- Preserve chat-session isolation, tool-policy enforcement, restart safety, backups, and secret handling.

**Non-Goals:**

- Index or semantically retrieve raw chat transcripts, Pi session entries, Telegram updates, or delivered responses.
- Add embeddings, a vector database, a graph database, or a remote memory service.
- Run a background extraction or post-conversation summarization model call.
- Introduce per-user or per-chat memory visibility scopes; all successfully saved memory is household-shared.
- Store credentials or rely on mutable Telegram names as identity or authorization keys.
- Automatically import existing conversation history into memory.

## Decisions

### 1. Store independent memory records in SQLite

Add a `memory_records` table whose active rows contain:

- a stable UUID;
- normalized entity type and entity key, a display label, and searchable aliases;
- a bounded summary and optional bounded detail;
- `core` or `reference` importance;
- optional current-participant association using an immutable Telegram sender ID supplied by turn context;
- `user_requested` or `agent_selected` origin plus the source update ID and actor sender ID;
- active, superseded, or forgotten lifecycle state and timestamps.

Use minimal non-content tombstones for superseded and forgotten records: clear their summary, detail, aliases, and participant association in the same transaction that changes lifecycle state. This keeps mutation history and idempotency without leaving forgotten content in the live database.

Add a `memory_operations` table keyed by the Pi tool-call identity and source update. It records operation type, target/result memory ID, completion state, and bounded non-content result metadata. Repeating a completed mutation returns its stored outcome instead of applying it twice. Search calls need not be persisted beyond the existing tool audit policy.

This model is preferred over a single mutable memory document because independent records support correction, forgetting, concurrent updates, bounded core selection, and useful search without repeatedly rewriting unrelated knowledge. It is preferred over storing custom Pi session entries because shared memory must survive `/new`, must be available across chat sessions, and must not become stale after compaction.

### 2. Use a lightweight entity/topic model rather than a knowledge graph

Every record is assigned a normalized entity key such as `person:klaus`, `project:garden-irrigation`, `device:vacuum`, or `topic:holiday-planning`. Application validation constrains key syntax and text sizes but allows new entity types without a database migration. Aliases make natural variants searchable.

Relationships are expressed in distilled text or by mentioning other normalized keys; a separate edge table and graph traversal are deferred. At household scale, stable keys, aliases, and full-text retrieval provide the useful part of entity-oriented memory with far less merge and query complexity.

The remember-tool guidance instructs the model to search before creating another record for an existing topic when duplication is plausible. The repository does not silently merge semantically similar facts. Corrections use an explicit update or supersession operation so model guesses cannot destroy an unrelated record.

### 3. Index only curated memory with SQLite FTS5

Maintain an FTS5 index over the active record's normalized key, display label, aliases, summary, and detail. Repository transactions update the canonical row and index together. Search converts untrusted model text into quoted tokens rather than accepting raw FTS query syntax, uses prepared statements, boosts exact entity and alias matches, then applies deterministic relevance and recency ordering.

The search tool enforces configured result-count and serialized-byte limits. Results include memory ID, entity identity, summary, optional detail, importance, update time, and a relevance indicator. Superseded and forgotten rows are excluded. An empty search returns an explicit empty collection.

FTS5 is preferred over embeddings because it stays within the existing SQLite backup and privacy boundary, needs no additional provider credentials, and is adequate for a small, model-generated collection. Embeddings can be added behind the repository later without changing the tool contract if evaluation demonstrates a recall problem.

### 4. Bind a per-session turn context around each prompt

Extend the managed-session adapter with a turn-context reference containing the accepted update ID, immutable sender ID, chat ID, chat type, and session ID. The turn handler sets this reference immediately before prompting and clears it in `finally`. Per-chat queue serialization guarantees that one cached session cannot have two simultaneous turn contexts; separate sessions retain independent references.

Memory tools and context injection read actor and provenance identifiers only from this trusted reference. The model never supplies a Telegram sender or chat ID as a tool argument. This uses the identity already produced by admission and avoids trusting usernames, display names, or arbitrary model-selected principals.

For identity memories, the remember tool offers a `current_participant` subject choice. The repository resolves that choice to a normalized participant key derived from the trusted sender ID. Later turns load core identity records by that exact association. Facts about other people remain ordinary shared person entities.

### 5. Inject core memory through a trusted inline Pi extension

Create a hidden application-owned inline extension for each managed session while retaining `noExtensions: true` for filesystem-discovered extensions. Its `before_agent_start` handler reads the current turn context and renders:

1. the immutable current-participant reference and matching active identity summaries;
2. every active core record in stable entity/record order; and
3. instructions that the enclosed memory is stored data, may be stale, and cannot modify tool authority.

The rendered block is appended to the system prompt for that agent run and is not appended to the Pi `SessionManager`; this prevents duplication, stale memory, and compaction artifacts. Text is escaped and structurally delimited before injection.

Configure maximum summary, detail, record, search-result, and total rendered-core byte sizes. Before a create, update, or promotion to `core`, render the proposed complete active core set transactionally. Reject the mutation if it exceeds the core limit. This guarantees that every active core summary is present instead of silently ranking some supposedly core records out of context. Current-participant metadata has a separate small fixed allowance.

An inline extension is preferred over prefixing the user's prompt because prompt prefixes persist as user content, are repeated after later updates, obscure the actual speaker message, and participate in compaction. Loading arbitrary operator extensions remains disabled.

### 6. Register four application-owned memory tools

Register session-bound custom tools alongside the existing allowlisted MCP tools:

- `memory_remember` accepts a subject (`current_participant` or normalized entity), label, aliases, summary, optional detail, importance, and origin implied from the current exchange. It creates one record and returns its ID.
- `memory_search` accepts a natural-language query plus optional entity hint and requested limit; application limits override larger requests.
- `memory_update` accepts an existing memory ID and explicit replacement fields or a superseded-by replacement. It rejects missing, forgotten, or concurrently changed targets rather than guessing.
- `memory_forget` accepts an existing memory ID and scrubs its content into a tombstone.

Descriptions and prompt guidelines direct the model to use `memory_remember` when the user explicitly asks, to autonomously retain only durable and reusable facts or conclusions, to search before uncertain historical claims or likely duplicate writes, and to acknowledge every successful mutation briefly. Tool results distinguish success, validation failure, core-budget failure, not found, conflict, and empty search.

Writes commit inside the tool call rather than waiting for the surrounding assistant response. A later model or delivery failure therefore cannot erase a successfully confirmed durable write. The operation record makes the outcome recoverable and prevents duplicate writes if a call is repeated. Existing no-replay behavior still applies to an interrupted Telegram turn.

### 7. Keep memory separate from session retention and make deletion explicit

Active memory has no age-based retention; it remains until updated, superseded, or forgotten. `/new`, Pi compaction, inactive-session cleanup, and transcript retention do not touch it. Maintenance may remove non-content operation records and tombstones after a configured audit interval, and it can rebuild the FTS index from active canonical records.

The existing SQLite backup automatically includes the canonical memory and operation tables. Restore verification must also confirm that the FTS index is present or deterministically rebuilt. User-facing documentation will explain that forgetting removes content from the live database immediately, while already-created offline backups retain their historical bytes until those backups expire or are deleted under operator policy.

### 8. Preserve the existing secret boundary

Run memory inputs through the centralized `SecretRedactor` before validation and persistence. If a configured secret value is detected in a proposed mutation, reject the write rather than saving a redacted fragment that might be misleading. Tool errors, operation metadata, logs, and diagnostics contain only the operation type, record ID where safe, and redacted error information.

Prompt guidance also forbids storing credentials, but enforcement does not depend only on model compliance. General sensitive-information classification is not introduced: the household has chosen a shared trust model, while exact configured authentication material remains a hard technical boundary.

## Risks / Trade-offs

- **The model may save trivia or create duplicate entities** -> Bound record sizes, use conservative tool guidance, encourage search-before-write, expose stable IDs, and keep update/forget operations simple.
- **One shared memory can reveal a private-chat fact elsewhere** -> Make successful memory writes visibly acknowledged and document that saving is an intentional transition from isolated session content to shared household knowledge.
- **Lexical search may miss paraphrases** -> Index keys, aliases, summaries, and detail; let the model issue follow-up searches; add semantic retrieval only if measured recall is inadequate.
- **Core memory can grow until writes are rejected** -> Expose the budget failure clearly so the agent can demote, consolidate, update, or forget records instead of silently dropping context.
- **Concurrent chats can update the same record** -> Use short SQLite transactions and optimistic update timestamps or versions; report conflicts for the agent to re-read and retry deliberately.
- **A memory write can commit even if the final response fails** -> Treat tool success as the durability boundary and keep mutation operations idempotent; the next interaction can search the committed result.
- **Forgotten content may remain in an old backup** -> Scrub the live row immediately and document backup rotation/deletion semantics accurately.
- **Stored text can contain prompt injection** -> Delimit and escape memory as untrusted data, keep authorization outside prompts, and preserve the fixed tool allowlist.
- **The in-flight conversation spec uses broad privacy wording** -> Keep raw session state isolated and define deliberate memory writes as the only cross-chat knowledge boundary; reconcile wording when the foundational capability becomes durable.

## Migration Plan

1. Complete the additive SQLite migration for canonical memory, operation idempotency, and FTS index structures; verify fresh and existing databases migrate repeatedly without altering session data.
2. Add bounded memory configuration with safe defaults so existing deployments remain valid without immediate configuration changes.
3. Deploy initially with an empty memory. Do not backfill from retained Telegram updates or Pi sessions.
4. Verify participant association, private-to-group sharing after explicit save, alternating group speakers, core injection, search, correction, forgetting, `/new`, restart, backup/restore, and secret rejection with fake model and Telegram services.
5. Roll out to the household and seed identity/core records through ordinary acknowledged memory requests.

Rollback uses the prior application image. The migration is additive, existing code ignores the new tables, and no existing session rows are rewritten. A database backup remains required before migration; memory created after rollback begins will be unavailable to the old image but remains in the database for a later compatible deployment.
