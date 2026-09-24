## MODIFIED Requirements

### Requirement: The household system prompt is explicitly configurable
The system SHALL use the built-in household base system prompt when no prompt file is configured. When an operator configures a prompt file, the system SHALL use that file's contents in place of the complete built-in base instructions for newly created agent sessions. Application-owned memory guidance, the current overview snapshot, and current-speaker context SHALL be composed with either base prompt at the start of each conversational turn; loading a custom prompt MUST NOT suppress these runtime additions.

#### Scenario: No prompt file is configured
- **WHEN** the application starts without `agent.systemPromptFile`
- **THEN** newly created sessions use the built-in base instructions with application-owned memory guidance and per-turn overview and speaker context

#### Scenario: An explicit prompt file is configured
- **WHEN** the application starts with `agent.systemPromptFile` pointing to a readable prompt file
- **THEN** newly created sessions use the file contents instead of the built-in base instructions and still receive the same application-owned memory guidance and per-turn overview and speaker context

#### Scenario: A custom-prompt session continues after an overview change
- **WHEN** a new conversational turn begins after the overview was revised
- **THEN** that turn receives the new overview revision while retaining the configured base prompt
