## 1. Configuration and dependency setup

- [x] 1.1 Extend the MCP configuration schema and public-config/path validation with a mutually exclusive stdio form (executable, argument vector, ordinary environment, and secret-environment file map) while retaining legacy Streamable HTTP entries; verify parser tests cover valid forms, invalid combinations, absolute paths, and redacted public output.
- [x] 1.2 Add and lock exact production dependency `@kaneo/mcp@0.1.11`; verify `npm ci`, production Docker build, and dependency inspection show the package is installed without runtime `npx` use.

## 2. Stdio MCP transport

- [x] 2.1 Implement the stdio `McpClientLike` adapter with the MCP SDK transport and select it from validated configuration while preserving the existing Streamable HTTP client path; verify discovery, namespacing, explicit tool allowlists, calls, and reconnect behavior pass for both transports.
- [x] 2.2 Resolve secret-environment files immediately before child startup, construct only the intended child environment, and bound/redact child diagnostics; verify a controlled stdio fixture receives its secret but the secret is absent from Pi tool output, audits, health details, logs, and public configuration.
- [x] 2.3 Preserve cancellation, configured call timeout/result limits, child shutdown, and degraded-health isolation for stdio child startup/exit failures; verify focused registry tests cover each outcome without disrupting a healthy configured server.
- [x] 2.4 Start the installed `@kaneo/mcp@0.1.11` with `node …/dist/index.js serve` under the production Node 22 runtime and enumerate its tool catalogue; verify the integration test records successful initialization without device-flow interaction.

## 3. Kaneo deployment configuration and documentation

- [x] 3.1 Update the k3s ConfigMap and secret example to mount a dedicated read-only Kaneo API-key file and configure `https://todo.mauzlab.de` through the packaged stdio server; verify manifest/config tests or `kubectl` dry-run accept the rendered resources.
- [x] 3.2 Configure the Kaneo MCP entry with only workspace lookup, project CRUD/list/columns, task CRUD/list/move/status/assignee/due-date, and workspace-member tools; verify deletion, workspace mutation, comments, labels, relations, search, notifications, time entries, and `whoami` are absent from Klaus’s namespaced catalogue.
- [x] 3.3 Update README and deployment rollout/smoke-test guidance for stdio MCP configuration, dedicated API-key creation/revocation, restricted Kaneo scope, and rollback; verify documentation does not contain a credential or recommend runtime package downloads.

## 4. Verification and rollout

- [x] 4.1 Run formatting, linting, type checking, all automated tests, production build, and strict OpenSpec validation for `add-kaneo-stdio-mcp`; verify every command succeeds.
- [ ] 4.2 Create the dedicated Kaneo API key outside the repository, deploy the immutable image with `Recreate`, and verify readiness plus healthy Kaneo MCP discovery.
- [ ] 4.3 In a designated non-critical Kaneo project, verify workspace/project/task reads and one harmless project or task create/update through Klaus, confirm the result in Kaneo, and verify excluded deletion/workspace-mutation tools cannot be called; inspect logs, health output, and SQLite data for credential leakage.
