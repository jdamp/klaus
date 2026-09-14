# Staged smoke-test evidence

This file records privacy-safe acceptance evidence. It intentionally omits Telegram identifiers,
message bodies, entity state, credentials, and MCP results.

## Local staging run — 2026-09-14 UTC

- Runtime: local process in the development pod
- Source revision: `a8f97b1`
- Image digest: not applicable to this local run
- Configuration: local staging configuration, not committed
- Testers: household operator and Codex
- Model: `openai-codex/gpt-5.6-luna`, medium reasoning
- MCP endpoint: dedicated in-cluster `ha-mcp` container over Streamable HTTP

### Completed checks

- Core readiness reported healthy with one Telegram poller.
- Adult A received exactly one direct-chat response.
- Adults A and B each invoked the bot in the family group using an entity-backed mention and
  received one response in that group.
- A reply to a bot-authored group message invoked the bot once.
- The supported new-session command changed only the family-group session.
- Ambient group text was ignored and absent from accepted-update and outbox counts.
- With both adults temporarily absent from the sender allowlist, their group invocations received
  no response and did not change accepted-update or outbox counts. The normal allowlist was then
  restored and readiness reconfirmed.
- The real MCP endpoint advertised 78 tools. The application exposed only the reviewed
  `ha_get_state`, `ha_get_todo`, and `ha_set_todo_item` tools under the `home` namespace.
- The discovered but unlisted `ha_restart` tool was absent from the application registry.
- A Telegram-requested `ha_get_todo` call completed successfully and produced a bounded result;
  its response was delivered once.
- A Telegram-requested `ha_set_todo_item` call completed successfully; its response was delivered
  once and the household operator independently observed the new item in Home Assistant.

### Remaining checks before task 9.4 completion

- Verify an allowlisted adult is ignored in a temporarily non-allowlisted chat.
- Verify a simulated MCP outage reports degraded capability health while unrelated Telegram chat
  remains operational.
- Complete the live credential scan and correct local Telegram secret-file permissions.
- Decide whether to repeat the already automated interruption/recovery cases against the live bot.

Adult B's private-chat check was not exercised; the household operator accepted successful group
authorization as sufficient for this local staging run.
