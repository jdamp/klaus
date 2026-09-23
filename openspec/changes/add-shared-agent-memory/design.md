## Context

See `proposal.md` for motivation. The service already uses SQLite for durable Pi sessions, updates, tool audits, and delivery, with independent per-chat queues and database backup/restore. The current Pi factory accepts session-specific custom tools and an operator-configurable system prompt. Accepted Telegram inputs carry sender IDs, but the turn handler currently prompts with message text alone.

The durable conversation, command, and prompt specs now exist. Their deltas in this change explicitly permit shared saved knowledge, add notebook commands, preserve attribution, and distinguish base instructions from runtime context. This change does not edit those baseline files before implementation/archive.

## Goals / Non-Goals

**Goals:**

- Provide a readable household notebook that all admitted participants can inspect and maintain.
- Separate durable note storage from a small always-present overview.
- Make edits safe across concurrent chats and expose exact stored text through deterministic reading interfaces.
- Preserve attribution, uncertainty, and rationale when distilling discussions.
- Fit the existing deployment, custom prompt, cancellation, delivery, and backup paths.

**Non-Goals:**

- Per-person visibility or ownership rules, rigid entity keys, a knowledge graph, or an atomic-fact ontology.
- A second transcript store, transcript search, or historical transcript backfill.
- Embeddings, a separate database service, background summarization, or automatic overview regeneration.
- Full revision history, supersession states, semantic deduplication, forensic erasure, or a new cleanup scheduler.
- Editing memories through a filesystem or a separate web UI. Export can be added later.

## Decisions

### 1. Use SQLite to store readable notes

Add `memory_notes` with a stable UUID (and a reserved overview ID), title, body, optional tags, positive integer revision, created/updated timestamps, and lightweight source metadata. Provenance records the most recent writer's admitted sender/update ID plus an optional short source description; it is not an access-control owner or a substitute for dates inside the note.

Bodies are UTF-8 prose and can contain Markdown. One note covers a coherent topic or finding: for example, `Garden / Irrigation` can contain a decision, its rationale, and unresolved questions. People, places, devices, and projects are ordinary titles/tags. Titles need not be unique; IDs determine edit targets. There is no required entity taxonomy or participant-to-entity registry.

Guidance tells the agent to browse/read related notes before editing, preserve still-relevant material, and split oversized topics. Do not automatically merge notes by title or lexical similarity.

SQLite is preferred because it is already the transactional storage and backup boundary. Markdown files would improve direct filesystem editing but introduce another persistence and indexing mechanism. Read tools and a local Telegram command provide inspectability without those costs. PostgreSQL and a remote memory service are unnecessary for a single household instance.

### 2. Keep one explicit Household overview

Seed a reserved `overview` note with title `Household overview`, an empty body, and revision 1. It contains enduring identities, preferences, household context, and optional references to active topics. It is readable/editable with the same tools as other notes and is listed first.

Ordinary saves never consume overview space. Updating the overview is a separate, occasional editorial action using `memory_save` with its ID and revision. If the proposed overview exceeds its limit, leave its prior revision unchanged and return `overview_limit`; the agent can still save the underlying information in an ordinary note and must describe that outcome accurately. There is no automatic promotion or demotion mechanism.

Deleting the overview clears its body and advances its revision, preserving the reserved record. Startup only seeds it if absent and never repopulates a cleared overview. Deleting an ordinary note removes its row and indexed content.

Proposed defaults are an 8 KiB rendered overview, 16 KiB serialized full-note response, and 16 KiB list/search response with at most 20 results. Validate title/tag/body limits together so every accepted note fits a complete `memory_read` response; use UTF-8 byte accounting, not character counts. Reserve the overview and fixed context envelope within the model's context allowance. Defaults are conservative bounds, not exact token predictions. Reject a configuration decrease that would make existing notes or the overview unreadable/oversized; do not silently truncate stored knowledge.

### 3. Offer five tools with simple contracts

| Tool | Input | Result |
|---|---|---|
| `memory_list` | Optional tag and bounded page/cursor | IDs, titles, deterministic body previews, revisions, timestamps, next page |
| `memory_read` | Note ID | Complete stored title/body/tags and revision, or not found |
| `memory_search` | Query, optional tag, bounded limit | Ranked IDs, titles, snippets, revisions, timestamps, more-results indicator |
| `memory_save` | Title/body/tags; for updates, ID and expected revision | Created/updated ID and committed revision, or validation/conflict/limit error |
| `memory_delete` | ID and expected revision | Deleted ID or cleared overview with resulting revision, or conflict/not found |

