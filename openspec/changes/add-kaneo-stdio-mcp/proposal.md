## Why

Kaneo’s built-in remote MCP endpoint requires short-lived OAuth access tokens and does not accept its stable API keys. Klaus needs unattended access to Kaneo projects and tasks without modifying Kaneo or requiring periodic interactive reauthorization.

## What Changes

- Add operator-configured stdio MCP server support alongside existing authenticated Streamable HTTP MCP support.
- Support a mounted secret file as an environment-variable value for a stdio MCP child process, without exposing its value to model context, persistent data, or logs.
- Package and pin Kaneo’s official `@kaneo/mcp` stdio server so deployment does not download executable code at runtime.
- Configure the Klaus k3s deployment with a dedicated Kaneo API key and a restrictive Kaneo tool allowlist for project and task management; retain workspace lookup only and exclude deletion and unrelated tools.
- Preserve namespacing, discovered-schema validation, cancellation, timeouts, result bounds, auditing, and optional-capability health behavior for both MCP transports.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `agent-capability-extensions`: Allow configured MCP servers to use either Streamable HTTP or a locally spawned stdio transport while retaining credential isolation and capability safeguards.

## Impact

- Affects `src/config.ts`, `src/mcp/registry.ts`, MCP/configuration tests, package dependencies and lockfile.
- Updates the production image and `deploy/k3s/klaus-agent.yaml` to include the official Kaneo MCP package and mount/configure the Kaneo API-key secret.
- Adds a child-process boundary for stdio MCP integrations; no Kaneo source code or redeployment changes are required.
