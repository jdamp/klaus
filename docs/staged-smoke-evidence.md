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
- With the family group temporarily absent from the chat allowlist, an allowlisted adult's
  entity-backed group mention received no response and did not change accepted-update, outbox, or
  tool-execution counts. The normal allowlist was then restored and readiness reconfirmed.
- The real MCP endpoint advertised 78 tools. The application exposed only the reviewed
  `ha_get_state`, `ha_get_todo`, and `ha_set_todo_item` tools under the `home` namespace.
- The discovered but unlisted `ha_restart` tool was absent from the application registry.
- A Telegram-requested `ha_get_todo` call completed successfully and produced a bounded result;
  its response was delivered once.
- A Telegram-requested `ha_set_todo_item` call completed successfully; its response was delivered
  once and the household operator independently observed the new item in Home Assistant.
- With the MCP endpoint temporarily replaced by an unreachable local endpoint, readiness remained
  true, capability health reported degradation, and an unrelated direct-chat response was
  delivered exactly once without creating a tool execution. The real endpoint was then restored,
  one poller was running, and every health component returned to healthy.
- A value-based scan checked the live Telegram and Pi OAuth credentials without printing them.
  Neither credential appeared in SQLite, tracked files, serialized public configuration, or health
  output. The local secret and Pi-authentication directories were mode `0700`, and both credential
  files were mode `0600` under the runtime user.
- A watcher sent `SIGTERM` immediately after a new authorized direct-chat update entered the
  durable `claimed` state. Shutdown left the update `indeterminate`, created no tool execution,
  and retained one pending response. After restart, the update was not replayed, the pending
  response was delivered once with one attempt, and all integrations returned to healthy. The
  deterministic in-flight turn and delivery cases remain covered by the task 9.3 acceptance suite.

All staged checks required for this local household rollout passed. The live bot was restored with
its reviewed MCP endpoint and one healthy Telegram poller.

Adult B's private-chat check was not exercised; the household operator accepted successful group
authorization as sufficient for this local staging run.

## Kubernetes test deployment — 2026-09-15 UTC

- Namespace: `klaus`
- Source: current working tree based on `f0d15f8`
- Image: `ttl.sh/klaus-agent-3b228fd5792a4a258b21aa6de077eba1:24h`
  (`sha256:8d53f03a0ac3ffce5115fee49e33044f3c2ebdb5d0ca76ddb621aa82d1253633`;
  temporary test registry image)
- Configuration and credentials: operator-local configuration and Telegram token were created as
  namespace resources. Existing OAuth state was seeded into its persistent claim, then the temporary
  seed Secret was deleted; none of these values are committed or reproduced here.
- Storage: fresh `klaus-agent-data` (1Gi) and `klaus-agent-auth` (256Mi) claims, both bound using
  `nfs-nas`.

### Completed checks

- The Deployment rolled out one ready replica with the `Recreate` strategy.
- The non-root, read-only-root-filesystem container started with the configured `home` and Kaneo
  stdio MCP servers after the dedicated Kaneo Secret was mounted.
- The application logged `runtime.started` for the authenticated `openai-codex` provider with both
  MCP servers, and the Kubernetes readiness probe and capability health reported healthy.

No Telegram or MCP action smoke tests have been performed against this Kubernetes deployment yet.
The temporary image expires after 24 hours and must be replaced with a reviewed immutable registry
image before any continued use.

## Native Mealie evidence checklist

Local staged read-only verification (2026-09-29 UTC): Mealie 3.28.0 responded through its in-cluster
service; Klaus `/ready` returned 200 with healthy capabilities. The corrected image was deployed
from a **24-hour temporary registry**, not a durable image. A recipe-detail lookup produced a
browser-facing link using the configured public origin and group slug. The earlier AI import had
blank ingredient slots. After the operator deleted that recipe, a **single** scraper/imported call
created a replacement; a separate authenticated read confirmed 17 usable ingredients and seven
instructions, and its public recipe page returned HTTP 200. No AI parsing was requested.
Read-only follow-up: text, exact category, and exact tag searches returned bounded pages with
public links. A food-name filter initially failed because the integration used an obsolete URL;
the `/api/foods` fix was deployed and the same read-only filter returned the reference recipe.
The current pod's Mealie key was absent from its logs, public configuration, health response,
SQLite tool audits, and persisted sessions. The live native catalogue exposed eight recipe/organizer
tools and no deletion, upload, shopping-list, meal-planning, or generic HTTP tool. A second staged run (2026-09-29 UTC) imported one disposable recipe through the scraper path
with 12 usable ingredients and six instructions. OpenAI reparsing of that recipe returned a
partial outcome (Mealie HTTP 500); a read-back confirmed its 12 ingredients and instructions
remained intact, but no structured foods appeared. One separate AI/imported attempt on the other
operator-approved recipe succeeded with 11 usable ingredients and two instructions. Both public
recipe pages returned HTTP 200. The Mealie error traceback identified an id-less parsed food at recipe update. A separate
**non-mutating** OpenAI parser check produced 12 parsed lines; four distinct food records and two
unit records had no matching catalogue identity. No new catalogue entries or recipe updates were
made during that check. No parser-driven recipe update was retried, nor were the AI/OpenAI
combination or automatic duplicate imports attempted. Production image publication, Telegram
delivery, ambiguous-filter checks, organizer mutations, and outage recovery remain outstanding.

When Mealie is enabled, record only privacy-safe pass/fail evidence here. Do not commit recipe names,
source URLs, ingredient text, organizer names, household identifiers, Telegram content, API keys, or
full tool results.

- [x] Mealie reports a supported 3.23+ version and the API key is absent from current-pod logs,
      health output, SQLite audits, session entries, and public configuration.
- [ ] Scraper/imported, scraper/OpenAI, AI/imported, and AI/OpenAI disposable imports complete or
      report the documented partial/indeterminate outcome.
- [ ] Existing-recipe OpenAI reparsing preserves ordering, section references, and verification.
- [ ] Text, category, tag, and ingredient searches resolve exact filters and reject ambiguity.
- [ ] Category/tag list, create, rename, assignment, replacement, and explicit clear succeed;
      deletion and out-of-scope tools are absent.
- [ ] A temporary Mealie outage degrades only Mealie and recovery works without restarting Klaus.
