# Telegram Session Commands Specification

## Purpose

Define local Telegram controls for inspecting and managing each authorized chat's Pi-backed conversation without sending control commands to the conversational model.

## Requirements

### Requirement: Telegram exposes one truthful command catalogue
The system SHALL register the same visible command catalogue for private and group chats: `/start`, `/status`, `/model`, `/compact`, `/stop`, and `/new`. Telegram's bot-addressed group form of each command SHALL have the same behavior as its unaddressed private-chat form. The system SHALL accept `/help` as an unadvertised alias for `/start`.

#### Scenario: Private and group command menus are synchronized
- **WHEN** Telegram presents the bot's command menu in an authorized private chat or group
- **THEN** both chats expose the same six supported commands

#### Scenario: Group command addresses the bot
- **WHEN** an authorized user sends `/status@<bot-username>` in an authorized group
- **THEN** the system performs the same status operation as `/status` in a private chat

#### Scenario: User requests help through the compatibility alias
- **WHEN** an authorized user sends `/help`
- **THEN** the system returns the same local help as `/start`

### Requirement: Control commands are handled outside ordinary model conversation
The system SHALL recognize supported commands from Telegram command entities and SHALL NOT submit the command text to the conversational model as a user prompt. The system SHALL return a local acknowledgement or result for each accepted command, except that `/stop` MAY use its acknowledgement as the sole response for the interrupted operation.

#### Scenario: User opens command help
- **WHEN** an authorized user sends `/start`
- **THEN** the system returns concise help without invoking the conversational model or adding `/start` to conversation history

#### Scenario: Unknown slash command is received privately
- **WHEN** an authorized private chat sends a slash command that is not supported
- **THEN** the system returns a local unsupported-command response without submitting the command to the model

### Requirement: Status reports session usage locally
The `/status` command SHALL report the active model and reasoning level, cumulative session input, output, cache, and total token usage, cumulative reported cost, and current context utilization against the active model's context window. It MUST distinguish an unavailable context estimate from zero usage and MUST NOT invoke the model to produce the report.

#### Scenario: Session has recorded model usage
- **WHEN** an authorized user sends `/status` after completed model turns
- **THEN** the response reports cumulative billed usage including compacted history and the current context utilization when known

#### Scenario: Context usage is temporarily unknown
- **WHEN** an authorized user sends `/status` before a reliable post-compaction context measurement exists
- **THEN** the response identifies current context usage as unknown rather than reporting zero

### Requirement: Users can select any backend-available model
The `/model` command SHALL show the current chat model and a paginated inline selector containing every model the Pi model runtime reports as available from authenticated backends. The system SHALL also accept `/model <provider>/<model-id>` for exact direct selection. A successful selection SHALL affect only the invoking chat and SHALL NOT invoke the conversational model.

#### Scenario: User opens the model selector
- **WHEN** an authorized user sends `/model` without an argument
- **THEN** the system returns the current selection and inline controls through which every currently available model can be reached

#### Scenario: User selects an inline model
- **WHEN** an authorized user activates a valid model button from the invoking chat
- **THEN** the system selects that model for the chat and acknowledges the resulting provider and model identifier

#### Scenario: User directly selects an available model
- **WHEN** an authorized user sends an exact provider and model identifier that is currently available
- **THEN** the system selects that model for the invoking chat

#### Scenario: Requested model is unavailable
- **WHEN** a direct command or stale inline button identifies a model that is no longer available
- **THEN** the system reports that the selection is unavailable and leaves the chat's model preference unchanged

### Requirement: Users can manually compact the current conversation
The `/compact` command SHALL invoke Pi's manual compaction for the invoking chat's active conversation, persist a successful compaction, and report whether compaction completed or there was insufficient history to compact. The command itself MUST NOT be added to conversation history.

#### Scenario: Conversation is eligible for compaction
- **WHEN** an authorized user sends `/compact` for a conversation with compactable history
- **THEN** the system compacts and persists that conversation and returns a completion acknowledgement

#### Scenario: Conversation has insufficient history
- **WHEN** an authorized user sends `/compact` and Pi finds no eligible compaction boundary
- **THEN** the system reports that no compaction was performed without treating the command as an agent failure

### Requirement: Stop interrupts active work without waiting behind it
The `/stop` command SHALL be able to abort an active model turn, retry, compaction, or abort-aware tool call for the invoking chat without waiting behind that chat's normal work queue. It SHALL report whether work was interrupted, SHALL NOT affect another chat, and MUST NOT claim to reverse an external action that completed before cancellation.

#### Scenario: Chat has an active model turn
- **WHEN** an authorized user sends `/stop` while that chat is processing a turn
- **THEN** the system requests cancellation immediately, records the interrupted turn as a determinate cancellation, and acknowledges the stop

#### Scenario: Different chat has active work
- **WHEN** an authorized user sends `/stop` in an idle chat while another chat is processing
- **THEN** the system reports that the invoking chat has no active work and does not interrupt the other chat

#### Scenario: Tool action completed before stop
- **WHEN** an external tool action completes before the cancellation request reaches it
- **THEN** the system retains the recorded tool outcome and does not represent the completed action as reversed

### Requirement: New starts a fresh conversation locally
The `/new` command SHALL replace the invoking chat's active conversation with an empty conversation, return a local acknowledgement, and SHALL NOT submit `/new` to the model.

#### Scenario: User starts a fresh conversation
- **WHEN** an authorized user sends `/new`
- **THEN** later turns in that chat omit the previous conversation and the command consumes no model tokens
