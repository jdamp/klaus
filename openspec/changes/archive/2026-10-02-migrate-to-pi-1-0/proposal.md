## Why

Klaus is pinned to Pi 0.85.1 and maintains its own MCP connection, discovery, and tool-registration pipeline. Pi 1.0 supplies these facilities and on-demand tool discovery, so upgrading can reduce duplicated integration code and the model context spent declaring large MCP catalogues while preserving Klaus's household safety and delivery contracts.

## What Changes

- Upgrade the Pi coding-agent, agent-core, and AI packages together to the 1.0 release and adapt Klaus's SDK integration, authentication, session restoration, model selection, and headless runtime to their supported APIs.
- Use Pi's MCP extension and deferred `tool_search` for configured MCP servers, with an explicit direct-exposure option for small catalogues. Retain the current omitted/all, explicit-list, and empty/none tool policies, mounted-secret handling, execution bounds, redacted audits, and optional-server health isolation.
- Replace Klaus's private `_runDefaultCompaction` patch with Pi's public compaction hook while preserving speaker-attribution guidance for manual, threshold, and overflow compaction.
- **BREAKING:** MCP tool names in new model calls will use Pi's `mcp__<server>__<tool>` namespace instead of Klaus's `<server>__<tool>` names. Existing transcript entries remain readable; rollout guidance and tests will cover resumed sessions and name references.
- Update the minimum supported Node version to Pi 1.0's requirement and revise deployment configuration, examples, and operator documentation.

Pi Durable remains outside this change. Klaus will keep its current session storage, Telegram update handling, shared memory, and delivery outbox while the separate Durable framework matures.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `agent-capability-extensions`: Configured MCP tools become discoverable on demand by default, with operator-selected direct exposure, while existing server and per-tool authorization stays effective.

## Impact

- Pi dependencies and lockfile; Node runtime requirement and container image.
- Agent session factory and compaction integration; MCP configuration, registration, health, audit, and capability composition.
- MCP, session, configuration, deployment, and regression tests; README, example configuration, and k3s rollout guidance.
- No Pi Durable storage migration or change to Telegram's external-action replay policy is part of this proposal.
