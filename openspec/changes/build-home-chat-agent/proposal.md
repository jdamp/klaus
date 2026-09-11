## Why

The household needs a private, extensible chat agent that can safely interact with homelab services without exposing a general-purpose coding environment. Building it on Pi's headless SDK provides proven agent sessions, skills, tools, and model integration while allowing Telegram access, persistence, and deployment behavior to remain tailored to a small family installation.

## What Changes

- Add a Telegram interface restricted by explicit user and chat allowlists, with private-chat conversations and mention/reply/command-only activation in groups.
- Add durable, independent agent sessions per Telegram chat, including bounded model context, compaction, delivery deduplication, and operational auditing in SQLite.
- Embed Pi through its headless SDK with coding-oriented tools disabled, while supporting operator-installed skills, application-defined tools, and allowlisted MCP tools.
- Connect initially to an existing authenticated Home Assistant MCP server over Streamable HTTP; allow additional homelab services and specialized native tools to be added later.
- Add deterministic calendar-derived Telegram reminders, using Home Assistant as the intended calendar aggregation boundary without involving the language model in scheduled delivery.
- Package the application as a single-container modular monolith suitable for either a VM or a single-replica k3s workload, with persistent storage, mounted secrets, health reporting, and graceful shutdown.

## Capabilities

### New Capabilities

- `telegram-chat-access`: Authorized Telegram users and chats can interact with the bot under explicit private-chat and group-trigger rules.
- `agent-conversations`: Each accepted chat has an isolated, durable Pi conversation with bounded context and lifecycle controls.
- `agent-capability-extensions`: Operators can provide skills, native tools, and authenticated MCP servers through controlled capability discovery and policy enforcement.
- `calendar-reminders`: Calendar events can produce deterministic, durable, deduplicated Telegram reminders without an LLM invocation.
- `runtime-operations`: The service can be securely configured, observed, persisted, and operated in either a VM or k3s deployment.

### Modified Capabilities

None.

## Impact

- Introduces a greenfield TypeScript/Node.js service built around the headless `@earendil-works/pi-coding-agent` SDK and Pi model/runtime packages.
- Adds integrations with the Telegram Bot API, the Model Context Protocol TypeScript client, an existing Home Assistant MCP endpoint, and eventually Home Assistant calendar APIs.
- Adds SQLite-backed application state plus operator-managed configuration, skills, MCP policy, and mounted credentials.
- Produces a container image and runtime configuration for VM/systemd or single-replica k3s operation; no public inbound endpoint is required for the initial long-polling design.
