## Context

The current MCP configuration requires a non-empty `tools` array, and discovery exposes a remote tool only when its name is present in that array. The same filter is reapplied on reconnect. The server URL, optional transport token, namespace, argument validation, execution bounds, audit records, and health isolation are already centralized around each configured MCP server.

See `proposal.md` for the motivation and `specs/agent-capability-extensions/spec.md` for the revised behavior contract.

## Goals / Non-Goals

**Goals:**

- Make a configured MCP server's complete valid tool catalogue the default exposure policy.
- Preserve an explicit per-server restriction mechanism without changing existing restrictive configurations.
- Use the same policy for initial discovery and every reconnect.
- Keep the configured server—not each individual remote tool—as the default trust boundary.

**Non-Goals:**

- Enabling Pi's built-in coding, shell, filesystem, or generic HTTP tools.
- Connecting to MCP servers that the operator has not configured.
- Adding Home Assistant-specific policy or tool adapters.
- Adding roles, per-user tool permissions, confirmations, or risk classification.
- Redesigning MCP discovery, transport, auditing, timeouts, or result limits.

## Decisions

### 1. Give `tools` three configuration states

The per-server `tools` field will become optional and will not receive a parser default:

- omitted: expose all valid discovered tools;
- non-empty array: expose only named tools;
- empty array: expose no tools.

This preserves every existing configuration's behavior while making the concise configuration the permissive default. It also gives operators an explicit deny-all state without adding another policy field.

Alternatives considered:

- A wildcard such as `tools: ["*"]` keeps the current schema but does not make all tools the actual default and introduces a magic remote-tool name.
- A separate `toolPolicy` enum is more verbose and creates combinations whose precedence must be defined.
- Removing allowlists entirely would prevent installations from narrowing a server later.

### 2. Apply one exposure predicate after each discovery

The registry will expose a discovered tool when `tools` is absent or contains the remote name. An explicit empty array naturally matches nothing. This predicate will remain at the registry boundary, after server discovery and before namespaced Pi-tool construction, so startup and reconnect cannot diverge.

Namespacing, schema compilation, local argument validation, cancellation, timeouts, result truncation, audit transitions, and credential handling remain unchanged. A server must still be explicitly configured before any of its tools can enter an agent session.

### 3. Make default-all the primary documented configuration

The README, example k3s ConfigMap, and test fixtures will omit `tools` for the normal trusted-server case. Documentation will also show an explicit list and an empty list as optional restriction modes. The staged acceptance checklist will verify default catalogue exposure and retain a separate automated test proving that an explicit restriction hides unlisted tools.

Existing staged evidence remains a record of the earlier restrictive configuration and will not be rewritten.

## Risks / Trade-offs

- **A configured server may add an unexpectedly powerful tool** → Treat server configuration as explicit trust in its catalogue; retain optional lists for endpoints that also expose unwanted or critical operations.
- **Large tool catalogues increase model context use and selection latency** → Preserve the optional restrictive list; consider dynamic tool search as a separate future optimization if real usage warrants it.
- **Operators may assume an existing list automatically adopts the new default** → Document that existing lists remain restrictive and must be removed deliberately.
- **An explicit empty list could be mistaken for default-all** → Test and document its deny-all meaning alongside the omitted-field behavior.

## Migration Plan

1. Release the parser and registry behavior together so an omitted `tools` field is accepted only when default-all exposure is implemented.
2. Keep existing non-empty lists unchanged during upgrade.
3. To adopt default-all behavior, remove `tools` from the desired MCP server configuration and restart the service.
4. Verify discovery health and confirm representative previously unlisted namespaced tools are present before household use.
5. Roll back by restoring a non-empty `tools` list before starting an older image, because the previous configuration schema requires it.
