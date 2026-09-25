# Spec Delta

## MODIFIED Requirements

### Requirement: Both chat and sender are explicitly authorized
The system SHALL accept a Telegram interaction, including a text message, visual message, message command, or callback query, only when both its immutable chat identifier and sender identifier are present in operator-managed allowlists. The system MUST reject an unauthorized interaction before retrieving or persisting its content, invoking an agent, changing session state, or executing a tool, and MUST NOT use usernames or display names as authorization identities.

#### Scenario: Authorized private message
- **WHEN** an allowlisted user sends a text or supported visual message in an allowlisted private chat
- **THEN** the system accepts the interaction for processing

#### Scenario: Authorized model-selector callback
- **WHEN** an allowlisted user activates a model-selector button in an allowlisted chat
- **THEN** the system accepts the callback for command processing

#### Scenario: Unknown user in an authorized group
- **WHEN** a user who is not allowlisted sends a message or activates a command callback in an allowlisted group
- **THEN** the system ignores the interaction without retrieving or persisting its content, changing session state, or invoking the agent

#### Scenario: Authorized user in an unknown chat
- **WHEN** an allowlisted user sends a message or activates a command callback from a chat that is not allowlisted
- **THEN** the system ignores the interaction without retrieving or persisting its content, changing session state, or invoking the agent

### Requirement: Private chats accept direct interaction
The system SHALL treat ordinary text and supported visual messages from an authorized private chat as invocations of that chat's conversation and SHALL treat supported commands as local control interactions for that chat.

#### Scenario: Ordinary private message
- **WHEN** an authorized user sends an ordinary text message in an authorized private chat
- **THEN** the system submits that message to the private chat's agent conversation

#### Scenario: Private visual message
- **WHEN** an authorized user sends a supported visual message with or without a caption in an authorized private chat
- **THEN** the system submits that message to the private chat's agent conversation

#### Scenario: Supported private command
- **WHEN** an authorized user sends a supported command in an authorized private chat
- **THEN** the system invokes the corresponding local control operation without submitting the command text to the agent conversation

### Requirement: Group chats require an explicit trigger
The system SHALL accept an authorized group interaction only when its text or caption contains a Telegram mention entity targeting the bot, it replies to a message authored by the bot, it contains a supported bot command, or it is a callback from a command control authored by the bot in that group. Mentioned messages and replies, including supported visual messages, SHALL invoke the agent conversation, while supported commands and callbacks SHALL invoke their local control operation. Text resembling a bot name without a matching Telegram text or caption entity MUST NOT count as a mention.

#### Scenario: Bot is mentioned in a group
- **WHEN** an authorized user in an authorized group sends a text message with a mention entity targeting the bot
- **THEN** the system submits that message to the group's agent conversation

#### Scenario: User replies to the bot
- **WHEN** an authorized user in an authorized group replies to a message authored by the bot
- **THEN** the system submits that reply to the group's agent conversation

#### Scenario: Bot is mentioned in an image caption
- **WHEN** an authorized user in an authorized group sends a supported visual message whose caption has a mention entity targeting the bot
- **THEN** the system submits the caption and image to the group's agent conversation

#### Scenario: User replies to the bot with an image
- **WHEN** an authorized user in an authorized group replies to a message authored by the bot with a supported visual message
- **THEN** the system submits that visual message to the group's agent conversation

#### Scenario: Supported group command
- **WHEN** an authorized user sends a supported bot command addressed to the bot in an authorized group
- **THEN** the system performs the command's local control operation for that group

#### Scenario: Authorized group callback
- **WHEN** an authorized user activates a valid command control authored by the bot in an authorized group
- **THEN** the system performs the callback's local control operation for that group

#### Scenario: Ambient family conversation
- **WHEN** an authorized user sends a text or visual group message that is neither a bot mention, a reply to the bot, nor a supported command
- **THEN** the system ignores the message and does not retrieve or persist its content
