# Klaus Agent

Klaus Agent is a private Telegram home assistant built on Pi 1.0's headless libraries. It keeps one
SQLite-backed conversation per allowlisted chat and connects to home services through operator-
configured Streamable HTTP or stdio MCP servers and optional native capability providers. MCP tools
are deferred by default and loaded on demand; operators can select direct exposure per server. Pi's
coding tools and TUI are not enabled. Pi Durable remains deferred pending further stability.

## Local development

Requirements: Node.js 22.19 or newer and npm 12.2.0. Pi 1.0 publishes a dependency shrinkwrap
that older npm versions install ahead of Klaus's security override.

1. Install the exact dependencies with `npx --yes npm@12.2.0 ci`.
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
- `/model` opens a paginated inline selector of models Pi reports as available from authenticated
  backends, plus controls for the active model's reasoning level. Versioned `gpt-N` models are
  limited to major version 6 or newer; IDs outside that naming pattern remain available.
  `/model provider/model-id` selects an exact available model directly. The model selection is
  stored per chat and survives restart, cache eviction, compaction, and `/new`.
- `/compact` asks Pi to summarize older context. Compaction itself uses the selected model and can
  consume additional tokens.
- `/stop` requests cancellation of the operation active in that chat. It does not affect another
  chat and cannot undo a tool action that completed before cancellation.
- `/new` starts an empty conversation for the current chat while retaining its selected model.
- `/memory` lists the first page of shared memory. Use
  `/memory list <page>` to continue browsing and `/memory <note-id>` (including
  `/memory overview`) to read the exact stored note without model paraphrasing.

Commands are handled locally and are not sent to the conversational model as user prompts.
Authorization still requires both an allowlisted sender and an allowlisted chat; seeing a command
menu does not grant access.

## Telegram visual input

Klaus accepts photos and image documents in JPEG, PNG, or WebP format. In a private chat, send an
image directly or include a caption as the instruction. In a group, include a real Telegram mention
of Klaus in the caption or reply to a Klaus message; text that merely resembles the bot name does
not trigger processing. A captionless image uses a neutral instruction asking Klaus to respond to
the attached image.

Visual downloads are bounded and processed in memory. Configure the limits under `telegram.visualInput`:

```yaml
telegram:
  visualInput:
    maxBytes: 10485760
    downloadTimeoutMs: 15000
```

The selected model must advertise image input; Klaus does not switch models automatically. Unsupported,
oversized, malformed, unavailable, or model-incompatible images receive a local error and are not
retried. Telegram album items are currently processed as independent updates. Accepted images are
stored in Pi session history as base64 content, so they increase SQLite and backup size and may
increase model context cost until compaction. Audio, video, stickers, and animated images are not
supported.

## Telegram image generation

Image generation is disabled unless the optional `imageGeneration` block is configured. The first
backend uses the Pi-managed `openai-codex` OAuth session and keeps Codex's endpoint, model, and
account-routing details inside Klaus; the model-visible `generate_image` tool accepts only a bounded
text prompt. A successful tool call means that one validated PNG or JPEG is durably queued for the
originating Telegram chat, not that Telegram has already delivered it. The outbox retries uploads
without regenerating images and deduplicates a repeated tool call.

```yaml
imageGeneration:
  backend:
    type: openai-codex
  promptMaxBytes: 16384
  requestTimeoutMs: 180000
  maxResponseBytes: 16777216
  maxImageBytes: 10485760
```

Re-authenticate the protected Pi provider location if the Codex OAuth refresh token is stale. Image
provider failures degrade only this optional capability, while text conversations continue. Generated
bytes are retained only in eligible outbox/backup data and are removed from sent or cancelled rows
by retention cleanup; prompts, credentials, response bodies, and image bytes are not written to
health output or diagnostics. Before rollback to an older binary, drain or cancel pending photo
outbox rows because older workers do not understand photo intents. Use disposable prompts and inspect
both capability and delivery health before enabling this in a household deployment.

## Shared memory

Klaus keeps one SQLite-backed memory shared by every allowlisted participant. It stores
readable topic notes rather than conversation transcripts. Each note has a stable ID, title, prose
body, optional tags, revision, timestamps, and the admitted sender/update that last changed it.
The five model tools are `memory_list`, `memory_read`, `memory_search`, `memory_save`, and
`memory_delete`. The agent is instructed to honor explicit remember requests, capture useful
decisions and rationale, preserve uncertainty, read before revision, and avoid saving routine chat.
Opportunistic capture remains best-effort; use `/memory` to inspect and correct the canonical notes.

The reserved `Overview` note (stable ID `overview`) is a small summary loaded at the start of each conversational turn.
It is a snapshot: a write is immediately visible to a fresh `memory_read`, while another turn
already in flight may retain its older overview until its next turn. Clearing the overview advances
its revision and leaves it empty. Ordinary notes remain writable when the overview is full.

Notebook mutations commit inside their tool calls. A later `/stop`, model error, or Telegram
delivery failure does not undo a confirmed write. Revision checks prevent stale replacements and
deletes. Deleting a note removes it from current list/read/search results and removes exact
`memory:<id>` overview links, but does not erase old chat messages, tool results, summaries,
delivered Telegram messages, SQLite remnants, or backups.

The optional limits below use UTF-8 bytes. Startup fails instead of truncating if lowered values are
incompatible with existing notes:

```yaml
memory:
  overviewMaxBytes: 8192
  readMaxBytes: 16384
  listSearchMaxBytes: 16384
  maxResults: 20
  titleMaxBytes: 256
  tagMaxBytes: 64
  maxTags: 20
  previewMaxBytes: 240
```

