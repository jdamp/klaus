# Telegram Chat Access Specification

## Purpose

Define how a small, explicitly authorized family can invoke the home agent through Telegram without granting access to other chats, users, or ambient group conversation.

## Requirements

### Requirement: Both chat and sender are explicitly authorized
The system SHALL accept a Telegram interaction only when both its immutable chat identifier and sender identifier are present in operator-managed allowlists. The system MUST reject an unauthorized update before persisting its content, invoking an agent, or executing a tool, and MUST NOT use usernames or display names as authorization identities.

#### Scenario: Authorized private message
- **WHEN** an allowlisted user sends a message in an allowlisted private chat
- **THEN** the system accepts the interaction for processing

#### Scenario: Unknown user in an authorized group
- **WHEN** a user who is not allowlisted sends a message in an allowlisted group
- **THEN** the system ignores the update without persisting its content or invoking the agent

#### Scenario: Authorized user in an unknown chat
- **WHEN** an allowlisted user sends a message from a chat that is not allowlisted
- **THEN** the system ignores the update without persisting its content or invoking the agent

### Requirement: Private chats accept direct interaction
The system SHALL treat ordinary messages and supported commands from an authorized private chat as invocations of that chat's conversation.

#### Scenario: Ordinary private message
- **WHEN** an authorized user sends an ordinary text message in an authorized private chat
- **THEN** the system submits that message to the private chat's agent conversation

### Requirement: Group chats require an explicit trigger
The system SHALL invoke the agent for an authorized group message only when the message contains a Telegram mention entity targeting the bot, replies to a message authored by the bot, or contains a supported bot command. Text resembling a bot name without a matching Telegram entity MUST NOT count as a mention.

#### Scenario: Bot is mentioned in a group
- **WHEN** an authorized user in an authorized group sends a message with a mention entity targeting the bot
- **THEN** the system submits that message to the group's agent conversation

#### Scenario: User replies to the bot
- **WHEN** an authorized user in an authorized group replies to a message authored by the bot
- **THEN** the system submits that reply to the group's agent conversation

#### Scenario: Ambient family conversation
- **WHEN** an authorized user sends a group message that is neither a bot mention, a reply to the bot, nor a supported command
- **THEN** the system ignores the message and does not persist its content

### Requirement: Automated and edited updates do not trigger actions
The system SHALL ignore messages authored by bots and SHALL ignore edited-message updates in the initial release so that automated loops and repeated physical actions are not introduced implicitly.

#### Scenario: Bot-authored message
- **WHEN** Telegram delivers a message whose sender is a bot
- **THEN** the system does not invoke an agent or tool for that message

#### Scenario: Previously accepted message is edited
- **WHEN** Telegram delivers an edit for an existing message
- **THEN** the system does not reprocess the message

### Requirement: Telegram updates are processed idempotently
The system SHALL identify already processed Telegram updates and MUST NOT execute an accepted update more than once, including across process restarts.

#### Scenario: Telegram redelivers an update
- **WHEN** an update identifier that has already completed or is durably recorded is received again
- **THEN** the system does not create a second agent turn or repeat any associated tool action

### Requirement: Responses return to the originating chat
The system SHALL deliver each completed assistant response to the Telegram chat that originated the accepted interaction, preserving reply context where available and splitting content that exceeds Telegram message limits without changing its order.

#### Scenario: Agent completes a response
- **WHEN** an agent turn completes successfully for an accepted Telegram interaction
- **THEN** the response is delivered to the originating chat and associated with the triggering message where Telegram supports it

#### Scenario: Response exceeds one Telegram message
- **WHEN** a completed response is larger than Telegram permits in a single message
- **THEN** the system sends ordered chunks that preserve the complete response
