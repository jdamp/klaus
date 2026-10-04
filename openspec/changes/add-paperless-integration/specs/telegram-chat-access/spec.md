# Telegram Chat Access Spec Delta

## MODIFIED Requirements

### Requirement: Both chat and sender are explicitly authorized

The system SHALL accept a Telegram interaction, including a text message, visual message, supported upload attachment, message command, or callback query, only when both its immutable chat identifier and sender identifier are present in operator-managed allowlists. The system MUST reject an unauthorized interaction before retrieving or persisting its content, invoking an agent, changing session state, or executing a tool, and MUST NOT use usernames or display names as authorization identities.

#### Scenario: Authorized private message

- **WHEN** an allowlisted user sends a text or supported visual message in an allowlisted private chat
- **THEN** the system accepts the interaction for processing

#### Scenario: Authorized model-selector callback

- **WHEN** an allowlisted user activates a model-selector button in an allowlisted chat
- **THEN** the system accepts the callback for command processing

#### Scenario: Unknown user in an authorized group

- **WHEN** a user who is not allowlisted sends a message or activates a command callback in an allowlisted group
- **THEN** the system ignores the interaction without persisting its content, changing session state, or invoking the agent

#### Scenario: Authorized user in an unknown chat

- **WHEN** an allowlisted user sends a message or activates a command callback from a chat that is not allowlisted
- **THEN** the system ignores the interaction without persisting its content, changing session state, or invoking the agent

#### Scenario: Authorized Paperless upload attachment

- **WHEN** Paperless is configured and an allowlisted user sends a supported upload attachment in an allowlisted chat that satisfies its invocation rules
- **THEN** the system admits it under the same immutable user/chat checks as text and visual messages

#### Scenario: Unauthorized PDF attachment

- **WHEN** a PDF is sent by an unknown sender or in an unknown chat
- **THEN** the system does not retrieve or persist its content, invoke the agent, or execute an upload tool

### Requirement: Private chats accept direct interaction

The system SHALL treat ordinary text, supported visual messages, and Paperless-enabled supported upload attachments from an authorized private chat as invocations of that chat's conversation and SHALL treat supported commands as local control interactions for that chat. Admitting an upload attachment MUST NOT itself imply consent to archive it.

#### Scenario: Ordinary private message

- **WHEN** an authorized user sends an ordinary text message in an authorized private chat
- **THEN** the system submits that message to the private chat's agent conversation

#### Scenario: Private visual message

- **WHEN** an authorized user sends a supported visual message with or without a caption in an authorized private chat
- **THEN** the system submits that message to the private chat's agent conversation

#### Scenario: Supported private command

- **WHEN** an authorized user sends a supported command in an authorized private chat
- **THEN** the system invokes the corresponding local control operation without submitting the command text to the agent conversation

#### Scenario: Private PDF message

- **WHEN** Paperless is configured and an authorized user sends a supported PDF attachment in an authorized private chat
- **THEN** the system submits its caption or neutral intent prompt and bounded attachment metadata to that chat's conversation without automatically archiving it

### Requirement: Group chats require an explicit trigger

The system SHALL accept an authorized group interaction only when its text or caption contains a Telegram mention entity targeting the bot, it replies to a message authored by the bot, it contains a supported bot command, or it is a callback from a command control authored by the bot in that group. Mentioned messages and replies, including supported visual messages and Paperless-enabled supported upload attachments, SHALL invoke the agent conversation, while supported commands and callbacks SHALL invoke their local control operation. Text resembling a bot name without a matching Telegram text or caption entity MUST NOT count as a mention. Admission by a group trigger MUST NOT itself imply a request to archive an attachment.

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

- **WHEN** an authorized user sends a group message that is neither a bot mention, a reply to the bot, nor a supported command
- **THEN** the system ignores the message and does not persist its content

#### Scenario: Bot is mentioned in a PDF caption

- **WHEN** Paperless is configured and an authorized user sends a supported PDF with a caption mention entity targeting the bot in the authorized household group
- **THEN** the system submits the caption and bounded attachment metadata to the group's conversation

#### Scenario: User replies to the bot with a PDF

- **WHEN** Paperless is configured and an authorized user replies to the bot in the authorized group with a supported PDF
- **THEN** the system admits one attachment turn without interpreting the reply trigger alone as an upload request

#### Scenario: Ambient group PDF

- **WHEN** an authorized user sends a PDF to the household group without a recognized explicit trigger
- **THEN** the system does not download the attachment, invoke the agent, or submit it to Paperless
