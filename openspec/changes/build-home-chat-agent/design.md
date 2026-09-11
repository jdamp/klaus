## Context

This is a greenfield service; the repository currently contains no application code or durable capability specs. See `proposal.md` for motivation and the change specs for behavioral contracts.

The installation serves two adults initially, with possible future children, through a small set of explicitly allowlisted Telegram private chats and family groups. The first home integration is an already deployed Home Assistant MCP server exposed over authenticated Streamable HTTP. Device scope is limited to non-critical household services such as lights, a vacuum, desk height, and shopping lists. Calendar reminders are expected later, with Home Assistant acting as the likely aggregation point for a shared Google Calendar. The runtime must fit either a VM or a single-replica k3s deployment.

## Goals / Non-Goals

**Goals:**

- Keep authorization, capability policy, persistence, and delivery reliability outside model judgment.
- Reuse Pi's headless session, compaction, resource loading, model runtime, and tool APIs without running its TUI.
- Make Telegram, MCP, persistence, calendar sourcing, and delivery replaceable behind narrow application interfaces.
- Use one operationally simple process and one persistent data store for the initial household scale.
- Preserve a path from generic MCP operations to specialized native tools without changing chat/session architecture.

**Non-Goals:**

- Expose a coding agent, shell, arbitrary filesystem access, or unrestricted HTTP client.
- Support arbitrary Telegram users, dynamic self-registration, or Telegram-based administration.
- Control locks, alarms, garage doors, or other security-critical infrastructure.
- Let the model create executable skills, modify authorization policy, or access raw credentials.
- Implement general workflow orchestration, multiple active replicas, or a distributed message broker.
- Make Home Assistant or this service the source of truth for personal calendar data.

## Decisions

### 1. Build a TypeScript modular monolith

The application will ship as one Node.js container with internal modules for configuration, Telegram transport, admission policy, session coordination, Pi runtime integration, skills, MCP clients, persistence, calendar synchronization, scheduling, delivery, auditing, and health.

```text
Telegram long poll --> admission --> durable inbox --> per-chat coordinator
                                                        |
                                                        v
                                                headless Pi session
                                                        |
                                           policy --> tools/MCP

Home Assistant calendar --> synchronization --> reminder scheduler
                                                   |
                                                   v
                                             Telegram outbox

All durable application flows ------------------> SQLite
```

This is preferred over microservices because the expected concurrency and availability requirements do not justify a broker, distributed transactions, or independent scaling. Module boundaries and durable job records preserve a later extraction path.

### 2. Embed the Pi coding-agent SDK headlessly

Use `@earendil-works/pi-coding-agent` programmatically to create `AgentSession` instances, configure the model runtime, load skills, compact context, register custom tools, and consume agent events. Instantiate sessions with all built-in coding tools disabled and only explicitly selected application/MCP tools supplied.

The application will use an in-memory Pi `SessionManager` hydrated with session entries read from SQLite. Finalized Pi entries and compaction state will be persisted back to SQLite at controlled turn boundaries. This preserves SQLite as the application source of truth while using the SDK's agent lifecycle. A small Pi adapter will isolate SDK-specific entry conversion and version changes.

Alternatives considered:

- Raw `pi-agent-core`: smaller dependency surface, but would require recreating model/auth management, skills, compaction, and session behavior already available in the SDK.
- Pi's default JSONL sessions plus SQLite application state: easiest SDK path, but introduces two durable stores, duplicate backup semantics, and weaker transaction boundaries between Telegram work and session state.
- Pi RPC mode: adds subprocess supervision and loses direct typed access to agent events and custom tools.

### 3. Admit and durably claim Telegram updates before agent work

Use Telegram long polling with only required update types enabled. The adapter normalizes identifiers as decimal strings and applies checks in this order:

1. Ignore bot-authored and edited updates.
2. Require both chat and sender allowlist membership.
3. For groups, require a Telegram mention entity targeting this bot, a reply to this bot, or a supported command.
4. Insert the update into the durable inbox with a unique Telegram update identifier.
5. Dispatch it to the queue keyed by chat identifier.

Unauthorized or untriggered message content never crosses the admission boundary and is not stored. Each chat queue is serialized; separate chats may execute concurrently. An update marked as claimed or complete is never automatically replayed through the agent, which favors avoiding duplicate physical actions over transparently retrying an ambiguous interrupted turn.

