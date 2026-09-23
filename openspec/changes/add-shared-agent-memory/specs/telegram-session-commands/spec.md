## MODIFIED Requirements

### Requirement: Telegram exposes one truthful command catalogue
The system SHALL register the same visible command catalogue for private and group chats: `/start`, `/status`, `/model`, `/compact`, `/stop`, `/new`, and `/memory`. Telegram's bot-addressed group form of each command SHALL have the same behavior as its unaddressed private-chat form. The system SHALL accept `/help` as an unadvertised alias for `/start`.

#### Scenario: Private and group command menus are synchronized
- **WHEN** Telegram presents the bot's command menu in an authorized private chat or group
- **THEN** both chats expose the same seven supported commands

#### Scenario: Group command addresses the bot
- **WHEN** an authorized user sends `/status@<bot-username>` in an authorized group
- **THEN** the system performs the same status operation as `/status` in a private chat

#### Scenario: User requests help through the compatibility alias
- **WHEN** an authorized user sends `/help`
- **THEN** the system returns the same local help as `/start`

#### Scenario: User opens notebook help
- **WHEN** an authorized user sends `/start`
- **THEN** local help includes `/memory` and explains how to browse and read notes

## ADDED Requirements

### Requirement: Users can inspect stored notes without invoking the model
The system SHALL support `/memory` for the first notebook list page, `/memory list <page>` for numbered pages, and `/memory <note-id>` for complete stored note content, with `/memory overview` selecting the Household overview. Lists SHALL show stable IDs, titles, previews, and navigation instructions with the overview first. Note reads SHALL show revision metadata separately and reproduce the full stored body as plain text, split into ordered messages when necessary. These commands MUST NOT invoke the conversational model, add read content to Pi session history, or require model-provider availability after service startup.

#### Scenario: User browses the notebook
- **WHEN** an authorized user sends `/memory`
- **THEN** the bot returns the first list page, including the overview and instructions for opening notes or requesting further pages

#### Scenario: User reads a note with Markdown
- **WHEN** an authorized user sends `/memory <note-id>` for a note containing Markdown
- **THEN** the response reproduces the complete stored body literally, with its revision identified separately and without model paraphrasing

#### Scenario: A note needs several Telegram messages
- **WHEN** a direct read exceeds one Telegram message's size limit
- **THEN** all body text is delivered in order without silent truncation

#### Scenario: User opens the notebook in a group
- **WHEN** an authorized user sends `/memory@<bot-username> overview` in an authorized group
- **THEN** the same shared overview is returned through the local command path

#### Scenario: User requests an absent note or invalid page
- **WHEN** a memory command identifies a missing note, malformed arguments, or an unavailable list page
- **THEN** the bot returns a clear local not-found or usage response without invoking the model

#### Scenario: Model provider becomes unavailable
- **WHEN** the running service can access its database and Telegram but not its model provider
- **THEN** admitted notebook browsing and reading commands still work
