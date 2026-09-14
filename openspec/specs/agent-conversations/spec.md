# Agent Conversations Specification

## Purpose

Define durable and privacy-preserving conversation behavior so each family chat retains useful context without exposing unrelated chats or sending an unbounded transcript to the model.

## Requirements

### Requirement: Each Telegram chat has an isolated conversation
The system SHALL maintain a distinct agent conversation for each authorized Telegram chat. Content from a private chat MUST NOT be included in a group or another private chat's model context.

#### Scenario: Same user talks in private and group chats
- **WHEN** an authorized user invokes the agent in both a private chat and the family group
- **THEN** each invocation uses only the conversation state assigned to its own chat

### Requirement: Conversation state survives restart
The system SHALL durably retain accepted user messages, assistant messages, structured tool calls, and tool results required to resume each conversation after a process restart.

#### Scenario: Service restarts between turns
- **WHEN** the service restarts after completing a turn and the same chat sends another accepted message
- **THEN** the new turn resumes with the durable context of that chat

### Requirement: Model context remains bounded
The system SHALL construct model input from current instructions, relevant durable memory, a compacted summary of older conversation, and a bounded recent-message tail rather than sending the entire retained transcript on every turn.

#### Scenario: Long-running chat exceeds its context threshold
- **WHEN** retained conversation content exceeds the configured context budget
- **THEN** the system compacts older content and sends the resulting summary with recent messages on subsequent turns

#### Scenario: Recent tool result is needed
- **WHEN** a recent assistant turn contains a tool call and result
- **THEN** the system preserves the structured call-result relationship in model context until that turn is compacted

### Requirement: Turns are ordered within a chat
The system SHALL serialize accepted turns within one chat while allowing different chats to make progress independently.

#### Scenario: Two messages arrive in the same chat
- **WHEN** a second accepted message arrives while the chat already has an active turn
- **THEN** the second message waits or follows the active turn without concurrently mutating the same conversation state

#### Scenario: Different chats are active
- **WHEN** accepted messages arrive in two different chats
- **THEN** one chat's active turn does not require the other chat to finish first

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

### Requirement: Operational records minimize sensitive content
The system SHALL retain only accepted interaction content and the operational metadata necessary for session continuity, delivery reliability, and tool auditing. It MUST NOT store authentication secrets in conversation or audit records.

#### Scenario: Ambient group message is received
- **WHEN** a group message does not meet the explicit trigger rules
- **THEN** its content is absent from conversation storage

#### Scenario: A tool uses a credential
- **WHEN** a tool call is authenticated with a configured secret
- **THEN** the credential value is absent from stored messages, tool results, and audit metadata
