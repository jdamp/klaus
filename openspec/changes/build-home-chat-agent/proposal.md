## Why

The household needs a private, extensible chat agent that can safely interact with homelab services without exposing a general-purpose coding environment. Building it on Pi's headless SDK provides proven agent sessions, skills, tools, and model integration while allowing Telegram access, persistence, and deployment behavior to remain tailored to a small family installation.

## What Changes

- Add a Telegram interface restricted by explicit user and chat allowlists, with private-chat conversations and mention/reply/command-only activation in groups.
- Add durable, independent agent sessions per Telegram chat, including bounded model context, compaction, delivery deduplication, and operational auditing in SQLite.
- Embed Pi through its headless SDK with coding-oriented tools disabled, while supporting Pi-managed model-provider authentication, operator-installed skills, application-defined tools, and allowlisted MCP tools.
- Support authenticated Streamable HTTP MCP servers through generic configuration rather than coupling the application to a particular home-service server. The existing Home Assistant MCP endpoint is an initial deployment choice, and specialized native tools can be added later.
- Use subscription-backed OpenAI Codex authentication through Pi for the initial deployment while keeping provider, model, and reasoning settings configurable and retaining API-key-based providers as alternatives.
- Package the application as a single-container modular monolith for local development and eventual single-replica k3s deployment, with persistent storage, mounted secrets, durable writable Pi authentication state, health reporting, and graceful shutdown.

## Capabilities

### New Capabilities

- `telegram-chat-access`: Authorized Telegram users and chats can interact with the bot under explicit private-chat and group-trigger rules.
- `agent-conversations`: Each accepted chat has an isolated, durable Pi conversation with bounded context and lifecycle controls.
- `agent-capability-extensions`: Operators can provide skills, native tools, and authenticated MCP servers through controlled capability discovery and policy enforcement.
- `runtime-operations`: The service can be securely configured, authenticated, observed, persisted, run locally, and operated as a single-replica k3s workload.

### Modified Capabilities

None.

## Impact

- Introduces a greenfield TypeScript/Node.js service built around Pi's headless coding-agent SDK and model/runtime packages.
- Adds integrations with the Telegram Bot API, the Model Context Protocol TypeScript client, configurable Streamable HTTP MCP endpoints, and Pi-managed provider authentication.
- Adds SQLite-backed application state plus operator-managed configuration, skills, MCP policy, mounted service credentials, and a separate protected Pi OAuth store.
- Produces local development workflows, a container image, and a single-replica k3s example; no public inbound endpoint is required for the initial long-polling design.
- Defers calendar-derived notifications to a separate follow-up change after the reactive Telegram and MCP foundation is stable.
