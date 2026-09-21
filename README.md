# Klaus Agent

Klaus Agent is a private Telegram home assistant built on Pi's headless libraries. It keeps one
durable conversation per allowlisted chat and connects to home services through operator-configured
Streamable HTTP MCP servers and optional native capability providers. Configured MCP servers expose their discovered tools by default; Pi's coding tools
or TUI.

## Local development

Requirements: Node.js 22.13 or newer and npm.

1. Install the exact dependencies with `npm ci`.
2. Copy `examples/config.local.yaml` to `config.yaml`.
3. Create `.local/secrets`, `.local/pi-auth`, and `.local/data`. Keep them private
   (directories mode `0700`, secret files mode `0600`).
4. Put the Telegram bot token in `.local/secrets/telegram-token`, and each optional MCP bearer
   token in its configured file. Secret files contain only the token, optionally followed by a
   newline.
5. Replace all example Telegram IDs and MCP URLs with reviewed deployment values.
6. Bootstrap the Pi-owned provider credentials:

   ```sh
   npm run dev -- auth login --type oauth --config config.yaml
   ```

7. Start the service:

   ```sh
   npm run dev -- --config config.yaml
   ```

The health endpoints are `/live` and `/ready` on the configured health listener. The service
uses Telegram long polling and needs no public ingress.

## Telegram commands

Klaus registers the same command menu in private and group chats. Telegram displays group commands
with the bot username appended (for example, `/status@klaus_bot`); this is the same logical command
as `/status` in a private chat.

- `/start` shows command help. The unadvertised `/help` alias has the same behavior.
- `/status` reports the active model and reasoning level, cumulative Pi-recorded token usage and
  cost for the current session, and current context-window utilization. It cannot report provider
  subscription quota, and context usage can be unknown until the first response after compaction.
- `/model` opens a paginated inline selector containing every model Pi currently reports as
  available from authenticated backends, plus controls for the active model's reasoning level.
  `/model provider/model-id` selects an exact model directly. The model selection is stored per chat
  and survives restart, cache eviction, compaction, and `/new`.
- `/compact` asks Pi to summarize older context. Compaction itself uses the selected model and can
  consume additional tokens.
- `/stop` requests cancellation of the operation active in that chat. It does not affect another
  chat and cannot undo a tool action that completed before cancellation.
- `/new` starts an empty conversation for the current chat while retaining its selected model.

Commands are handled locally and are not sent to the conversational model as user prompts.
Authorization still requires both an allowlisted sender and an allowlisted chat; seeing a command
menu does not grant access.

## Household system prompt

The built-in household system prompt is used by default. To replace it with operator-managed
instructions, configure an explicit UTF-8 file path:

```yaml
agent:
  systemPromptFile: /etc/klaus-agent/AGENTS.md
```

The file is the complete system prompt, not an addition to the built-in prompt. It is read once at
startup; missing, unreadable, empty, or whitespace-only files prevent startup. The application does
not automatically discover `AGENTS.md` or other context files. Mount the file read-only with
restricted permissions and restart after changing it.

## Generic MCP configuration

Each MCP entry has a stable local `id`, an HTTP(S) Streamable HTTP `url`, and an optional mounted
`tokenFile`. Omitting `tools` exposes every valid tool discovered from that configured server:

```yaml
mcp:
  - id: home
    url: http://home-assistant-mcp:8086/mcp
```

Set a non-empty list to restrict exposure, or an empty list to expose none:

```yaml
tools: [ha_get_state, ha_set_todo_item] # only these tools
# tools: []                             # no tools
```

The model sees namespaced names such as `home__ha_get_state`; it never receives the bearer token.
New tools reported by an unrestricted configured server become available after discovery or
reconnection. Only configure endpoints whose catalogue you trust, and use the optional restriction
when a server also exposes operations you do not want available. The intended first deployment may
point `home` at the existing Home Assistant MCP server, but there is no Home Assistant-specific code.

