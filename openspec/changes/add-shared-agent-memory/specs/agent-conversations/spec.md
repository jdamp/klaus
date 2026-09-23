## MODIFIED Requirements

### Requirement: Each Telegram chat has an isolated conversation
The system SHALL maintain a distinct working agent conversation for each authorized Telegram chat. It MUST NOT automatically include another chat's raw messages, tool history, or conversation summary in that working context. Knowledge deliberately saved to the shared household notebook SHALL be available in every authorized chat, including knowledge distilled from private chats; this saved knowledge SHALL NOT be subject to participant-specific visibility restrictions.

#### Scenario: Same user talks in private and group chats
- **WHEN** an authorized user invokes the agent in both a private chat and the family group
- **THEN** each invocation uses its own working conversation state and can also access the same shared notebook

#### Scenario: A private discussion produces a saved note
- **WHEN** a finding is deliberately saved from a private chat and later recalled in an authorized group
- **THEN** the saved note is available without importing the originating private transcript

### Requirement: A chat can start a new session
The system SHALL provide an authorized command that starts a new conversation for the current chat without resetting any other chat, changing the invoking chat's durable model preference, or removing household notebook content. The new session SHALL load the current overview and retain access to saved notes.

#### Scenario: User starts a new group session
- **WHEN** an authorized user invokes the new-session command in an authorized group
- **THEN** later group turns omit the prior active conversation while private-chat sessions and shared notes remain unchanged

#### Scenario: New session retains the chat model
- **WHEN** a chat with a selected model starts a new session
- **THEN** the new conversation uses the same selected model when it remains available

#### Scenario: Messages follow a queued new-session command
- **WHEN** a normal chat message is accepted after `/new` while earlier work is still queued
- **THEN** that message executes against the newly active conversation rather than a session identifier captured before `/new` completed

#### Scenario: A fresh session recalls saved knowledge
- **WHEN** the first turn after `/new` asks about a saved topic
- **THEN** the current overview and notebook tools are available even though the previous working conversation is omitted

## ADDED Requirements

### Requirement: Working conversation retains speaker attribution
The system SHALL attach application-supplied sender attribution to each newly accepted conversational message, persist it with that message, and expose the current sender for each turn. Compaction SHALL be instructed to preserve attribution for retained person-specific statements. Display labels SHALL be descriptive only and MUST NOT replace immutable sender IDs for attribution or authorization. The system MUST NOT guess authors of older messages that lack attribution.

#### Scenario: Household members alternate messages
- **WHEN** two participants state different personal preferences in the same group
- **THEN** the retained messages identify their respective senders so a later turn can attribute each preference correctly

#### Scenario: Attributed statements are compacted
- **WHEN** a compacted summary retains person-specific information from attributed messages
- **THEN** compaction guidance requires retaining who said it rather than assigning all prior statements to the current speaker

#### Scenario: A legacy message has no sender information
- **WHEN** an older session entry lacks reliable attribution
- **THEN** it remains unattributed and is not assigned to the current sender
