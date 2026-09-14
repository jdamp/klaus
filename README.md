# Klaus Agent

Klaus Agent is a private Telegram home assistant built on Pi's headless libraries. It keeps one
durable conversation per allowlisted chat and connects to home services through operator-configured
Streamable HTTP MCP servers. Configured MCP servers expose their discovered tools by default; Pi's coding tools
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

## Finding immutable Telegram IDs

Create the bot with BotFather, add it to the family group, and send one direct message and one
explicitly addressed group message. Stop any running Klaus Agent instance before calling
`getUpdates`, because a bot must have only one long-poll consumer.

The following reads the token without echoing it, passes it to curl through standard input rather
than a command-line argument, and prints only immutable IDs and chat types:

```sh
read -r -s KLAUS_TELEGRAM_TOKEN
printf 'url = "https://api.telegram.org/bot%s/getUpdates"\n' "$KLAUS_TELEGRAM_TOKEN" |
  curl --fail --silent --show-error --config - |
  jq '.result[] | .message // .channel_post | {sender_id: .from.id, chat_id: .chat.id, chat_type: .chat.type}'
unset KLAUS_TELEGRAM_TOKEN
```

Copy decimal IDs as quoted strings. Negative IDs identify groups/supergroups. Authorization always
requires both an allowlisted sender ID and an allowlisted chat ID; usernames and display names are
never used.

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

The k3s example and rollout procedure are documented in
[`docs/deployment.md`](docs/deployment.md). Backup, upgrade, and rollback procedures are in
[`docs/operations.md`](docs/operations.md).

## Quality gates

`npm run check` runs formatting checks, linting, TypeScript validation, unit/integration tests,
and a clean production build.
