## Context

See proposal.md for motivation and `specs/agent-capability-extensions/spec.md` for the new discovery contract. Klaus currently pins Pi 0.85.1, constructs one shared `McpRegistry` with the MCP SDK, and passes its discovered tools into a per-chat Pi SDK session as a fixed list. The session factory disables built-in tools and filesystem extensions, stores Pi entries in Klaus SQLite, and decorates the private `_runDefaultCompaction` method. MCP credentials come from mounted files. The Kaneo stdio configuration uses an explicit allowlist; Home Assistant normally exposes its configured server catalogue. Native Mealie, memory, and image tools have separate application providers.

Pi 1.0's SDK requires explicit loading of its MCP and `tool_search` extensions, then `session.bindExtensions()` to start them. Its MCP tool names use `mcp__<server>__<tool>`, and its default exposure is `codemode`, so Klaus must set its own exposure policy. Pi 1.0 requires Node 22.19 or later; the pinned container image currently uses Node 22.23.0. See the [Pi SDK example](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/sdk/14-codemode-mcp.ts), [MCP documentation](https://pi.dev/docs/latest/mcp), and [package manifest](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/package.json).

## Goals / Non-Goals

**Goals:**

- Use Pi 1.0's supported SDK and MCP facilities while retaining Klaus as the authority for enabled servers, secrets, audit policy, result bounds, and health.
- Keep the model's initial tool declarations small without weakening Kaneo's allowlist or enabling coding, shell, filesystem, generic network, or MCP resource helper tools.
- Preserve existing sessions, shared-memory attribution, images, cancellation, and Telegram delivery during the upgrade.

**Non-Goals:**

- Adopt Pi Durable, change Telegram update replay or outbox semantics, or move shared memory into Pi storage.
- Replace Klaus's Codex subscription image-generation endpoint with Pi's currently documented OpenRouter image-model path.
- Add interactive MCP OAuth configuration or permit project/user `mcp.json` discovery in the headless service.

## Decisions

### 1. Pin a coherent Pi 1.0 set and keep the existing storage boundary

Pin `@earendil-works/pi-coding-agent`, `pi-agent-core`, and `pi-ai` to compatible 1.0 releases in the lockfile; declare Node >=22.19 and validate the pinned container image. Adapt changed Pi APIs in `PiSessionFactory`, model/auth bootstrap, command handling, and the Codex image generator. Continue to load and persist Klaus's existing Pi session entries through `SessionEntryRepository`, and leave the Telegram and memory tables untouched. Test a real 0.85-format stored-session fixture before choosing any entry transformation; if conversion is needed, make it deterministic, backed up, and free of tool execution.

This confines the upgrade to the existing service architecture. Moving to Durable would replace the conversation harness and requires a separate external-action replay and data migration design.

### 2. Load only trusted Pi extensions through the SDK

Build the SDK resource loader with explicit trusted factories for Klaus memory context, Pi MCP, Pi `tool_search`, and the Klaus policy/audit hooks. Use an isolated resource root so Pi does not silently read user or project `mcp.json` files; continue loading only configured skill paths. Call `session.bindExtensions()` before accepting a turn. Replace the fixed `tools: customTools.map(...)` selection with a configuration that allows Pi to activate discovered MCP tools while asserting that no built-in coding or generic tool is active. Keep native Klaus tools directly callable. Do not load `codemode` merely to use MCP: deferred servers can be reached through `tool_search` alone.

The alternative of only bumping package versions leaves MCP disabled in SDK sessions. Keeping the fixed `tools` list would prevent late MCP activation, as Pi's SDK example warns.

### 3. Translate Klaus's MCP policy to Pi registration and exposure

Treat `config.mcp` as the sole server catalogue. A trusted inline factory reads mounted HTTP bearer-token and stdio secret-environment files into in-memory server registrations; secret values are never written to `mcp.json`, model prompts, session entries, or command arguments. It registers servers through Pi's extension API. Preserve configured executable and argument vectors rather than using shell commands or runtime package downloads.

Add an optional per-server `exposure: deferred | direct` setting, defaulting to `deferred`. For omitted `tools`, apply that exposure to all discovered tools. For a non-empty list, register the server hidden and set exact named `toolExposure` overrides to the selected exposure. For `tools: []`, keep every tool hidden. Reapply this policy when a server reports changed tools or reconnects. Add a separate call-time allowlist check as defense against misregistration and ensure Pi's optional MCP resource helpers do not enter the model's active tool set. Verify namespace normalization and collision behavior for configured IDs before replacing stored tool names in documentation.