A complete browse/save/read/revise/delete smoke test is:

1. Ask Klaus to remember a harmless preference and confirm the reply reports a successful save.
2. Run `/memory`, open the returned ID, and compare its literal body and revision.
3. Correct one detail in dialogue; reopen the ID and confirm its revision advanced while unrelated
   details remained.
4. Ask Klaus to delete the note; confirm `/memory <id>` reports not found.
5. Save and clear `overview`, restart the service, and confirm it remains empty at its newer
   revision.

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
Application-owned memory guidance, the current speaker, and the current overview snapshot are still
added per turn to either the built-in or configured base prompt.

## Generic MCP configuration

Each MCP entry has a stable local `id`, an HTTP(S) Streamable HTTP `url` or a fixed stdio command,
and optional mounted secret files. Secret values are loaded into memory for the Pi MCP connection;
they do not go in YAML, command arguments, conversation history, or model instructions. With `tools`
omitted, every valid tool from the configured server is permitted. The default `exposure: deferred`
keeps its full catalogue out of the initial model declarations and lets `tool_search` load matching
tools. Select `exposure: direct` to declare the permitted catalogue immediately:

```yaml
mcp:
  - id: home
    url: http://home-assistant-mcp:8086/mcp
    exposure: deferred # default; tool_search loads matching tools
    # exposure: direct  # declare all permitted tools immediately
```

Set a non-empty list to restrict exposure, or an empty list to expose none:

```yaml
tools: [ha_get_state, ha_set_todo_item] # only these tools
# tools: []                             # no tools
```

The model sees Pi names such as `mcp__home__ha_get_state`; characters outside letters, digits, and
underscores are normalized, and long or colliding names receive a hash suffix. Existing historical
tool calls keep their stored names and are not replayed. New calls use Pi's namespace. New tools from
an unrestricted server are available after discovery or session recreation. Use `tools` to restrict
the server catalogue, or `tools: []` to disable its tools. Only configure endpoints whose catalogue
you trust. The intended first deployment may point `home` at the existing Home Assistant MCP
server, but there is no Home Assistant-specific code.

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
  baseUrl: http://mealie-service.mealie.svc.cluster.local
  publicUrl: https://mealie.example.invalid # browser-accessible origin, not the internal API URL
  apiKeyFile: /run/secrets/mealie/api-key
  requestTimeoutMs: 30000
  importTimeoutMs: 180000
```

When `publicUrl` is set and Mealie reports a default group slug, recipe search, retrieval, and import results include a direct browser link (`/g/<group>/r/<slug>`). Configure the actual user-accessible origin; do not use the in-cluster `baseUrl` as the link. The model should share that link when referring the user to a recipe.

The native surface includes bounded recipe search/retrieval, URL import with explicit `sourceStrategy: scraper|ai` and `ingredientStrategy: imported|openai`, existing-recipe ingredient reparsing, and non-destructive category/tag list/create/rename/assignment operations. It does not expose arbitrary HTTP, shopping lists, meal planning, uploads, or deletion. Scraper and AI imports use Mealie's streaming endpoints; if a stream ends after the server may have committed, Klaus reports an indeterminate result and never retries automatically. If ingredient processing fails after creation, the result includes the created slug and partial stage. If Mealie returns only blank ingredient placeholders, Klaus reports a partial import instead of claiming success. Do not automatically retry a failed or partial creation; inspect the existing recipe first.

Create a dedicated Mealie automation key outside the repository and mount it read-only. Klaus sends it only as a bearer header, rejects redirects, redacts it from audits and diagnostics, and bounds remote responses and model-visible results. Mealie's own HTTP allow/disallow policy remains authoritative for URLs that Mealie fetches. Validate both import paths and both ingredient modes against disposable recipes before household rollout; remove the configuration and secret mount to roll back.

## Native Paperless-ngx document integration

Paperless is optional and remains disabled when its configuration is omitted. It uses Klaus's own
bounded native integration with the official API v10; it does not require a third-party Paperless
MCP server. Configure a dedicated least-privilege Paperless API token in a mounted secret file and
keep the URL and secret path free of credentials:

```yaml
paperless:
  baseUrl: https://paperless.example.invalid # include an application subpath if deployed beneath one
  publicUrl: https://docs.example.invalid/paperless # optional user-accessible application URL
  apiTokenFile: /run/secrets/paperless/api-token
  requestTimeoutMs: 30000
  uploadTimeoutMs: 60000
  downloadTimeoutMs: 15000
  maxResponseBytes: 2097152
  maxResultBytes: 65536
  maxUploadBytes: 10485760
```

The integration checks API v10 compatibility and fails closed rather than falling back to older API
contracts. The same Paperless account is used in authorized private chats and the allowlisted
household group; existing sender/chat authorization and group mention/reply rules still apply.
Review Paperless object permissions and default workflows for the automation account separately.
Documents uploaded by Klaus may not be visible to household UI accounts unless Paperless permissions
or workflows provide that visibility. Tokens are sent only as `Authorization: Token` headers.

Telegram uploads are limited to validated, bounded current-message PDF, JPEG, or PNG attachments
and require an explicit upload request; PDF bytes are not sent to the model. Telegram images retain
their existing visual-input behavior, including WEBP, which is not in the initial upload format set.
Paperless acknowledges ingestion asynchronously: an accepted upload is not yet a consumed document,
and a durable receipt can be checked for processing status. Uncertain submissions are never
automatically retried. OCR requested through Klaus is sent to the configured model provider and may
be present in its conversation session and tool audit retention; it is not automatically copied to
shared memory. Inspect the installed API version, permissions, and workflows against disposable
staging documents before enabling this integration.

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
