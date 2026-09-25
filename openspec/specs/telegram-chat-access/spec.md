# Telegram Chat Access Specification

## Purpose

Define how a small, explicitly authorized family can invoke the home agent through Telegram without granting access to other chats, users, or ambient group conversation.

## Requirements

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
- **THEN** the system ignores the interaction without persisting its content, changing session state, or invoking the agent

#### Scenario: Authorized user in an unknown chat
- **WHEN** an allowlisted user sends a message or activates a command callback from a chat that is not allowlisted
- **THEN** the system ignores the interaction without persisting its content, changing session state, or invoking the agent

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
The system SHALL deliver each completed assistant response to the Telegram chat that originated the accepted interaction, preserving reply context where available. It SHALL render supported Markdown semantics in completed agent responses as Telegram rich text rather than displaying their markup delimiters literally, while treating unsupported markup and raw HTML as literal text. It SHALL represent supported Markdown list items with visible bullet or ordered markers and preserve nesting through increased visual indentation. It SHALL split content that exceeds Telegram message limits into ordered, independently valid messages without changing the response's textual content or supported formatting semantics. Locally generated command and operational responses SHALL remain plain text unless they explicitly opt into rich-text rendering.

#### Scenario: Agent completes a response
- **WHEN** an agent turn completes successfully for an accepted Telegram interaction
- **THEN** the response is delivered to the originating chat and associated with the triggering message where Telegram supports it

#### Scenario: Agent completes a formatted response
- **WHEN** an agent response contains supported Markdown emphasis, code, links, headings, or lists
- **THEN** Telegram displays the equivalent rich-text semantics without the Markdown delimiters

#### Scenario: Agent response contains literal markup or raw HTML
- **WHEN** an agent response contains unsupported Markdown or raw HTML
- **THEN** Telegram displays that content as literal text and does not interpret it as Telegram markup

#### Scenario: Agent response contains nested lists
- **WHEN** an agent response contains a supported Markdown list with nested items
- **THEN** Telegram displays visible markers for each item and visually indents nested items more than their parent items

#### Scenario: Response exceeds one Telegram message
- **WHEN** a completed formatted agent response is larger than Telegram permits in a single message
- **THEN** the system sends ordered, independently valid formatted messages that preserve the complete response's text and supported formatting semantics

#### Scenario: Plain local response
- **WHEN** a local command or operational error response contains text that resembles Telegram markup
- **THEN** the system delivers it as plain text unless that response explicitly opted into rich-text rendering

### Requirement: Active agent turns expose transient processing feedback
The system SHALL publish Telegram's native typing chat action when an accepted interaction begins active execution and SHALL refresh the action often enough to remain visible while that turn is executing. The system SHALL stop refreshing after processing settles successfully or unsuccessfully. Chat-action publication MUST be best-effort and MUST NOT change agent execution, update state, or response delivery outcomes.

#### Scenario: Accepted turn begins active execution
- **WHEN** an accepted interaction reaches the front of its chat's queue and begins executing
- **THEN** the originating chat receives a typing action without waiting for the final response

#### Scenario: Turn waits behind earlier work
- **WHEN** an accepted interaction is waiting behind another interaction in the same chat
- **THEN** the system does not publish typing actions on behalf of the waiting interaction

#### Scenario: Long-running turn remains active
- **WHEN** an executing agent turn lasts longer than one Telegram typing-action visibility period
- **THEN** the system refreshes the typing action so processing feedback remains visible

#### Scenario: Turn processing settles
- **WHEN** an executing turn completes successfully or fails
- **THEN** the system stops refreshing its typing action

#### Scenario: Telegram rejects a typing action
- **WHEN** publishing or refreshing a typing action fails
- **THEN** the system continues the turn and preserves its normal update-state and response-delivery behavior

#### Scenario: Update does not produce a turn
- **WHEN** an update is unauthorized, ignored, or already claimed
- **THEN** the system does not publish a typing action for that update