Long polling is preferred over webhooks because it requires no public ingress and the deployment is intentionally single-instance. Webhooks remain a future transport option behind the Telegram adapter.

### 4. Use SQLite for application state and an outbox pattern

Use the runtime-provided SQLite implementation in WAL mode, with migrations applied before Telegram consumption begins. The logical data model includes:

- `chats`: Telegram chat identity, type, active Pi session ID, and timestamps.
- `telegram_updates`: deduplication identity, normalized accepted input, processing state, and failure metadata.
- `session_entries`: ordered Pi-native conversation and compaction entries per session.
- `tool_executions`: tool identity, redacted arguments, status, timing, and bounded outcome metadata.
- `outbox_messages`: destination, reply reference, ordered content chunks, attempt state, and Telegram result identifiers.
- `calendar_events`: minimal normalized event data and source revision information.
- `reminder_rules`: operator-configured matching and delivery behavior.
- `reminder_occurrences`: calculated schedule, deduplication identity, status, and outbox association.

An accepted update, its processing transition, resulting session entries, and outgoing response intent are committed at explicit boundaries. Telegram sending occurs from the outbox and records success separately, allowing retries without rerunning the agent. Exact once-only side effects cannot be guaranteed across an external MCP call and a process crash; the durable `started` tool record and no-replay rule minimize duplicate actions and make ambiguous outcomes visible.

The prompt builder sends current system instructions, skill catalogue, relevant memory, the latest compacted summary, and a bounded recent tail. SQLite retention is independent from model context selection, so old accepted records can remain locally without being repeatedly sent to the provider.

### 5. Treat skills as instructions and tools as authority

Configure Pi's resource loader with operator-managed, read-only skill locations. Skills are discovered at startup or explicit reload and validated before becoming visible. Automatic skill creation or installation by the model is disabled.

Executable authority comes only from the tool registry. Every tool is registered with a unique name, schema, timeout, result limit, audit policy, and source identity. The application-level allowlist is applied after all native and MCP tools are collected and before sessions are created. Prompt instructions cannot override this registry.

### 6. Adapt MCP tools through a managed client registry

Represent each MCP server with a stable configuration identifier, Streamable HTTP URL, secret reference, tool allowlist, timeouts, and result limits. One managed client per configured server performs connection lifecycle and tool discovery. Discovered names are exposed as namespaced Pi tools such as `home_assistant__get_state`.

The Home Assistant token is read from a mounted secret and attached only at the MCP transport boundary. It is never inserted into prompts, tool parameters, SQLite, health output, or logs. Redirect behavior must not forward credentials to an unconfigured origin.

Tool discovery is fail-closed: an unknown or renamed tool is reported diagnostically but remains unavailable. Calls are schema-validated, cancellable where supported, timed out, size-bounded, and audited. MCP unavailability degrades only dependent operations. Later native tools may coexist under stable application names; the corresponding broad MCP operation can then be removed from the allowlist.

### 7. Separate deterministic reminders from agent conversations

Define a `CalendarSource` boundary that returns normalized events for a requested time window. The first planned adapter reads configured Home Assistant calendar entities using a separate read-only Home Assistant API credential; it does not assume that the MCP server token grants native Home Assistant API access.

Synchronization runs at startup and periodically over a rolling horizon. Reconciliation uses source identity, event identity or a deterministic fallback fingerprint, occurrence time, and revision data to update or cancel unsent reminders. Reminder rules match normalized event fields and produce durable occurrences in the household IANA timezone.

The scheduler leases due occurrences and creates Telegram outbox messages directly. It does not create a Pi session or send calendar data to an LLM. Home Assistant calendar configuration, the Google Calendar connection, exact entity IDs, polling interval, and reminder patterns remain deployment configuration.

Using Home Assistant as the aggregation boundary is preferred over direct Google OAuth because it avoids another credential lifecycle and allows other Home Assistant calendar integrations to use the same adapter. Calling a calendar MCP tool on a timer was rejected because deterministic background synchronization should not depend on model-oriented tool discovery.

### 8. Keep configuration, secrets, and mutable state separate

