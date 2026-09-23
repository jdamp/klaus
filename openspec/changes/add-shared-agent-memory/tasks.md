## 1. Notebook Storage

- [x] 1.1 Add validated note, overview, list/search, and full-read limits with compatible defaults; verify every accepted note fits a complete read response and reducing limits below existing content fails clearly without truncation.
- [x] 1.2 Add additive SQLite migrations for notes, the reserved empty overview, compact mutation receipts, and an FTS5 index; verify fresh/existing database upgrades are idempotent and clearing the overview survives restart without reseeding its content.
- [x] 1.3 Implement transactional create, read, revision-checked replacement, and revision-checked delete with admitted-source metadata and execution deduplication; verify concurrent stale edits conflict, retried calls do not duplicate/resurrect notes, and cancelled surrounding turns do not undo committed writes.
- [x] 1.4 Implement overview size enforcement independently of ordinary saves, overview clearing, and transactional removal of exact overview ID references when an ordinary note is deleted; verify ordinary saves succeed at overview capacity and affected revisions are returned.
- [x] 1.5 Implement paginated listing, exact full reads, safely constructed FTS queries, bounded ranked snippets, and derived-index rebuild; verify browsing recovers topics missed by keyword search, complete reads preserve literal bodies, and no transcript tables are searched.

## 2. Tools and Notebook Guidance

- [x] 2.1 Register session-bound `memory_list`, `memory_read`, `memory_search`, `memory_save`, and `memory_delete` alongside existing native/MCP tools through the application's capability policy; verify documented schemas, limits, not-found/conflict outcomes, and unchanged availability of unrelated tools.
- [x] 2.2 Add shared notebook guidance for explicit requests, opportunistic capture, read-before-edit, uncertainty and date preservation, sparse overview edits, and acknowledgements of confirmed outcomes; verify deterministic fixtures exercise these instructions with both built-in and configured base prompts.
- [x] 2.3 Bind trusted turn provenance and preserve existing configured-credential redaction and content-minimizing diagnostic behavior; verify model-supplied author metadata cannot replace the admitted sender and known configured secrets do not enter notebook rows/indexes or diagnostics.

## 3. Attributed Conversation and Overview Context

- [x] 3.1 Persist application-generated sender envelopes with newly accepted user messages while keeping legacy unattributed messages unchanged; verify two alternating group speakers remain distinguishable after restoration and user text cannot impersonate the envelope.
- [x] 3.2 Integrate attribution-preserving guidance into both automatic and manual Pi compaction; verify compaction inputs retain sender information and a focused evaluation preserves authors for retained person-specific statements.
- [x] 3.3 Inject a revision-labelled overview snapshot, current speaker, and memory guidance through a trusted Pi hook for each conversational turn using either base prompt; verify the injected block is not appended to session history, failure to load it is explicit, and successful notebook reads/results may still persist normally.
- [x] 3.4 Handle overview freshness and turn-context cleanup across success, failure, cancellation, session recreation, and concurrent chats; verify updates are visible to immediate explicit reads and the next turn without claiming to refresh other in-flight snapshots.

## 4. Direct Telegram Inspection

- [x] 4.1 Extend the command types, parser, registration catalogue, and help with `/memory`, `/memory list <page>`, and `/memory <note-id>` including `overview`; verify seven synchronized visible commands, the existing help alias, and bot-addressed group forms.
- [x] 4.2 Add deterministic repository-backed command handlers and plain-text outbox delivery for lists and complete notes; verify literal Markdown, revision metadata, ordered multi-message bodies, pagination, invalid arguments, and not-found responses.
- [x] 4.3 Integrate admission and local dispatch so inspection does not invoke or require the model after startup and does not add read text to Pi history; verify all authorized participants see the same notes and unauthorized interactions cannot inspect them.

## 5. Persistence and Behavioral Acceptance

- [x] 5.1 Extend backup/restore and maintenance checks for notes, overview, revisions, receipts, and search-index reconstruction; verify notebook data survives restart, transcript retention, compaction, and `/new`.
- [x] 5.2 Add integration scenarios for private-to-group sharing, revision conflicts, explicit correction, deletion, overview clearing, and response failure after a committed write; verify current notebook reads reflect commits while historical conversation copies remain outside deletion scope.
- [x] 5.3 Create and run a documented real-model evaluation with at least 12 notes and 20 recall questions covering paraphrases, names, abbreviations, mixed-language wording, and no-match cases; require at least 18 correct retrievals or browse/read recoveries and no invented memories for no-match cases, recording model/settings and failure cases.
- [x] 5.4 Evaluate explicit remember requests, a decision with rationale, a tentative option, alternating speakers, corrections that preserve unrelated details, and mundane chat; require explicit-request/attribution/correction cases to succeed and report opportunistic-capture misses separately from deterministic tool-test results.

## 6. Documentation and Verification

- [x] 6.1 Update configuration examples and operator/user documentation for readable notes, overview editing, all five tools, exact `/memory` inspection, shared access, snapshot freshness, cancellation, and logical deletion limits; verify examples parse and document a complete browse/save/read/revise/delete smoke test.
- [x] 6.2 Run relevant formatting, lint, type, migration, tool, command, session, backup, and integration checks, then the complete project test suite and strict OpenSpec validation; verify the capability deltas and implementation agree without relying on scripted tests as proof of model capture/recall quality.
