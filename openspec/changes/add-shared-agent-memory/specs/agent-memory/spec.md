## Purpose

Define a durable, shared household memory that preserves selected facts and distilled findings across isolated chat sessions while keeping model context bounded, searchable, correctable, and free of raw transcript archives or authentication secrets.

## ADDED Requirements

### Requirement: Authorized chats share one household memory
The system SHALL expose one logical household memory to every authorized participant in every authorized chat. Raw Pi session content SHALL remain isolated by chat, but a memory explicitly saved through the memory capability SHALL be treated as intentionally shared household knowledge regardless of the chat in which it originated.

#### Scenario: Memory saved in private chat is recalled in the family group
- **WHEN** an authorized participant saves a household fact in a private chat and an authorized participant later recalls that fact in an authorized group
- **THEN** the system makes the saved memory available without exposing the originating private conversation

#### Scenario: Unauthorized update attempts memory access
- **WHEN** an update fails the existing participant or chat admission policy
- **THEN** the system neither reads nor mutates household memory for that update

### Requirement: Memory contains distilled records rather than conversation transcripts
The system SHALL store durable memory as bounded records organized by a normalized topic or entity. Each record SHALL include a stable identifier, concise summary, optional distilled detail, importance, origin and source metadata, lifecycle state, and timestamps. The system MUST NOT add complete user messages, assistant responses, or raw conversation transcripts to the memory store or its search index merely because a conversation occurred.

#### Scenario: Discussion produces an important finding
- **WHEN** the agent saves the outcome of a discussion as durable memory
- **THEN** the resulting record contains a concise summary and only the useful distilled findings rather than a transcript of the discussion

#### Scenario: Ordinary conversation ends without a memory write
- **WHEN** an accepted conversation completes without the user requesting memory and without the agent invoking a memory mutation tool
- **THEN** the conversation creates no long-term memory record

### Requirement: The current participant is identified on every turn
The system SHALL associate each accepted turn with the immutable Telegram sender identifier supplied by the admission boundary. It SHALL make that identifier and any active core identity memory associated with that participant available to the model for the current turn, including when successive turns in one group come from different participants.

#### Scenario: Two household participants alternate in a group
- **WHEN** two authorized participants send consecutive accepted group messages
- **THEN** each model turn identifies the sender of that specific message and includes only that sender's associated identity facts as the current-participant identity

#### Scenario: Participant identity was previously remembered
- **WHEN** a participant has an active core memory associating their immutable sender identifier with a household name
- **THEN** a later turn from that sender presents the remembered name as part of the current-participant context

### Requirement: Core memory is always available within a fixed budget
The system SHALL inject every active core-memory summary plus current-participant identity into each model turn without persisting the injected rendering as Pi session history. It SHALL enforce a configured maximum core-memory size and MUST reject a create or update operation that would make the complete core memory exceed that limit.

#### Scenario: A new chat session starts
- **WHEN** an authorized chat starts a new Pi session after core memories already exist
- **THEN** the first model turn in the new session includes the complete active core memory and current-participant identity

#### Scenario: Core memory would exceed its configured limit
- **WHEN** a memory mutation would cause active core summaries to exceed the configured core-memory budget
- **THEN** the system rejects that mutation without silently omitting an existing core record from later turns

#### Scenario: Stored text resembles an instruction
- **WHEN** a stored memory contains imperative or tool-related text
- **THEN** the system presents it as untrusted stored data and does not allow it to expand the model's executable tool authority

### Requirement: The agent can remember durable household knowledge
The system SHALL expose an application-defined memory tool that lets the model create a bounded topic- or entity-based record on explicit user request or when the model determines that a durable fact, preference, relationship, routine, decision, or discussion finding is worth retaining. A successful write SHALL be durable immediately, idempotent for the same tool execution, and returned with its stable memory identifier.

#### Scenario: User explicitly asks the agent to remember something
- **WHEN** an authorized participant asks the agent to remember a valid household fact
- **THEN** the agent invokes the memory tool, the system durably stores the distilled record, and the response acknowledges what was remembered

#### Scenario: Agent identifies a durable discussion decision
- **WHEN** a discussion reaches a decision that will likely be useful in future interactions and the agent elects to retain it
- **THEN** the agent may save a concise memory record and tells the participants that it did so

#### Scenario: A completed memory tool call is encountered again
- **WHEN** the same memory tool execution is submitted more than once because of retry or recovery behavior
- **THEN** the system returns the original result without creating a duplicate record

### Requirement: Detailed memory is searchable by topic and entity
The system SHALL expose an application-defined search tool over active non-core and core memory records. Search SHALL match normalized entities, topics, aliases, summaries, and distilled detail, and SHALL return bounded results containing stable identifiers, relevance information, summaries, details, and update timestamps. It MUST NOT search raw conversation history.

#### Scenario: User refers to a previous topic
- **WHEN** the agent searches memory for a previously saved project, decision, person, place, device, routine, or preference
- **THEN** the system returns the most relevant active matching records within the configured result count and size limits

#### Scenario: Search has no matching memory
- **WHEN** no active memory record matches the query
- **THEN** the tool returns an explicit empty result rather than inventing remembered information

### Requirement: Remembered information can be corrected and forgotten
The system SHALL expose tools that update or supersede an identified memory record and forget an identified memory record. Superseded or forgotten content MUST cease appearing in core context and search results immediately, while minimal non-content lifecycle metadata MAY remain for integrity and audit purposes.

#### Scenario: Participant corrects an outdated preference
- **WHEN** the agent updates or supersedes the identified record with the corrected preference
- **THEN** subsequent core context and searches return the corrected active information and omit the obsolete content

#### Scenario: Participant asks the agent to forget a record
- **WHEN** the agent successfully forgets the identified memory
- **THEN** the response acknowledges the deletion and later turns neither inject nor retrieve its content

### Requirement: Memory survives session changes and service restarts
The system SHALL persist active memory independently of Pi sessions and SHALL include memory data in application backup and restore operations. Starting a new chat session, compacting session context, expiring old inactive sessions, or restarting the service MUST NOT remove active memory.

#### Scenario: Chat invokes the new-session command
- **WHEN** an authorized chat invokes `/new` after a memory was saved
- **THEN** the new Pi session omits the prior working conversation but retains access to the saved household memory

#### Scenario: Database is backed up and restored
- **WHEN** an application backup containing memory is restored into a compatible fresh runtime
- **THEN** active core context, searchable detail, entity associations, and lifecycle state remain usable

### Requirement: Memory excludes authentication secrets
The system MUST NOT persist configured authentication credentials, mounted secret values, provider tokens, or equivalent secrets in memory summaries, details, metadata, search indexes, tool results, logs, or diagnostics. Memory tools SHALL apply the application's secret redaction and rejection protections before committing a mutation.

#### Scenario: Memory input contains a configured secret
- **WHEN** a memory mutation includes a value known to the application's secret redactor
- **THEN** the system rejects the mutation or removes the secret before persistence and does not make the value searchable or prompt-visible

