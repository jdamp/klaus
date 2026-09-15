## ADDED Requirements

### Requirement: Authenticated stdio MCP servers are supported
The system SHALL connect to an operator-configured MCP server by spawning its configured stdio command and arguments. It SHALL discover and namespace its tools by server identity and apply the same configured tool-exposure policy, schema validation, cancellation, timeout, result-size bound, audit, and optional-capability health behavior as it applies to Streamable HTTP MCP servers.

#### Scenario: Configured stdio MCP connection succeeds
- **WHEN** an operator-configured stdio MCP command starts and reports its tool catalogue
- **THEN** enabled tools are made available to the agent under collision-resistant names associated with that server

#### Scenario: Stdio MCP receives a mounted credential
- **WHEN** an operator maps a mounted secret file to an environment variable for a configured stdio MCP server
- **THEN** the child process receives the secret value only through that environment variable and the value is not included in model prompts, tool arguments, SQLite content, logs, health details, or public configuration output

#### Scenario: Stdio MCP child cannot start or disconnects
- **WHEN** an optional configured stdio MCP child fails to start or disconnects
- **THEN** the server is reported as degraded and unrelated agent capabilities remain available

#### Scenario: Model attempts to influence a child command
- **WHEN** model input or an MCP tool argument contains a command, argument, or environment-variable value
- **THEN** the system does not use that value to select or alter a stdio MCP child process
