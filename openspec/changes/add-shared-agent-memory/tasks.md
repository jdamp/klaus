## 1. Memory Configuration and Persistence

- [ ] 1.1 Add validated memory limits for record summaries/details, complete core rendering, search result count/bytes, and lifecycle cleanup with safe defaults; verify existing and updated configuration fixtures parse while invalid or unbounded values fail validation.
- [ ] 1.2 Add additive, versioned SQLite migrations for canonical memory records, scrubbed lifecycle tombstones, idempotent memory operations, and the FTS5 index; verify fresh and existing database fixtures migrate repeatedly without changing Pi session data.
- [ ] 1.3 Implement normalized entity keys, aliases, current-participant associations, provenance, importance, and lifecycle validation in a memory repository; verify malformed keys, oversized content, and invalid state transitions are rejected.
- [ ] 1.4 Implement transactional create and update operations with core-budget preflight, optimistic conflict detection, and tool-call idempotency; verify duplicate operations return the original outcome, concurrent stale writes conflict, and every accepted core set fits as a whole.
- [ ] 1.5 Implement supersede and forget operations that scrub content and search fields while retaining minimal non-content tombstones; verify obsolete content disappears immediately from canonical reads and the search index.
- [ ] 1.6 Implement safe FTS query construction, exact entity/alias boosting, deterministic relevance ordering, and bounded serialization; verify punctuation and FTS operators cannot alter query structure, empty searches are explicit, and no session or Telegram transcript tables are queried.

## 2. Turn Identity and Core Context

- [ ] 2.1 Extend managed sessions with a trusted per-turn context containing update, sender, chat, chat-type, and session identifiers, and clear it after every prompt outcome; verify alternating group senders receive distinct contexts and separate chat sessions remain concurrent.
- [ ] 2.2 Resolve `current_participant` memory subjects to normalized keys derived only from the admitted sender ID; verify model arguments cannot select or impersonate another Telegram principal.
- [ ] 2.3 Implement deterministic, escaped rendering of the current participant, associated identity facts, and every active core summary within configured bounds; verify stable output, complete core inclusion, and clear untrusted-data delimiters.
- [ ] 2.4 Add a hidden application-owned Pi inline extension that injects the current core rendering at `before_agent_start` while filesystem extension discovery remains disabled; verify injected memory reaches every model turn but never appears in persisted Pi session entries or compaction input.
- [ ] 2.5 Add adversarial context tests for memory text resembling instructions or tool requests; verify it cannot expose disabled tools or expand the configured native/MCP tool allowlist.

## 3. Native Memory Tools

- [ ] 3.1 Define and register `memory_remember`, `memory_search`, `memory_update`, and `memory_forget` with documented schemas, execution bounds, structured outcomes, and prompt guidance; verify they coexist with allowlisted MCP tools while coding, filesystem, shell, generic HTTP, and arbitrary extension tools remain absent.
- [ ] 3.2 Implement `memory_remember` for user-requested and agent-selected distilled records, including current-participant identity association and immediate durable commit; verify successful results return stable IDs and repeated tool calls do not create duplicates.
- [ ] 3.3 Implement `memory_search` over active core and reference records with optional entity hints and application-enforced result limits; verify topic, entity, alias, summary, and detail matches work and searches never return tombstones or raw conversation content.
- [ ] 3.4 Implement `memory_update` and `memory_forget` with not-found, conflict, validation, and core-budget outcomes; verify correction and deletion affect the next core rendering and search without waiting for session restart.
- [ ] 3.5 Extend system instructions and tool descriptions so explicit remember requests invoke the write tool, uncertain historical claims trigger search, autonomous writes are limited to durable reusable knowledge, and successful mutations receive a brief acknowledgement; verify scripted model tests cover each behavior without adding an automatic summarization pass.

## 4. Security and Operational Integrity

- [ ] 4.1 Apply the centralized secret redactor and known-secret detection before memory persistence, indexing, tool results, logs, and diagnostics; verify configured Telegram, MCP, and provider secret fixtures cannot be saved or leaked through any memory operation.
- [ ] 4.2 Record memory-tool operational metadata without duplicating memory content in generic audit records; verify logs and audits contain safe operation/result identifiers and distinguish success, validation failure, conflict, and interrupted execution.
- [ ] 4.3 Make active memory independent of session and transcript retention while cleaning eligible non-content tombstones and operation records; verify maintenance preserves all active records and can rebuild a consistent FTS index.
- [ ] 4.4 Extend backup and restore verification to cover core records, reference records, participant associations, lifecycle state, idempotency metadata, and FTS reconstruction; verify a restored database provides equivalent core context and search results.

## 5. Runtime Integration and Acceptance

- [ ] 5.1 Wire the memory repository, turn context, inline context extension, and native tools into application composition and session creation; verify startup health remains ready with an empty memory and failures in required memory initialization block polling safely.
- [ ] 5.2 Add an end-to-end private-to-group test that saves a distilled memory in an authorized private chat and recalls it from an authorized group while proving the private Pi transcript remains absent; verify unauthorized updates cannot read or mutate memory.
- [ ] 5.3 Add restart and `/new` acceptance tests proving shared memory survives while prior working conversation is omitted; verify an ordinary conversation without a memory-tool write creates no memory record.
- [ ] 5.4 Add group identity acceptance tests in which household participants alternate turns and teach their identities through memory; verify each turn receives the correct current-participant facts from immutable sender association.
- [ ] 5.5 Add correction, forgetting, core-budget, concurrent-write, search-bound, and failed-response acceptance tests; verify successfully committed writes remain idempotent and forgotten content is absent from live reads even if final response delivery fails.

## 6. Documentation and Final Verification

- [ ] 6.1 Update configuration examples and operator documentation with memory limits, shared-household semantics, entity/topic conventions, core versus reference behavior, and the absence of raw transcript indexing; verify all documented examples pass configuration validation.
- [ ] 6.2 Document acknowledgement, correction, forgetting, backup-retention implications, and the boundary between isolated chat sessions and intentionally shared memory; verify the operational guide provides a smoke-test flow for each memory tool.
- [ ] 6.3 Run formatting, linting, type checking, unit, integration, migration, backup/restore, security, and end-to-end suites; verify all project quality gates pass and strict OpenSpec validation succeeds.
