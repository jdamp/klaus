# agent-prompt-configuration Specification

## Purpose
Allow operators to select and validate a complete household assistant system prompt from a local file without rebuilding the application.

## Requirements

### Requirement: The household system prompt is explicitly configurable
The system SHALL use the built-in household system prompt when no prompt file is configured. When an operator configures a prompt file, the system SHALL use that file's contents as the complete system prompt for newly created agent sessions.

#### Scenario: No prompt file is configured
- **WHEN** the application starts without `agent.systemPromptFile`
- **THEN** newly created sessions use the built-in household system prompt

#### Scenario: An explicit prompt file is configured
- **WHEN** the application starts with `agent.systemPromptFile` pointing to a readable prompt file
- **THEN** newly created sessions use the file contents instead of the built-in household system prompt

### Requirement: The configured prompt file is validated before service operation
The system SHALL read a configured prompt file during startup and SHALL refuse to start when the path is missing, unreadable, not a readable file, empty, or contains only whitespace.

#### Scenario: Configured prompt file is missing
- **WHEN** the application starts with a prompt-file path that does not exist
- **THEN** startup fails with an error identifying the configured prompt file

#### Scenario: Configured prompt file has no usable content
- **WHEN** the application starts with a prompt file that is empty or contains only whitespace
- **THEN** startup fails instead of creating sessions with an unusable system prompt

#### Scenario: Configured prompt file cannot be read
- **WHEN** the application starts with a prompt path that cannot be read as a file
- **THEN** startup fails and the application does not begin Telegram polling

### Requirement: Prompt-file selection is explicit
The system SHALL read only the path explicitly configured by the operator and SHALL not implicitly discover `AGENTS.md`, `CLAUDE.md`, or other project context files as the household system prompt.

#### Scenario: An unconfigured AGENTS.md exists
- **WHEN** an `AGENTS.md` file exists in the working directory but `agent.systemPromptFile` is omitted
- **THEN** the file is not used as the household system prompt

#### Scenario: A configured path names AGENTS.md
- **WHEN** `agent.systemPromptFile` explicitly points to an `AGENTS.md` file
- **THEN** that file is used according to the configured prompt-file behavior
