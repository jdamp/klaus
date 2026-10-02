## ADDED Requirements

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
