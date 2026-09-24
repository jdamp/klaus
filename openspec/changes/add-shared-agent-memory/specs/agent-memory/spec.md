## Purpose

Provide inspectable shared memory as readable notes with a small always-present overview, preserving useful knowledge across conversations while supporting safe correction, browsing, and recall.

## ADDED Requirements

### Requirement: All admitted participants share the notebook
The system SHALL provide one shared memory that every authorized participant can read, create notes in, revise, and delete from in any authorized chat. It SHALL apply the existing sender and chat admission checks without adding per-note ownership or participant visibility restrictions.

#### Scenario: A different participant revises a shared note
- **WHEN** a participant saves a note in a private chat and another authorized participant reads and revises it in a group
- **THEN** both interactions address the same note and later reads in either chat return the committed revision

#### Scenario: An unauthorized interaction requests memory
- **WHEN** an interaction fails sender or chat admission
- **THEN** it cannot read or mutate the notebook

### Requirement: Memory consists of readable coherent notes
Each note SHALL have a stable ID, title, prose body, optional tags, revision, timestamps, and lightweight source attribution. Titles and tags SHALL support informal organization around people, places, projects, devices, and findings without requiring a fixed entity taxonomy. The system MUST NOT automatically archive or index complete conversations as notebook content.

#### Scenario: A project discussion yields a decision
- **WHEN** the agent saves its useful conclusion
- **THEN** a readable note can preserve the decision, rationale, relevant dates, and unresolved questions together without requiring a separate record for every sentence

#### Scenario: No memory operation occurs
- **WHEN** a conversation completes without a notebook write
- **THEN** it does not automatically create a note or a searchable transcript

### Requirement: One bounded overview is available each turn
The system SHALL maintain one readable and editable note with stable ID `overview` and canonical title `Overview`, and include a snapshot of it at the beginning of each conversational turn, including after restart or a new session. Injecting that snapshot MUST NOT itself append it to persisted conversation history. Ordinary note storage SHALL be independent of the overview size limit. An upgrade from the legacy title `Household overview` SHALL preserve the note body, tags, source metadata, and stable ID while advancing its revision.

#### Scenario: Overview space is exhausted
- **WHEN** an attempted overview update exceeds its configured limit
- **THEN** the operation fails explicitly without changing the previous overview and the same underlying information can still be saved as an ordinary note within ordinary note limits

#### Scenario: Overview changes during a turn
- **WHEN** a tool commits an overview update after the current turn's snapshot was taken
- **THEN** a subsequent explicit read returns the new revision and the next conversational turn loads the new overview, while the already-running turn can retain its earlier snapshot

#### Scenario: Overview is cleared
- **WHEN** an authorized participant requests deletion of the overview and the delete operation succeeds
- **THEN** the overview becomes empty with an advanced revision and remains empty after restart until explicitly saved again

#### Scenario: Existing overview uses the legacy title
- **WHEN** the memory-label migration encounters the reserved `overview` note titled `Household overview`
- **THEN** it renames the note to `Overview`, advances its revision, updates `updated_at`, and preserves its body, tags, `created_at`, and source metadata

### Requirement: The agent can browse and read exact note contents
The system SHALL expose `memory_list` and `memory_read`. Listing SHALL provide bounded, paginated IDs, titles, previews, revisions, and timestamps with the overview first. Reading by ID SHALL return the complete stored title, body, tags, and revision without model paraphrasing. Every accepted note SHALL fit the configured full-read response limit.

#### Scenario: Search wording is uncertain
- **WHEN** the agent browses note titles and selects a relevant note ID
- **THEN** it can read that note's full content without needing a successful keyword query

#### Scenario: A note no longer exists
- **WHEN** a reader supplies a deleted or unknown note ID
- **THEN** the system returns not found without inventing content

### Requirement: Search returns bounded matches from the notebook
The system SHALL expose `memory_search` over current titles, tags, and bodies, returning ranked note IDs, titles, snippets, revisions, and timestamps within configured response limits. It SHALL distinguish no matches from an error and indicate when results were limited. It MUST NOT search raw conversation history.

#### Scenario: A topic has matching notes
- **WHEN** the agent searches for matching words or a tag
- **THEN** matching current notes are returned and can be opened through their IDs

