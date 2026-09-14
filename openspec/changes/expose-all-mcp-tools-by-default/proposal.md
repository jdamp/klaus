## Why

Mandatory per-tool MCP allowlists make a trusted home-assistant server cumbersome to use and prevent the agent from benefiting automatically from its available capabilities. For this household deployment, configuring the MCP server itself is the intended trust boundary, while per-tool restriction should remain optional.

## What Changes

- Expose every tool discovered from a configured MCP server when that server has no `tools` restriction.
- Keep `tools` as an optional per-server allowlist for operators who want to narrow access; an explicit empty list exposes no tools.
- Apply the selected exposure policy consistently during startup discovery and reconnects, including tools added later by the server.
- Preserve MCP namespacing, schema validation, timeouts, result bounds, audit records, credential isolation, and optional-integration health behavior.
- Continue disabling Pi coding tools, unrestricted filesystem access, shell execution, and generic outbound HTTP capabilities.
- Update configuration examples, deployment guidance, and acceptance tests to make default-all MCP behavior clear.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `agent-capability-extensions`: Trust configured MCP servers by default, expose their discovered tools unless an optional per-server allowlist restricts them, and keep non-MCP tool authority explicitly bounded.

## Impact

- Changes MCP configuration validation so `tools` is optional and may be empty when explicitly present.
- Changes the MCP registry's discovery filter and reconnect behavior.
- Updates MCP/configuration tests, examples, README guidance, deployment checks, and the staged smoke-test expectations.
- Existing configurations with a non-empty `tools` list remain restrictive and compatible; operators must remove that field to adopt default-all discovery.
