## Context

Klaus currently models every MCP entry as an HTTP(S) URL with an optional bearer-token file, and `SdkMcpClient` constructs only `StreamableHTTPClientTransport`. The registry already centralizes discovery, tool exposure, local AJV validation, cancellation, timeouts, result bounding, redaction, auditing, reconnects, and health isolation.

Kaneo’s unmodified built-in `/api/mcp` accepts session/OAuth bearer tokens rather than ordinary Kaneo API keys. Its official `@kaneo/mcp` package instead exposes a stdio server and supports `KANEO_API_URL` plus a stable `KANEO_API_KEY`, which skips device authorization and token caching. The package’s declared Node 24 prerequisite conflicts with Klaus’s Node 22 image, but the pinned published `0.1.11` package was successfully initialized and enumerated its catalogue under the current Node 22.23.2 runtime during research.

See proposal.md for motivation and the capability delta for the behavioral contract.

## Goals / Non-Goals

**Goals:**

- Add one secure, reusable stdio transport option without changing existing Streamable HTTP configuration.
- Keep Kaneo’s API key out of command lines, model-visible data, SQLite, logs, health details, and rendered public configuration.
- Ship the Kaneo MCP executable in the Klaus image with a reproducible dependency lock rather than invoke `npx` at runtime.
- Expose only the requested Kaneo workspace lookup, project, task, status, assignee, and due-date operations.

**Non-Goals:**

- Modifying, proxying, or redeploying Kaneo.
- Implementing OAuth callback, token refresh, or browser/device authorization in Klaus.
- Adding workspace creation, update, or deletion.
- Exposing Kaneo deletion, comments, labels, relations, search, notification, time-entry, or `whoami` tools.
- Letting model input execute a command or modify a child-process environment.

## Decisions

### 1. Add an explicit local stdio transport configuration while retaining the URL form

Keep the existing URL-based MCP entry as the Streamable HTTP form. Add a mutually exclusive stdio form that declares a fixed executable, argument vector, non-secret environment values, and a map of environment-variable names to mounted secret files. Validate that exactly one transport form is present, command/variable names are non-empty valid values, secret-file paths are absolute after normalization, and credential file references are removed from public configuration output.

For Kaneo, the deployment will use `node` with the installed package’s `dist/index.js` and explicit `serve` command, set `KANEO_API_URL` to `https://todo.mauzlab.de`, and map `KANEO_API_KEY` from its read-only secret file. The configuration allowlist will contain only:

- `list_workspaces`
- `list_projects`, `get_project`, `create_project`, `update_project`, `list_project_columns`
- `list_tasks`, `get_task`, `create_task`, `update_task`, `move_task`, `update_task_status`, `update_task_assignee`, `update_task_due_date`
- `list_workspace_members`

The existing optional `tools` semantics remain unchanged. In particular, the explicit list is required for Kaneo so an upstream catalogue change cannot expose destructive tools.

Alternatives considered:

- Replacing the existing HTTP shape with a transport discriminator would force all current configurations to migrate without a benefit.
- A generic shell-command string would introduce quoting ambiguity and make command injection easier; executable plus argument vector preserves process boundaries.
- Passing `KANEO_API_KEY` through a Kubernetes container environment variable or command line would make accidental exposure easier; resolving a mounted file immediately before spawn narrows its lifetime and visibility.

### 2. Use SDK `StdioClientTransport` behind the existing client interface

Add a stdio implementation of `McpClientLike` using the already pinned MCP SDK’s `StdioClientTransport`. The registry factory selects the transport from validated configuration but continues to expose the same `connect`, `listTools`, `callTool`, and `close` contract. This keeps tool discovery and all call safeguards transport-independent.

The child receives a deliberately constructed environment: SDK safe inherited values plus configuration-provided non-secrets and secret values resolved from mounted files. Child stderr is treated as diagnostic data, bounded and redacted before it can become a health detail; stdout remains exclusively the MCP JSON-RPC channel. A child exit follows the existing optional-server degraded-health and bounded reconnect path.

Alternatives considered:

- A separate stdio-to-Streamable-HTTP gateway would add another network service and its lifecycle/session failure modes. The available gateway has known Streamable HTTP child-process lifecycle issues.
- Adding Kaneo OAuth support directly to Klaus cannot provide reliable unattended operation because Kaneo does not issue refresh tokens and access tokens expire after 30 days.
- Using Kaneo’s built-in HTTP endpoint with an API key is not viable because that endpoint does not validate ordinary API keys.

### 3. Pin the official Kaneo MCP package as an application dependency

Add exact `@kaneo/mcp@0.1.11` to production dependencies and update the lockfile. The existing multi-stage Docker build will install the locked package into `/app/node_modules`; no startup download, global installation, or writable package/cache directory is needed. The implementation will retain the project’s Node 22 image and add an integration-style stdio test that starts the installed server with a non-sensitive test configuration or a controlled fixture, so the tested compatibility is recorded.

Alternatives considered:

- `npx -y @kaneo/mcp` is simple but downloads mutable executable code at startup and can fail when npm is unavailable.
- A global package or a custom Kaneo wrapper increases image drift and maintenance.
- Upgrading solely to Node 24 increases deployment scope despite successful validation on the pinned Node 22 runtime; revisit if a future Kaneo package requires it.

### 4. Mount a dedicated Kaneo key and deploy only the allowlisted integration

Document/create a dedicated Kaneo API key owned by the intended automation account, put it in a Kubernetes Secret separate from configuration, and mount only its key file read-only at `/run/secrets/kaneo/api-key`. Update the example ConfigMap and Secret template to include the Kaneo stdio entry and credential. Retain the existing Home Assistant example as independent optional configuration rather than replacing it with Kaneo credentials.

Deployment verification will use an actual non-destructive project/task test in a designated test project: list workspaces/projects/tasks, create/update a test project or task as permitted by the dedicated account, then confirm Kaneo reflects the result. It will also attempt to discover or call excluded deletion/workspace-mutation tools and confirm they are unavailable in Klaus.

## Risks / Trade-offs

- **The external MCP package can change its protocol or Node support** → pin its exact version, retain the SDK compatibility test, and upgrade only after an image build and representative live test.
- **A child process can hang, exit, or emit sensitive diagnostics** → use the registry’s timeout/cancellation and reconnect behavior; bound/redact stderr and never log raw child environment.
- **The dedicated API key has the authority of its Kaneo owner** → use a dedicated minimally privileged account/key where Kaneo permits, mount it read-only, and enforce Klaus’s explicit tool allowlist as a second boundary.
- **A tool allowlist cannot prevent all destructive effects of an allowed update operation** → exclude explicit deletes and document that operators should use a non-critical test project during rollout.
- **Kaneo `whoami` is known to return `null` in API-key mode** → do not allowlist or depend on it; use workspace-member listing when a user identifier is needed.

## Migration Plan

1. Build and validate the image with the pinned official package and stdio transport tests while retaining existing HTTP MCP configuration compatibility.
2. Create a dedicated Kaneo API key and a Kubernetes Secret outside the repository; do not reuse or commit a personal API key.
3. Apply the revised Secret and ConfigMap, then deploy the immutable image using the existing single-replica `Recreate` rollout.
4. Confirm readiness, Kaneo MCP healthy status, the namespaced allowlisted catalogue, a read operation, and a harmless test-project/task create/update operation.
5. Confirm excluded deletion and workspace-mutation tool names are unavailable; inspect logs, health output, and SQLite data for credential leakage.
6. Roll back by restoring the prior image and ConfigMap and removing the Kaneo MCP entry/mount. Revoke the dedicated Kaneo API key if it was exposed or the integration is retired.