A local stdio MCP server can instead be configured with a fixed executable and argument vector. Ordinary environment values are declared inline; secret values are read from mounted files immediately before the child starts:

```yaml
mcp:
  - id: kaneo
    command: node
    args: [/app/node_modules/@kaneo/mcp/dist/index.js, serve]
    env:
      KANEO_API_URL: https://todo.mauzlab.de
    secretEnv:
      KANEO_API_KEY: /run/secrets/kaneo/api-key
    tools:
      [
        list_workspaces,
        list_projects,
        get_project,
        create_project,
        update_project,
        list_project_columns,
        list_tasks,
        get_task,
        create_task,
        update_task,
        move_task,
        update_task_status,
        update_task_assignee,
        update_task_due_date,
        list_workspace_members,
      ]
```

The production image pins the official `@kaneo/mcp` package, so it does not use `npx` or download code at startup. Create the Kaneo API key under a dedicated automation account, mount it as a read-only secret, and never put it in YAML, command arguments, logs, or model instructions. The example allowlist intentionally excludes workspace mutation/deletion, task deletion, comments, labels, relations, search, notifications, time entries, and `whoami`.

## Native Mealie recipe integration

Mealie is optional and is enabled only when both `baseUrl` and a mounted `apiKeyFile` are configured. Use Mealie 3.23.0 or newer; Klaus intentionally has no legacy API path, so a 3.22 deployment must be upgraded first. Configure Mealie's AI provider before using an AI import or OpenAI ingredient normalization:

```yaml
mealie:
  baseUrl: https://mealie.example.invalid
  apiKeyFile: /run/secrets/mealie/api-key
  requestTimeoutMs: 30000
  importTimeoutMs: 180000
```

The native surface includes bounded recipe search/retrieval, URL import with explicit `sourceStrategy: scraper|ai` and `ingredientStrategy: imported|openai`, existing-recipe ingredient reparsing, and non-destructive category/tag list/create/rename/assignment operations. It does not expose arbitrary HTTP, shopping lists, meal planning, uploads, or deletion. Scraper and AI imports use Mealie's streaming endpoints; if a stream ends after the server may have committed, Klaus reports an indeterminate result and never retries automatically. If ingredient processing fails after creation, the result includes the created slug and partial stage.

Create a dedicated Mealie automation key outside the repository and mount it read-only. Klaus sends it only as a bearer header, rejects redirects, redacts it from audits and diagnostics, and bounds remote responses and model-visible results. Mealie's own HTTP allow/disallow policy remains authoritative for URLs that Mealie fetches. Validate both import paths and both ingredient modes against disposable recipes before household rollout; remove the configuration and secret mount to roll back.

## Container

Build and run the same application artifact locally:

```sh
docker build --tag klaus-agent:1.0.0 .
docker run --rm --read-only --name klaus-agent \
  --mount type=bind,src="$PWD/config.yaml",dst=/etc/klaus-agent/config.yaml,readonly \
  --mount type=bind,src="$PWD/.local/secrets",dst=/run/secrets,readonly \
  --mount type=bind,src="$PWD/.local/data",dst=/var/lib/klaus-agent \
  --mount type=bind,src="$PWD/.local/pi-auth",dst=/var/lib/klaus-agent-auth \
  --publish 127.0.0.1:8080:8080 klaus-agent:1.0.0
```

For this layout, update the container configuration paths to `/run/secrets/...`,
`/var/lib/klaus-agent`, and `/var/lib/klaus-agent-auth/auth.json`, and set the health host to
`0.0.0.0`.

The k3s manifests deploy to the pre-provisioned `klaus` namespace; the example and rollout
procedure are documented in [`docs/deployment.md`](docs/deployment.md). Backup, upgrade, and
rollback procedures are in [`docs/operations.md`](docs/operations.md).

## Quality gates

`npm run check` runs formatting checks, linting, TypeScript validation, unit/integration tests,
and a clean production build.
