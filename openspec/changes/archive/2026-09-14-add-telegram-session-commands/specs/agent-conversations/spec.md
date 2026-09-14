## ADDED Requirements

### Requirement: Each chat retains an independent model preference
The system SHALL durably retain the most recently selected available model as a preference of the invoking Telegram chat, independently of that chat's active conversation. The preference MUST survive process restart, session-cache eviction, compaction, and conversation replacement, and MUST NOT change another chat's model.

#### Scenario: Private and group chats select different models
- **WHEN** authorized users select one model in a private chat and another model in a group
- **THEN** later turns in each chat use that chat's selected model

#### Scenario: Service restarts after model selection
- **WHEN** the service restarts after a chat selects a model
- **THEN** the next turn in that chat uses the retained selection when it remains available

#### Scenario: Retained model is temporarily unavailable
- **WHEN** a chat's retained model is not available from an authenticated backend during session creation
- **THEN** the system uses the configured fallback without erasing the retained preference

### Requirement: User-requested interruption has a determinate outcome
The system SHALL distinguish a user-requested cancellation from an indeterminate interruption. It SHALL persist any completed session entries and tool outcomes produced before cancellation, SHALL NOT deliver a generic agent-failure response for the cancelled turn, and SHALL NOT automatically replay the cancelled input.

#### Scenario: User stops an active turn
- **WHEN** an authorized `/stop` command cancels an active turn before completion
- **THEN** the interrupted update is durably recorded as cancelled and is not automatically replayed

#### Scenario: Cancellation follows a completed tool call
- **WHEN** a tool call completes before the surrounding turn is cancelled
- **THEN** the completed tool outcome remains durable while the surrounding update is recorded as cancelled

## MODIFIED Requirements

### Requirement: A chat can start a new session
The system SHALL provide an authorized command that starts a new conversation for the current chat without resetting any other chat or changing the invoking chat's durable model preference.

#### Scenario: User starts a new group session
- **WHEN** an authorized user invokes the new-session command in an authorized group
- **THEN** later group turns omit the prior active conversation while private-chat sessions remain unchanged

#### Scenario: New session retains the chat model
- **WHEN** a chat with a selected model starts a new session
- **THEN** the new conversation uses the same selected model when it remains available

#### Scenario: Messages follow a queued new-session command
- **WHEN** a normal chat message is accepted after `/new` while earlier work is still queued
- **THEN** that message executes against the newly active conversation rather than a session identifier captured before `/new` completed
