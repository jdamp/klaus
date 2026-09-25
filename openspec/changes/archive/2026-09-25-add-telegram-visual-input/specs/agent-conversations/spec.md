# Spec Delta

## MODIFIED Requirements

### Requirement: Conversation state survives restart
The system SHALL durably retain accepted user text and image content, assistant messages, structured tool calls, and tool results required to resume each conversation after a process restart.

#### Scenario: Service restarts between turns
- **WHEN** the service restarts after completing a turn and the same chat sends another accepted message
- **THEN** the new turn resumes with the durable context of that chat

#### Scenario: Service restarts after a visual turn
- **WHEN** the service restarts after completing a turn containing an accepted image and the same chat refers to that image in a later turn while it remains in model context
- **THEN** the new turn resumes with the image content in that chat's durable conversation and does not expose it to another chat
