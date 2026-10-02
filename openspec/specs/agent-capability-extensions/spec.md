# Agent Capability Extensions Specification

## Purpose

Define a controlled extension surface for household skills, application tools, and external MCP services while ensuring that model instructions cannot expand executable authority.

## Requirements

### Requirement: Only explicitly enabled tools are model-accessible
The system SHALL expose only operator-enabled application tools and tools provided by operator-configured MCP servers according to each server's exposure policy. General shell execution, unrestricted filesystem mutation, generic outbound HTTP access, and coding-oriented tools MUST remain disabled by default.

#### Scenario: Agent requests an unavailable coding tool
- **WHEN** the model attempts to call a shell, write, edit, or other tool that is not explicitly enabled
- **THEN** the system does not execute that operation

#### Scenario: Configured MCP server uses default exposure
- **WHEN** an operator configures an MCP server without a per-tool restriction
- **THEN** every valid tool discovered from that server is available to the agent under the server's namespace

#### Scenario: MCP server is not configured
- **WHEN** an MCP server has not been configured by the operator
- **THEN** none of that server's tools are available to the agent

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

### Requirement: Configured MCP servers expose discovered tools by default
The system SHALL expose every valid tool discovered from an operator-configured MCP server when no per-server `tools` restriction is configured. When `tools` is present, the system SHALL expose only the named tools, and an explicit empty list SHALL expose none.

#### Scenario: Initial unrestricted discovery
- **WHEN** a configured MCP server without a `tools` restriction reports its tool catalogue
- **THEN** all valid discovered tools are exposed under collision-resistant names associated with that server

#### Scenario: Unrestricted server adds a tool
- **WHEN** a configured unrestricted MCP server reports a new valid tool during later discovery or reconnection
- **THEN** the new tool becomes available without an application configuration change

#### Scenario: Operator supplies a restrictive list
- **WHEN** a configured MCP server has an explicit non-empty `tools` list
- **THEN** only discovered tools named in that list are exposed

#### Scenario: Operator supplies an empty list
- **WHEN** a configured MCP server has an explicit empty `tools` list
- **THEN** no tools from that server are exposed

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

### Requirement: Configured MCP tools support on-demand discovery
The system SHALL make permitted tools from each operator-configured MCP server discoverable by the agent on demand without declaring the entire MCP tool catalogue in every model request by default. An operator SHALL be able to select direct declaration for a configured server. Discovery and direct declaration MUST respect the server's `tools` restriction and MUST NOT make unconfigured or restricted tools callable.

#### Scenario: Default MCP discovery
- **WHEN** an operator configures an MCP server without selecting direct exposure and it reports valid tools
- **THEN** the agent can find and call its permitted tools through on-demand discovery while the complete catalogue is absent from the initial model tool declarations

#### Scenario: Direct MCP exposure is selected
- **WHEN** an operator selects direct exposure for a configured MCP server
- **THEN** its permitted discovered tools are declared to the model without a discovery step

#### Scenario: Explicit MCP tool restriction applies to discovery
- **WHEN** a configured MCP server reports a tool omitted from its explicit non-empty `tools` list
- **THEN** neither on-demand discovery nor a direct call makes that tool available

#### Scenario: Empty MCP tool restriction applies to discovery
- **WHEN** a configured MCP server has an explicit empty `tools` list
- **THEN** none of that server's tools can be found or called through any tool exposure path

#### Scenario: MCP resources are reported
- **WHEN** a configured MCP server reports resources or resource templates but the operator has enabled only its tool catalogue
- **THEN** resource helper operations are not exposed or callable

#### Scenario: Discovery follows session recreation
- **WHEN** a chat session is recreated after restart or cache eviction
- **THEN** its permitted MCP tools remain discoverable or directly available according to the current operator configuration

### Requirement: MCP result semantics survive tool exposure
The system SHALL report configured MCP tool failures as failures and SHALL preserve supported text and image result content while applying the configured result bounds and credential redaction before content reaches model context or operational records.

#### Scenario: MCP server returns an image with text
- **WHEN** an allowed MCP tool returns supported image and text content within configured limits
- **THEN** the agent receives both content types associated with that tool result

#### Scenario: MCP server reports a tool error
- **WHEN** an allowed MCP tool returns an MCP error result
- **THEN** the agent is informed of the failure and the service does not record or describe the action as successful

#### Scenario: MCP result contains a credential
- **WHEN** an allowed MCP tool returns a configured credential in textual content or structured metadata
- **THEN** that credential is absent from model-visible content, audit records, logs, and retained temporary output