#### Scenario: Search produces no matches
- **WHEN** the query does not match any current note
- **THEN** the tool returns an explicit empty result and the agent can browse or try other terms without claiming that no relevant knowledge necessarily exists

### Requirement: Saving and deletion are revision checked and durable
The system SHALL expose `memory_save` for creating and replacing notes and `memory_delete` for removing them. Replacing or deleting an existing note SHALL require its expected revision and reject a stale revision without overwriting a newer change. Successful mutations SHALL be committed before success is returned and deduplicated for repeated execution of the same admitted tool call.

#### Scenario: Concurrent editors read the same revision
- **WHEN** one editor commits a replacement and another submits a replacement based on the older revision
- **THEN** the second operation returns a conflict and preserves the first editor's content

#### Scenario: A save is followed by cancellation
- **WHEN** a save succeeds and the surrounding turn is subsequently stopped or fails
- **THEN** the committed note remains durable and the system does not describe it as rolled back

#### Scenario: A completed create call is repeated
- **WHEN** the same tool execution is retried
- **THEN** it returns its original mutation outcome without creating another note or resurrecting a subsequently deleted note

### Requirement: Capture preserves meaning and communicates outcomes
The agent SHALL be instructed to act on explicit remember requests, inspect relevant notes before revising them, preserve unrelated useful information, distinguish tentative ideas from decisions, and acknowledge confirmed mutations in its completed reply. It SHALL also be instructed to save useful discussion conclusions opportunistically. Autonomous capture SHALL be treated as best-effort rather than exhaustive. Failed or ambiguous operations MUST NOT be described as successful.

#### Scenario: User asks to remember a preference
- **WHEN** the agent handles an unambiguous valid request to remember a preference
- **THEN** it attempts an appropriate save and acknowledges the stored result or explains the concrete failure

#### Scenario: An idea is still tentative
- **WHEN** the agent elects to save an option discussed but not agreed
- **THEN** the note identifies it as tentative rather than recording a settled decision

#### Scenario: An existing topic is corrected
- **WHEN** the agent revises a note after a correction
- **THEN** it reads the current note, preserves unrelated still-useful content, and acknowledges the confirmed change

### Requirement: Correction and deletion have defined notebook scope
Fresh reads and searches SHALL reflect committed saves and deletes. The agent SHALL be instructed to prefer current notebook revisions over older conversational references and to review the overview for copied summaries when correcting or deleting related notes. Deleted ordinary notes SHALL disappear from listing, reading, and search, and exact ID references to them SHALL be removed from the overview. Deletion MUST NOT be represented as erasure of previous conversation messages, compaction summaries, Telegram deliveries, backups, or all independently written paraphrases.

#### Scenario: Old search output remains in conversation history
- **WHEN** a note has been revised or deleted after its earlier content was returned by a tool
- **THEN** fresh notebook access returns the current revision or not found, without promising that historical conversation copies were erased

#### Scenario: A deleted note is linked from the overview
- **WHEN** deletion of that note commits
- **THEN** the overview's exact ID reference is removed and its revision advances if it changed

### Requirement: Notebook state survives ordinary conversation maintenance
Notes, revisions, the overview, and mutation deduplication state SHALL survive service restarts, backup/restore, and new-session commands. Session compaction and transcript-retention cleanup MUST NOT expire notebook content.

#### Scenario: A restored service resumes use
- **WHEN** the notebook database is backed up, restored, and started
- **THEN** listing, exact reads, search, and overview loading expose the same saved knowledge and revisions

#### Scenario: Old conversation records expire
- **WHEN** ordinary session retention removes old working conversation records
- **THEN** saved notes remain available independently of their original conversation

### Requirement: Notebook bounds and existing application authority remain enforced
The system SHALL validate note and response limits before committing content, preserve the existing configured-credential redaction boundary, and treat stored prose as data that cannot grant tools or change authorization. The application-recorded writer identity SHALL come from the admitted interaction rather than model-supplied metadata.

#### Scenario: Oversized note is submitted
- **WHEN** a proposed note cannot be returned fully within the configured read limit
- **THEN** the save fails without partially replacing the existing note

#### Scenario: Stored prose requests additional authority
- **WHEN** a note contains instructions requesting an unavailable tool
- **THEN** reading the note does not enable that tool or bypass admission