Keep old MCP names in historical session entries unchanged; they are transcript records, not executable requests. New tool calls use Pi's `mcp__<server>__<tool>` normalization, including its collision suffix behavior.

Direct exposure remains useful for a small, frequently used catalogue. `codemode` is excluded because Klaus needs simple tool discovery, not a script execution surface. Custom MCP transport/discovery code can then be removed after parity tests pass; the application retains a small configuration and policy adapter.

### 4. Retain Klaus's operational controls around Pi MCP calls

Translate `timeoutMs` to Pi's per-server timeout and preserve tighter cancellation when its setting cannot represent Klaus's value exactly. Use Pi's `tool_call` and `tool_result` pipeline to block unauthorized calls, start and finish redacted audits, distinguish success from MCP `isError`, and bound/redact text, images, and `structuredContent` before model context or retained records. Replace both `content` and `structuredContent` when redacting. Confirm Pi's large-result temporary-file behavior does not retain unredacted data; if its built-in executor writes raw content before hooks run, use a pre-storage MCP execution wrapper on Pi's MCP client and keep Pi's deferred tool exposure. Do not silently relax the secret or result-size contract to remove the old registry.

Keep optional-server health visible at startup with bounded Pi-MCP connection probes and thereafter with connection/call observations and periodic checks. Probes close immediately rather than holding duplicate long-lived stdio processes. Session-owned MCP connections are closed when their sessions are disposed. Test multi-chat process count and startup latency because Pi's session-scoped connections differ from Klaus's currently shared client.

The alternative of deleting `McpRegistry` without an adapter loses mounted-file credential handling, audit outcomes, result limits, and degraded-health behavior.

### 5. Replace the private compaction patch with a public hook

Register `session_before_compact` in Klaus's trusted extension. Merge Klaus's attribution guidance with any manual custom instructions and use Pi's exported compaction preparation and summarization helper through the supported hook to return a complete summary, kept-entry boundary, and usage. Preserve previous-summary and split-turn handling. If an attributed summary cannot be produced, surface the compaction failure instead of falling back to an unattributed default summary. Remove the `_runDefaultCompaction` monkey patch. Verify manual, threshold, and overflow paths using multi-sender fixtures.

Only adding attribution to the normal agent system prompt is insufficient: compaction runs its own summarization request. Pi's [compaction reference](https://pi.dev/docs/latest/compaction) documents the hook and the need to return a complete compaction result.

## Risks / Trade-offs

- **Pi 1.0 API and session-format differences** -> Compile against the pinned release and exercise restored 0.85 sessions, model/thinking preferences, image turns, and cancellation before rollout; retain a database backup for rollback.
- **A hidden tool or MCP resource helper becomes reachable through search or another tool** -> Assert both discovery and call-time policy, including `tools: []`, excluded Kaneo operations, and disabled built-ins.
- **Raw MCP results escape before Klaus's redaction hook** -> Test model context, audit rows, logs, health output, and temporary files with a known secret; switch to the pre-storage wrapper if necessary.
- **Deferred discovery adds a search step and Pi may start one stdio process per active chat** -> Measure first-use latency, prompt tokens, and process count with representative Home Assistant and Kaneo catalogues; allow explicit direct exposure where it performs better.
- **Old names remain in historical tool calls** -> Keep historical entries intact, document the new namespace, and test model continuation after restore and `/new` without replaying old actions.
- **Concurrent OpenSpec work modifies audit or memory behavior** -> Integrate with the current shared-memory and observability contracts at implementation time, preserving their existing source changes.

## Migration Plan

1. Upgrade and lock Pi packages, set the Node floor, and run typecheck/build in an isolated working branch. Fix SDK and session compatibility before changing MCP execution.
2. Add operator-only Pi MCP registration, deferred exposure, policy/audit/health adapters, and the public compaction hook. Keep representative HTTP and stdio fixtures for parity checks; remove the old MCP executor only after all contracts pass.
3. Back up the application database and Pi authentication directory. Validate restore of existing sessions and exclusion of old/disallowed MCP names in a staging image, then measure discovery and multi-chat behavior.
4. Deploy the immutable image as the existing single replica and verify health, authorized Home Assistant and Kaneo reads, a controlled allowed write, excluded writes, secret absence, and restart continuity. Keep the existing Kaneo rollout tasks separate; they are not automatically completed by this migration.
5. Roll back to the prior image and configuration using the pre-upgrade backup if session or authentication data was rewritten incompatibly. Do not run old and new consumers concurrently.