Use validated startup configuration for immutable or operator-controlled settings: allowlisted decimal-string user/chat IDs, model selection, MCP server definitions, tool allowlists, skill directories, calendar entities, reminder rules, household timezone, and operational limits.

Secret configuration accepts file references so Kubernetes Secrets, systemd credentials, or protected VM-mounted files can be used without copying values into the main configuration. SQLite and any generated runtime files live under one configurable persistent data directory. Invalid admission or tool-policy configuration prevents polling; unavailable optional services produce degraded health.

### 9. Use final-response delivery with durable chunking initially

The Telegram adapter will enqueue a completed assistant response rather than continuously editing a streaming preview. It preserves the triggering message as a reply reference and splits oversized output at safe textual boundaries into ordered outbox records.

Final-only delivery is preferred initially because it is simpler to retry and avoids Telegram edit-rate behavior. Pi events remain available internally, so edit-in-place streaming can be added later without changing conversation or tool execution.

### 10. Operate one non-root instance with explicit lifecycle states

The container runs as a non-root user, mounts one writable data volume and read-only configuration/secret/skill locations, and receives only necessary outbound network access. k3s uses a one-replica replacement strategy that prevents overlapping long pollers; VM deployment uses the same image under a service manager.

Liveness indicates that the process and event loop operate. Readiness requires valid core configuration, SQLite, and Telegram initialization. Optional integrations have independent healthy/degraded status. Shutdown first stops polling and scheduler leases, then drains or cancels bounded work, closes Pi/MCP/Telegram resources, checkpoints state, and exits within the platform grace period.

## Risks / Trade-offs

- **Pi SDK APIs and session entry formats may evolve** -> Pin exact Pi package versions, isolate them behind an adapter, and maintain restore/compaction contract tests before upgrades.
- **A broad Home Assistant MCP tool may permit more arguments than intended** -> Enable tools individually, review discovered schemas, keep audit records, and replace commonly used broad operations with constrained native tools as usage becomes clear.
- **An external side effect and local commit cannot be atomic** -> Mark work and tool calls durably before execution, never replay ambiguous updates automatically, and report indeterminate outcomes instead of claiming success.
- **Prompt injection can arrive through chat or tool results** -> Keep admission and tool authorization outside prompts, bound tool results, disable generic shell/filesystem/HTTP tools, and treat external content as untrusted data.
- **SQLite and one replica limit horizontal scaling** -> Accept this for household load; preserve queues and adapters so a later database/broker migration does not change capability behavior.
- **Calendar synchronization may miss a last-minute change during an outage** -> Cache future occurrences, refresh periodically and at startup, expose source health, and use a misfire grace policy.
- **Persisted family conversations carry privacy risk** -> Store only triggered content, isolate sessions by chat, redact credentials, protect and back up the data volume, and keep model context bounded.
- **Final-only Telegram responses feel less interactive** -> Prefer reliable delivery initially and retain Pi event plumbing for a later streamed-preview enhancement.

## Migration Plan

1. Build and test the service with an isolated Telegram test bot, temporary SQLite database, in-memory/fake MCP server, and fake calendar source.
2. Configure the real Telegram bot, allowlisted user/chat IDs, model credential, Home Assistant MCP URL/token, and an explicit initial tool allowlist in a staging deployment.
3. Verify private-chat and group trigger behavior, restart recovery, context isolation, MCP failure handling, and outbox deduplication before enabling household use.
4. Deploy the same pinned container image to either the selected VM or a single-replica k3s workload with persistent storage, backups, and restricted secrets/network policy.
5. Add the Home Assistant calendar credential, calendar entity, and reminder rules only after the core chat/MCP path is stable.

Rollback uses the previously pinned image and compatible configuration. Database migrations must be forward-safe and backed up before deployment; migrations that cannot be read by the previous image require a documented restore-from-backup rollback rather than an in-place downgrade.

## Open Questions

- Which model provider, model, and thinking level will be the initial deployment default?
- Which Home Assistant MCP tools will be included in the first reviewed allowlist?
- Which VM or k3s target will host the first production deployment?
- What Home Assistant calendar entity, event matching patterns, reminder offsets, and household timezone will be configured when reminders are enabled?
- Which shopping-list service will be integrated first, and will it arrive through MCP or a later native tool?