Updates replace a fully read note using `WHERE id = ? AND revision = ?`, then advance its revision. Deletes also check the revision. A conflict requires another read and deliberate revision; never retry by blindly overwriting. Reject an update to a missing ID instead of recreating it. New notes start at revision 1.

Commit saves/deletes during the tool call. A small `memory_mutations` receipt keyed by admitted update ID plus tool-call ID is committed atomically with the change and FTS update. It holds operation, target ID, and non-content outcome only. Retain these small receipts alongside durable update deduplication without a new cleanup policy. Retries of the same execution return that execution's original receipt; they do not recreate a subsequently deleted note. New tool-call IDs are not semantic deduplication.

A later `/stop`, model failure, or delivery failure does not roll back a committed save. Acknowledgements describe confirmed results and never claim completed writes were cancelled. No acknowledgement can be guaranteed when delivery itself fails.

### 4. Pair lexical search with browsing and exact reads

Index only current note titles, tags, and bodies with SQLite FTS5, maintained transactionally as a derived index. Use prepared statements and safely quoted search terms, title weighting, and stable tie-breaks. Paginate listing and bound search responses; return snippets first and let the agent read selected notes in full.

FTS5 is an initial retrieval choice, not an assumption that lexical matching solves all recall. Tool guidance encourages alternative keywords and title/tag browsing when search misses. At household scale, the list is a useful fallback for finding `Garden / Irrigation` after a query about watering beds.

Evaluate realistic paraphrases, names, abbreviations, and mixed-language examples before rollout. Start with a documented fixture of at least 12 notes and 20 questions: require correct retrieval or browse/read recovery for at least 18 questions, and no invented memories on no-match cases. Record model/settings and failure cases. Embeddings remain a later option if this approach fails to provide useful recall.

### 5. Provide direct Telegram inspection

Extend the existing local command path with:

- `/memory`: first page of note IDs, titles, previews, and instructions; overview first.
- `/memory list <page>`: subsequent list pages.
- `/memory <note-id>`: complete note and revision.
- `/memory overview`: direct access to the reserved overview.

Return plain text from the repository through the existing durable outbox/chunking path. Render note metadata separately from the verbatim body. Splitting into Telegram messages must preserve the complete body and order, including literal Markdown. Reading commands neither invoke the conversational model nor append notebook contents to Pi history. There is no callback protocol or interactive editor needed for v1.

Use the existing sender-plus-chat admission rules and bot-addressed group command form. All authorized household members see the same notebook. Return local help for invalid arguments and a clear not-found response for a removed note. Browse commands remain usable without model-provider availability once the service is running.

### 6. Preserve attribution while keeping overview injection temporary

Bind admitted sender/update/chat identifiers to the session for each turn and clear that reference after success, failure, or cancellation. All mutation provenance comes from this application context; the model cannot forge the recorded writer.

Persist a small application-generated speaker envelope with each new user message, separate from escaped user content. Include the immutable sender ID and a label if supplied, treating the label as descriptive rather than authoritative. The ID remains available if a name changes. Teach compaction to retain speaker attribution for person-specific statements and evaluate that behavior; do not assume a current-speaker header attributes earlier messages. Old unattributed entries stay unattributed rather than being guessed or backfilled.

Use a trusted inline Pi extension to append the overview snapshot and current speaker context to either selected base system prompt at `before_agent_start`. Do not append this injected overview block to `SessionManager`. Note/tool content can still appear naturally in tool results, responses, and compacted history; no broader non-persistence claim is made.

Snapshot the overview at the beginning of each accepted conversational turn. A save during that turn returns its revision immediately; a fresh `memory_read` sees it, and the next turn reloads it. Concurrent runs can retain their earlier snapshots until their next turn. Include overview revision and instruct the agent that newer tool results take precedence over the snapshot and historical mentions. If an overview read fails, stop that turn with a clear local error rather than silently treating the notebook as empty.

Custom prompt files continue to replace the built-in base instructions. Application-owned memory instructions and per-turn context are composed with either source, as specified in the prompt delta. Filesystem extension discovery and existing tool authorization stay unchanged.

