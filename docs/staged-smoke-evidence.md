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
SQLite tool audits, and persisted sessions. The live native catalogue exposed eight recipe/organizer tools and no deletion, upload,
shopping-list, meal-planning, or generic HTTP tool.

A second staged run (2026-09-29 UTC) imported one disposable recipe through the scraper path
with 12 usable ingredients and six instructions. OpenAI reparsing initially returned a partial
outcome (Mealie HTTP 500); a read-back confirmed the recipe remained intact. One separate
AI/imported attempt on the other operator-approved recipe succeeded with 11 usable ingredients
and two instructions. Both public recipe pages returned HTTP 200.

The Mealie traceback identified an id-less parsed food at recipe update. A non-mutating parser
check produced 12 parsed lines; four distinct food records and two unit records lacked catalogue
IDs. After explicit operator approval, updated code was staged in the running pod's ephemeral
memory filesystem for **one** audited, opt-in existing-recipe reparse, without changing the running
image or bot process. It succeeded: a fresh API read returned 12 usable ingredients, 12 structured
food IDs, five unit IDs, and six instructions. Audit-result comparisons confirmed that ingredient
count, reference-ID order, section titles, and instruction count were preserved; the public page
returned HTTP 200. The staged code was removed afterward. On the operator's follow-up request,
a clean build from `a90b912` was deployed as the digest-pinned, **24-hour temporary image**
`ttl.sh/klaus-mealie-optin-a90b912-20260929205331:24h@sha256:b596319016082e079596b5f6bda517ec4b78cf3d9677860744dd72feaf9c474e`.
Klaus readiness and Mealie capability health were both healthy, both import and reparse tools
exposed the opt-in flag, and a structured-food filter found the saved recipe. This is not a
durable registry publication. On 2026-10-03 it was replaced by the public, digest-pinned GHCR
image documented in `docs/releases/2026-10-03-ghcr-cutover.md`; one replica was ready with healthy
Mealie capabilities. The AI/OpenAI import combination, Telegram delivery, ambiguous-filter checks,
organizer mutations, and outage recovery remain outstanding.

Follow-up acceptance (2026-10-03 UTC): the accepted GHCR rollout reported one ready Klaus replica
and healthy Mealie capabilities. Two uniquely named disposable organizers (one category and one
tag) were created, listed, and renamed with read-back. The first assignment through the deployed
tool partially applied the tag but ignored the category; an independent read-back showed the
recipe still had 12 ingredients and six instructions. The cause was the wrong recipe update field
(`categories` instead of Mealie's `recipeCategory`).

Updated code passed the full test suite (143 tests) and was staged **only** for audited one-off
tool calls. A single corrected assignment applied both organizers; explicit clearing of each type
preserved the omitted type, all ingredient references, and recipe instructions. Both organizer
assignments were restored to their original empty state; the non-destructive disposable organizer
records remain. Text, exact category, tag, and food searches returned bounded pages with public
links; a missing filter was rejected. Regression tests reject ambiguous food/category names
before recipe search. The staged fix was removed: the running GHCR image **still contains the
category assignment bug** until a new image is reviewed and deployed.

When Mealie is enabled, record only privacy-safe pass/fail evidence here. Do not commit recipe names,
source URLs, ingredient text, organizer names, household identifiers, Telegram content, API keys, or
full tool results.

- [x] Mealie reports a supported 3.23+ version and the API key is absent from current-pod logs,
      health output, SQLite audits, session entries, and public configuration.
- [ ] Scraper/imported, scraper/OpenAI, AI/imported, and AI/OpenAI disposable imports complete or
      report the documented partial/indeterminate outcome.
- [x] Existing-recipe OpenAI reparsing preserves ordering, section references, and verification
      (one opt-in, audited live run with the updated code staged outside the running image).
- [x] Text, category, tag, and ingredient searches resolve exact filters and reject ambiguity
      (live positive and missing-filter checks; deterministic ambiguous-name preflight tests).
- [ ] Category/tag list, create, rename, assignment, replacement, and explicit clear succeed;
      deletion and out-of-scope tools are absent. The corrected path passed staged live checks,
      but the running image has not been updated with the category-assignment fix.
- [ ] A temporary Mealie outage degrades only Mealie and recovery works without restarting Klaus.
