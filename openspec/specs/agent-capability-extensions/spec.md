# Agent Capability Extensions Specification

## Purpose

Define a controlled extension surface for household skills, application tools, and external MCP services while ensuring that model instructions cannot expand executable authority.

## Requirements

### Requirement: Only explicitly enabled tools are model-accessible
The system SHALL expose only operator-enabled application and MCP tools to the agent. General shell execution, unrestricted filesystem mutation, generic outbound HTTP access, and coding-oriented tools MUST be disabled by default.

#### Scenario: Agent requests an unavailable coding tool
- **WHEN** the model attempts to call a shell, write, edit, or other tool that is not explicitly enabled
- **THEN** the system does not execute that operation

### Requirement: Operators can install custom skills
The system SHALL discover valid skills from configured operator-managed locations and make their names and descriptions available to the agent. A skill's instructions MUST NOT grant access to a tool that is otherwise disabled.

#### Scenario: Valid skill is installed
- **WHEN** an operator places a valid skill in a configured skills location and reloads or restarts the service
- **THEN** the agent can discover and use the skill instructions

#### Scenario: Skill references a disabled tool
- **WHEN** a loaded skill instructs the agent to use a tool that is not enabled
- **THEN** the referenced operation remains unavailable

### Requirement: Application-defined tools can be registered
The system SHALL support custom tools with named operations, documented input schemas, validation, bounded execution, and structured results.

#### Scenario: Valid custom tool call
- **WHEN** the agent calls an enabled custom tool with schema-valid arguments
- **THEN** the system executes the tool and returns its structured result to the agent

#### Scenario: Invalid custom tool arguments
- **WHEN** the agent calls a custom tool with arguments that do not satisfy its schema
- **THEN** the system rejects the call without invoking the underlying service

### Requirement: Authenticated Streamable HTTP MCP servers are supported
The system SHALL connect to configured MCP servers over Streamable HTTP using credentials supplied outside model context and persistent conversation data. It SHALL discover server tools and namespace them by server identity to prevent collisions.

#### Scenario: Configured MCP connection succeeds
- **WHEN** a configured Streamable HTTP MCP endpoint accepts its mounted token and reports its tool catalogue
- **THEN** enabled tools are made available under collision-resistant names associated with that server

#### Scenario: MCP credential is handled
- **WHEN** the application authenticates an MCP request
- **THEN** the credential is not included in model prompts, tool arguments, SQLite content, or logs

### Requirement: MCP tool discovery is fail-closed
The system SHALL apply an operator-managed allowlist to discovered MCP tools. A newly discovered or renamed server tool MUST remain unavailable until explicitly enabled.

#### Scenario: MCP server adds a tool
- **WHEN** tool discovery returns a tool name that is absent from the configured allowlist
- **THEN** the system does not expose that tool to the agent

### Requirement: MCP calls have operational bounds
The system SHALL validate tool arguments against discovered schemas, propagate cancellation where supported, enforce configured timeouts and result-size limits, and report failures without claiming that an action succeeded.

#### Scenario: MCP call times out
- **WHEN** an MCP tool does not complete within its configured timeout
- **THEN** the system stops waiting, records a failed outcome, and presents the failure to the agent

#### Scenario: MCP result exceeds its limit
- **WHEN** an MCP tool returns more content than the configured result limit
- **THEN** the system bounds the content admitted to conversation context and marks it as truncated

### Requirement: Optional capability outages are isolated
The system SHALL continue serving capabilities that remain healthy when an optional MCP server is unavailable, and SHALL make the unavailability observable to both users attempting affected operations and service operators.

#### Scenario: Configured MCP server is offline
- **WHEN** a user asks for an operation requiring an unavailable configured MCP server
- **THEN** the bot reports that the capability is unavailable without disrupting unrelated conversations or services
