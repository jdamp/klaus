# telegram-visual-input Specification

## Purpose

Define how Klaus safely retrieves supported Telegram images and supplies them to an image-capable conversational model without silently discarding visual content.

## Requirements

### Requirement: Supported Telegram images invoke the agent
The system SHALL accept a Telegram photo or a Telegram document encoded as JPEG, PNG, or WebP as visual input after the containing message passes chat admission. It SHALL submit one validated image together with the admitted caption to the chat's agent conversation. When an accepted image has no user caption, the system SHALL supply a neutral instruction that does not invent user intent.

#### Scenario: Captioned Telegram photo
- **WHEN** an authorized user sends an admitted Telegram photo with a caption
- **THEN** the system submits the photo and caption together in one agent turn

#### Scenario: Captionless Telegram photo
- **WHEN** an authorized user sends an admitted Telegram photo without a caption
- **THEN** the system submits the photo with a neutral application-supplied instruction

#### Scenario: Supported image document
- **WHEN** an authorized user sends an admitted JPEG, PNG, or WebP document
- **THEN** the system submits the validated document as visual input in one agent turn

### Requirement: Visual media retrieval is authorized and idempotent
The system MUST NOT retrieve visual media until both the chat and sender are authorized, the interaction satisfies its chat trigger rules, and the Telegram update has been durably claimed. A duplicate or ignored update MUST NOT cause another media retrieval or agent turn.

#### Scenario: Unauthorized image message
- **WHEN** a photo or image document is sent by an unauthorized sender or in an unauthorized chat
- **THEN** the system does not retrieve or persist the image and does not invoke the agent

#### Scenario: Ambient group image
- **WHEN** an authorized group image does not explicitly trigger the bot
- **THEN** the system does not retrieve or persist the image and does not invoke the agent

#### Scenario: Telegram redelivers a visual update
- **WHEN** Telegram redelivers a visual update that is already durably recorded
- **THEN** the system does not retrieve the image again or create another agent turn

### Requirement: Visual media retrieval and validation are bounded
The system SHALL enforce operator-configured download byte and timeout limits for visual input. It SHALL reject an image whose known Telegram size exceeds the byte limit before downloading it, SHALL stop a download that exceeds the byte limit even when its declared size is missing or inaccurate, and SHALL verify that downloaded bytes match a supported image encoding before model invocation.

#### Scenario: Known image is oversized
- **WHEN** Telegram reports that an admitted image exceeds the configured byte limit
- **THEN** the system rejects it without downloading it or invoking the agent

#### Scenario: Download exceeds its bound
- **WHEN** an image download exceeds the configured byte or time limit
- **THEN** the system stops retrieval and does not invoke the agent or any tool

#### Scenario: Document content does not match its declared type
- **WHEN** a downloaded image document does not match its declared supported encoding
- **THEN** the system rejects it before model invocation

#### Scenario: Largest bounded photo representation
- **WHEN** Telegram supplies multiple representations of a photo and at least one known representation fits the configured byte limit
- **THEN** the system retrieves the largest known representation that fits the limit

### Requirement: Unsupported visual input fails explicitly
The system SHALL deliver a plain local explanation for an admitted visual message that is unsupported, oversized, unavailable, invalid, or incompatible with the chat's effective model. It MUST NOT silently omit the image, substitute another model, invoke an agent or tool on placeholder text, or automatically retry the update.

#### Scenario: Unsupported image format
- **WHEN** an admitted image document uses a format other than JPEG, PNG, or WebP
- **THEN** the system replies that the image format is unsupported without invoking the agent or a tool

#### Scenario: Selected model is text-only
- **WHEN** an admitted supported image targets a chat whose effective model does not accept image input
- **THEN** the system explains the incompatibility without changing the chat's model preference or invoking the agent

#### Scenario: Telegram file is unavailable
- **WHEN** Telegram cannot resolve or return an admitted image
- **THEN** the system sends a determinate local failure response and does not automatically retry the update
