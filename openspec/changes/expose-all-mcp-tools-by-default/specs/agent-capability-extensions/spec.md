## MODIFIED Requirements

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

## ADDED Requirements

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

## REMOVED Requirements

### Requirement: MCP tool discovery is fail-closed

**Reason**: Requiring every remote tool to be named is too restrictive when the configured MCP server is itself the household trust boundary.

**Migration**: Existing non-empty `tools` lists keep their restrictive behavior. Remove `tools` from a server entry to expose all discovered tools, or set it to an empty list to expose none.