### 7. Define notebook maintenance as an editorial task

The agent guidance applies to explicit requests and opportunistic capture during normal turns:

- Save a valid explicit remember request, or explain a concrete failure/ambiguity without claiming success.
- Preserve useful conclusions, rationale, relevant dates, and unresolved questions.
- Read before revising; update a related coherent note and preserve unrelated material.
- Distinguish user statements, tentative ideas, confirmed decisions, and agent inferences in prose.
- Avoid conversational filler and speculative personal conclusions.
- Revise the overview sparingly; ordinary notes are the default storage destination.
- Acknowledge what was saved, revised, or deleted after tool confirmation.

Autonomous capture is best-effort, not a guarantee that all important discussion content is retained. No extra model invocation runs after every conversation or compaction. People can inspect and correct the notebook through normal dialogue.

Use real-model behavioral evaluation separately from deterministic tool tests: include explicit requests, a settled decision with rationale, a tentative idea, alternating speakers, corrections, mundane chat, and paraphrased recall. Require the explicit-request/attribution/correction cases to succeed before rollout; report opportunistic-capture misses rather than making an unsupported universal guarantee.

### 8. Give correction and deletion precise limits

Canonical reads and search reflect committed revisions. Current notebook contents are the maintained reference; historical conversation mentions may be obsolete. A fresh user correction can in turn update the notebook.

Deleting an ordinary note removes it from list/read/search and removes exact ID references from the overview in the same transaction, advancing the overview revision if changed. Use explicit Markdown links with a `memory:<note-id>` target for these optional pointers; remove links targeting the deleted ID without interpreting arbitrary prose as a reference. The delete result includes affected revisions. Editorial guidance also requires reviewing the overview for copied summaries when correcting/deleting a note and revising them explicitly. Free-text paraphrases across independent notes cannot be guaranteed to disappear automatically; deletion acknowledgements name what was actually changed.

Deletion does not scrub old user messages, tool results, assistant text, compaction summaries, delivered Telegram messages, or prior backups. It is logical removal from notebook access, not secure erasure of SQLite pages/WAL. Do not claim otherwise. There is no superseded-record state machine or full historical note store.

Notes survive `/new`, chat/session cleanup, restarts, and ordinary transcript retention. Backup includes notes and receipts; verify or rebuild the derived FTS index on restore. Keep the existing application's handling of known configured credentials and safe diagnostic metadata; do not introduce household privacy scopes or attempt a universal secret classifier.

## Risks / Trade-offs

- **Coherent-note replacement can accidentally omit useful facts** -> Require read-before-edit, revision checks, and evaluation that unrelated details survive correction.
- **Lexical retrieval misses vocabulary variants** -> Provide browsing and full reads, measure recovery on paraphrases, and revisit semantic search only with evidence.
- **Overview duplicates some topic content** -> Edit it sparingly, use ID pointers when helpful, and review copies during correction/deletion.
- **Model capture and compaction are probabilistic** -> Use speaker envelopes, focused guidance, inspectable notes, and real-model evaluation without claiming exhaustive capture.
- **Overview snapshots can be stale during a running turn** -> Publish revisions, use fresh reads when needed, and refresh at the next turn.
- **Direct inspection produces several Telegram messages for a large note** -> Bound accepted note sizes and reuse reliable ordered chunking.
- **Memory edits can survive a cancelled response** -> Commit at tool success and retain compact deduplication receipts; document cancellation behavior.

## Migration Plan

1. Apply additive note, receipt, and FTS migrations to existing SQLite; seed only the empty reserved overview. Do not import transcripts.
2. Add default limits and wire repository, session tools, attributed message envelopes, overview context, and command catalogue/help.
3. Verify deterministic persistence/concurrency, custom prompt composition, direct reads, `/new`, cancellation, restore, and authorization scenarios.
4. Run the documented capture/recall evaluation with the configured household model and inspect resulting notes before rollout.
5. Document usage, snapshot freshness, correction/deletion limits, and backup behavior.

Rollback to the prior image leaves added tables unused; existing session entry formats remain Pi-compatible. Previously injected speaker envelopes may remain visible as ordinary attributed text. Back up before migration. This change is planning only and assumes no prior memory schema was deployed.
