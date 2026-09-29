## MODIFIED Requirements

### Requirement: Operational records minimize sensitive content
The system SHALL retain accepted interaction content required for conversation continuity and operational metadata necessary for session continuity, delivery reliability, and tool auditing. It MAY export bounded, redacted textual model inputs and outputs and tool arguments and results to an explicitly configured trace backend for operator inspection. It MUST NOT store authentication secrets in conversation, audit, or trace records, and MUST NOT persist tool argument or result bodies in local audit records.

#### Scenario: Ambient group message is received
- **WHEN** a group message does not meet the explicit trigger rules
- **THEN** its content is absent from conversation storage and exported traces

#### Scenario: A tool uses a credential
- **WHEN** a tool call is authenticated with a configured secret
- **THEN** the credential value is absent from stored messages, tool results, local audit metadata, and exported traces

#### Scenario: Tracing is enabled for an accepted turn
- **WHEN** an accepted turn sends household text to the model or receives a textual tool result
- **THEN** the configured trace backend receives bounded, redacted text content while local audit records retain only tool outcome metadata
