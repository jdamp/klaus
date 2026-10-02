## 1. Pi 1.0 compatibility

- [x] 1.1 Pin the compatible Pi coding-agent, agent-core, and AI 1.0 packages and raise Klaus's Node floor to >=22.19; verify `npm ci`, the lockfile, and the pinned Docker image satisfy the requirement.
- [x] 1.2 Adapt model runtime, authentication bootstrap, session creation, command handling, and native-tool types to Pi 1.0; verify `npm run typecheck` and focused agent, model, command, and auth tests pass.
- [x] 1.3 Add a fixture made from 0.85-era stored session entries and restore it under Pi 1.0 without executing old tool calls; verify text/image history, model and thinking preferences, and a subsequent new turn survive restart or cache eviction.
- [x] 1.4 Adapt the existing Codex image generator to Pi 1.0's credential/runtime behavior without changing its backend or delivery path; verify image-generation, photo-outbox, and authentication regression tests pass.

## 2. Trusted SDK integration and compaction

- [x] 2.1 Configure an isolated SDK resource root and explicitly load only Klaus's trusted inline factories plus Pi MCP and `tool_search`; bind session extensions before turns and verify unconfigured user/project `mcp.json` servers never appear.
- [x] 2.2 Replace the fixed session tool selection so deferred MCP tools can activate while native Klaus tools remain available; verify shell, filesystem mutation, generic network, coding tools, `codemode`, and MCP resource helpers are absent and uncallable.
- [x] 2.3 Replace the `_runDefaultCompaction` patch with a `session_before_compact` handler using Pi's public summary path and merged attribution/manual guidance; verify multi-sender manual, threshold, split-turn, and overflow compaction retain attribution and a summary failure does not silently use unguided compaction.

## 3. MCP configuration and discovery

- [x] 3.1 Add optional per-server `exposure` configuration with `deferred` default and `direct` alternative while preserving omitted/all, explicit-list, and empty/none `tools` semantics; verify config and public-config tests cover every combination and reject invalid exposure values.
- [x] 3.2 Register only operator-configured HTTP and stdio MCP servers through Pi using mounted token/secret-environment files in memory; verify controlled fixtures receive the credentials while neither configs, sessions, logs, nor command arguments retain them.
- [x] 3.3 Map each server's restriction to Pi's hidden/exact-tool exposure policy and a call-time gate; verify deferred search, direct declarations, discovery after reconnect/session recreation, new tools on unrestricted servers, and excluded Kaneo tools with fixture servers.
- [x] 3.4 Verify Pi's namespace normalization and historical tool-name compatibility on restored sessions; document the `mcp__<server>__<tool>` name change and confirm no historical action is replayed.

## 4. MCP operational parity

- [x] 4.1 Add bounded cancellation/timeout and redacted start/finish audit handling around Pi MCP calls; verify success, MCP `isError`, transport failure, cancellation, and timeout outcomes against HTTP and stdio fixtures.
- [x] 4.2 Preserve supported text and image MCP results while enforcing configured result byte limits and redacting textual and structured fields; verify oversized and secret-bearing results leave no unredacted model context, audit row, log, health detail, or retained temporary file, using a pre-storage wrapper if Pi's built-in path cannot meet this check.
- [x] 4.3 Implement bounded startup health probes and ongoing optional-server health tracking, and close session-owned MCP connections on disposal; verify an offline server degrades only itself, healthy tools still work, and multi-chat stdio process count stays within the measured session bound.
- [x] 4.4 Remove the superseded custom MCP transport/discovery/tool-call path and unused direct dependencies after parity is proven; verify production dependency inspection and `rg` show no stale imports while MCP integration tests still pass.

## 5. Release verification and operator guidance

- [x] 5.1 Update README, local/container examples, and k3s rollout guidance for Pi 1.0, deferred/direct exposure, tool names, secret mounting, session backup, and rollback; verify examples parse and deployment tests pass.
- [x] 5.2 Compare initial tool declaration count and estimated token use for deferred and direct fixture catalogues, plus first-use discovery latency; record the measurements without claiming a Klaus-wide saving that was not measured.
- [x] 5.3 Run `npm run check`, production container build/smoke checks, and `openspec validate migrate-to-pi-1-0 --strict`; verify all pass and review the diff for unrelated changes or credential data.
- [x] 5.4 Pin npm 12.2.0 for Pi 1.0 installs, override vulnerable transitive `brace-expansion`, `fast-uri`, and `ip-address` versions, and verify clean installs and production audits report no vulnerabilities.
- [x] 5.5 Deploy the Pi 1.0 image as the single Klaus replica and complete live smoke checks; the operator confirmed on 2026-10-02 that live checks worked well. Track durable image hosting separately.
