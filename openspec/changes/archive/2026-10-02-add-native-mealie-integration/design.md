# Design

## Context

See `proposal.md` for motivation and `specs/mealie-recipe-management/spec.md` for the behavior contract.

Klaus currently builds model tools directly from `McpRegistry` and passes that registry into `SessionComponent`. The MCP registry combines transport lifecycle, discovery, validation, execution bounds, auditing, and Pi tool construction. Pi already accepts application-defined `ToolDefinition` objects, but the application has no transport-neutral provider catalogue or native external-service client.

Application components start capabilities before sessions, optional capability degradation does not affect readiness, secrets are loaded from files and registered with a central redactor, and tool calls are audited in SQLite. Agent sessions snapshot their custom tool definitions when created. The in-flight shared-memory change also intends to add application-owned tools, so a reusable per-session tool binding boundary avoids two features introducing competing session wiring.

Mealie 3.23 and newer expose two relevant streaming URL imports: the scraper-backed `/api/recipes/create/url/stream` endpoint and unified AI `/api/recipes/create/ai/stream` endpoint. The unified AI workflow extracts complete ingredient lines but does not run `/api/parser/ingredients`; structured OpenAI ingredient normalization therefore remains a separate post-creation operation.

## Goals / Non-Goals

**Goals:**

- Compose MCP, Mealie, memory, and future native tool providers without coupling sessions to a particular transport.
- Keep generic execution policy separate from Mealie endpoint and recipe-domain behavior.
- Represent URL source selection and ingredient normalization as independent choices.
- Preserve accurate outcomes across a multi-stage, externally mutating import.
- Keep Mealie credentials, request destinations, execution time, response volume, and model authority bounded.
- Make Mealie recovery possible without recreating every session merely because the service was offline during startup.

**Non-Goals:**

- Expose a generic HTTP client or arbitrary Mealie endpoint tool to the model.
- Generate a client from Mealie's complete OpenAPI document or introduce a third-party Mealie SDK.
- Support pre-3.23 Mealie APIs or dynamically branch on legacy versions.
- Add shopping lists, meal planning, organizer deletion, recipe deletion, uploads, or general recipe editing.
- Make AI imports transactional across Mealie API calls; Mealie does not expose a transaction spanning import and later ingredient replacement.
- Redesign MCP discovery or change existing MCP exposure policy.

## Decisions

### 1. Introduce a transport-neutral provider catalogue with per-session tool binding

Define a small application-owned provider contract with a stable provider id, lifecycle and health operations, and a tool factory invoked when an agent session is created. The tool factory receives a session binding context rather than returning one global immutable array. Mealie can ignore session-specific state, while memory and future participant-aware domains can bind trusted per-session context without another `PiSessionFactory` constructor change.

A catalogue owns the configured providers, starts them before sessions, stops them afterward, gathers their health, creates each session's combined tool list, and rejects duplicate public tool names before a session starts. Adapt the existing MCP registry behind this contract rather than folding native tools into MCP. `SessionComponent` and `PiSessionFactory` depend on the catalogue, not `McpRegistry`.

Configured Mealie tool definitions remain present while its remote health is degraded. Calls consult the provider state and can recover when Mealie returns; a session created during an outage therefore does not permanently lose the capability. Unsupported versions produce an incompatible outcome locally until a successful health refresh detects an upgraded instance.

Alternatives considered:

- Passing another static tool array beside `McpRegistry` preserves the current coupling and repeats for every future domain.
- Converting Mealie into an in-process MCP server adds protocol and discovery overhead without isolation or reuse benefits.
- One global static catalogue cannot support the trusted per-session bindings needed by planned native memory tools.

### 2. Share execution policy, not service semantics

Add a native-tool execution envelope responsible for local schema validation, combined caller/deadline cancellation, result-size enforcement, secret redaction, and `ToolAuditRepository` transitions. It receives a provider id, operation name, bounded/redacted arguments, execution profile, and domain callback. Ordinary requests use the configured request deadline; streaming imports use a separately configurable longer deadline.

The audit API uses provider terminology in TypeScript while retaining the existing SQLite `server_id` column for migration compatibility. Extend tool outcomes to represent partial completion where a remote mutation succeeded before a later stage failed; retain `indeterminate` for interrupted creation streams whose server-side outcome is unknown. A partial import resolves to a structured tool result so the model receives the known slug and failed stage, while the audit records a partial outcome. No audit record stores the bearer credential or unbounded remote content.

MCP continues to enforce its existing discovered-schema and transport behavior. Common execution code should be adopted only where doing so preserves MCP semantics; the change does not force MCP through a lowest-common-denominator HTTP abstraction.

Alternatives considered:

- Reusing `McpRegistry.call` for native operations misrepresents native tools as discovered remote MCP tools.
- A generic model-visible HTTP tool would violate the configured authority boundary.
- Throwing every post-creation failure would hide the slug of a recipe that now exists.

### 3. Build a narrow authenticated Mealie client on platform APIs

Use Node's `fetch`, `FormData`, and stream APIs behind a private `MealieClient`. The client accepts only an operator-validated base URL and fixed endpoint methods. Configuration is optional and has this shape conceptually:

```yaml
mealie:
  baseUrl: https://mealie.example.invalid
  apiKeyFile: /run/secrets/mealie/api-key
  requestTimeoutMs: 30000
  importTimeoutMs: 180000
  maxResponseBytes: 1048576
  maxResultBytes: 65536
```

Validate HTTP(S), prohibit URL credentials, query strings, and fragments, and normalize one trailing slash. Requests construct paths from constants, reject redirects so authorization cannot be forwarded to another origin, and send the mounted API key only as a bearer header. Incremental JSON and SSE reads enforce the raw response bound before parsing. Domain services project full Mealie responses into purpose-specific results before applying the smaller model-result bound.

An unreadable or empty configured key is operator misconfiguration and prevents startup, consistent with other required mounted secrets. Remote connection, authentication, AI-provider, and version failures degrade only Mealie. Startup and periodic/on-demand health checks use `/api/app/about`, require version 3.23.0 or newer, and retain redacted bounded diagnostics. Tool calls may trigger a bounded health refresh so an upgraded or recovered service becomes usable without restarting Klaus.

Alternatives considered:

- Generating the entire OpenAPI client creates a large surface whose version churn and unused models exceed the bounded feature set.
- Following redirects risks forwarding the bearer credential outside the reviewed origin.
- Treating an absent configured secret as an optional outage hides a deployment error that cannot self-heal.

### 4. Separate Mealie transport, provider, and tool domains

Organize the integration into a shared client/provider layer and domain modules. The recipe domain owns search, retrieval, import orchestration, and ingredient parsing. The organizer domain owns category/tag lookup and non-destructive mutations. Each domain exports Pi definitions to the Mealie provider; it cannot access arbitrary URLs except through fixed client methods.

The initial public native catalogue is:

- `mealie_search_recipes`
- `mealie_get_recipe`
- `mealie_import_recipe_url`
- `mealie_reparse_recipe_ingredients`
- `mealie_list_organizers`
- `mealie_create_organizer`
- `mealie_rename_organizer`
- `mealie_set_recipe_organizers`

Organizer tools use `kind: "category" | "tag"` to share identical behavior without duplicating tool definitions. There is deliberately no generic mutation action and no delete action. Future Mealie shopping or meal-planning work can add sibling domains; unrelated external services can add providers without changing session construction.

Alternatives considered:

- One tool per CRUD verb per organizer type increases catalogue size without adding semantic clarity.
- A single `manage_mealie` tool with an arbitrary action union makes destructive authority harder to inspect and validate.
- Putting endpoint calls directly in tool executors makes multi-stage workflow tests and future non-agent callers difficult.

### 5. Model URL import as a staged workflow with explicit strategy axes

`mealie_import_recipe_url` requires an HTTP(S) URL plus explicit `sourceStrategy` (`scraper` or `ai`) and `ingredientStrategy` (`imported` or `openai`). Requiring both values makes cost and behavior visible instead of relying on a hidden default. Scraper-specific include-tag/include-category options and AI-specific translation options are validated against the selected strategy. The AI request always sends `createNewOrganizers=false`; otherwise Mealie can also create recipe tools and uncontrolled near-duplicate organizers outside this domain.

The source stage uses the corresponding streaming endpoint and parses bounded `progress`, `done`, and `error` SSE events. Progress is diagnostic only; the Pi tool returns after a terminal event. A `done` slug is followed by a recipe read. With `imported`, that read is projected and returned. With `openai`, the workflow continues through the shared ingredient-normalization service and then performs a final verification read.

Creation requests are never automatically retried. A definitive server error before a slug is a failure. Stream closure, cancellation, or timeout before a terminal event is indeterminate because Mealie may have committed. Once a slug is known, a later failure is partial and returns the slug and stage. The integration does not delete a partially imported recipe because the recipe may be useful and deletion is outside its authority.

Alternatives considered:

- Separate scraper and AI tools duplicate the same mutation/outcome contract and make future source strategies expand the catalogue.
- Automatically falling back from scraper to AI can create duplicates if the first stream committed but its terminal event was lost, and it hides AI usage.
- Treating the unified AI import as structured ingredient parsing is inaccurate: current Mealie converts extracted ingredient lines into recipe notes before persistence.

### 6. Normalize ingredients through one preservation-aware service

For a newly imported or existing recipe, derive one parser input per ingredient from `originalText`, then `display`, then `note`. Reject normalization before mutation if any ingredient lacks usable source text. Submit the complete ordered list to `/api/parser/ingredients` with `parser: "openai"` and require a one-to-one response.

For each parsed ingredient, retain the original ingredient's section `title` and stable `referenceId` while adopting Mealie's parsed quantity, unit, food, note, original text, confidence-derived content, and substitutions. Preserving references prevents instruction-to-ingredient links and frontend ordering identities from silently breaking. Replace the recipe ingredients using Mealie's supported recipe update contract, then read the recipe again and verify its slug, count, ordering, titles, and references before reporting success.

The same service backs post-import normalization and `mealie_reparse_recipe_ingredients`, ensuring they cannot drift. No automatic retry occurs after an update request with an unknown outcome.

Alternatives considered:

- Sending note-only ingredients in an ordinary recipe update does not invoke Mealie's OpenAI parser.
- Keeping parser-generated reference ids can invalidate links from existing recipe instructions.
- Parsing ingredients one request at a time costs more AI calls and can produce inconsistent interpretation across a recipe.

### 7. Resolve human filters exactly before searching or mutating

Search accepts text and arrays of category, tag, and ingredient references. UUIDs and exact slugs use direct lookup where Mealie supports it. Human names are resolved through bounded category, tag, or food searches and exact normalized name/alias comparison. No exact match is not found; multiple exact candidates are ambiguous and return bounded identities for correction. The recipe query is sent only after every supplied reference resolves.

Expose separate `requireAllCategories`, `requireAllTags`, and `requireAllIngredients` booleans and map ingredients to Mealie's `foods`/`requireAllFoods` parameters. Do not expose raw `queryFilter`. Clamp page size to an application maximum and project results to concise summaries plus page, total, total pages, and next/previous availability.

Recipe detail projection includes name, slug, description, yield/servings, time fields, source URL, ingredients, instructions, categories, and tags. Organizer listing is similarly paginated and bounded.

Alternatives considered:

- Requiring the model to discover and pass every slug/UUID adds tool round trips and makes ordinary household language brittle.
- Fuzzy automatic selection can search or mutate the wrong organizer.
- Passing raw query filters delegates a broad query language to model output and exceeds the requested surface.

### 8. Make organizer assignment replacement semantics explicit

Organizer creation accepts kind and name; rename accepts kind, stable id, and new name. Both read back the resulting organizer before returning. Assignment accepts a recipe slug and optional category and tag collections. Omission means unchanged and an explicit empty array means clear. Resolve all references before issuing one recipe patch so an unresolved later reference cannot leave half the requested assignment applied.

Mealie expects organizer objects for recipe assignment, so the service fetches verified organizer records and sends only the supplied organizer fields. It reads the recipe afterward and verifies the resulting ids. No tool invokes organizer or recipe deletion endpoints.

Alternatives considered:

- Add/remove operations are convenient but need additional read-modify-write conflict behavior; replacement is deterministic and matches Mealie's recipe representation.
- Separate category and tag assignment calls can leave a request partially applied when the second call fails.

### 9. Test domain contracts without requiring a live Mealie instance

Inject the fetch/transport boundary and use deterministic HTTP/SSE fixtures for configuration, authentication, version checks, search resolution, streaming outcomes, ingredient preservation, organizer replacement, cancellation, bounds, auditing, and redaction. Add catalogue tests proving MCP and native tools coexist, duplicate names fail, session-bound factories are isolated, and disabled built-in Pi tools remain absent.

A staged smoke test against the self-hosted deployment verifies both source strategies, both ingredient strategies, filtered searches, organizer create/rename/assignment/clear, an AI-provider failure, and recovery from a temporary outage. It also confirms shopping, meal-planning, upload, and deletion tools are absent.

Alternatives considered:

- Live-only tests are slow, mutate household data, and cannot deterministically exercise ambiguous SSE and partial outcomes.
- Fixtures alone cannot detect a current Mealie contract change, so deployment smoke evidence remains necessary.

## Risks / Trade-offs

- **Mealie changes an endpoint or response despite remaining current** -> Keep the client narrow, validate every boundary, cover current response fixtures, and run staged smoke tests before Mealie or Klaus upgrades.
- **AI imports are slow, costly, or nondeterministic** -> Require explicit source and ingredient strategies, use a separate bounded import deadline, and return a verified summary for user review.
- **A creation stream disconnects after Mealie commits** -> Record an indeterminate outcome, do not retry automatically, and direct the agent to search before another import attempt.
- **Ingredient normalization succeeds remotely but verification fails** -> Return a partial result with the known slug and stage; never claim complete success or delete the recipe.
- **A full ingredient replacement races with a human edit** -> Keep the read/parse/update window short, verify references afterward, and report mismatches rather than retrying; Mealie does not expose an optimistic version token for this workflow.
- **Exact name resolution rejects a name a human considers obvious** -> Return bounded candidates and let the agent retry with a stable id or slug rather than choosing fuzzily.
- **The generic provider contract becomes over-abstract** -> Limit it to lifecycle, health, and per-session tool creation; keep HTTP, MCP, and Mealie semantics in their providers.
- **The shared-memory change also edits session tool wiring** -> Land or rebase both changes around the same catalogue contract instead of retaining two parallel custom-tool injection paths.
- **The source URL can make Mealie fetch an unsafe destination** -> Validate URL syntax in Klaus and rely on Mealie's server-side HTTP allow/disallow policy for network reachability; document that operator policy remains authoritative for self-hosted sources.

## Migration Plan

1. Upgrade the Mealie deployment from 3.22.0 to a current 3.23-or-newer release and verify its default AI provider and unified AI import page before changing Klaus.
2. Create a dedicated Mealie automation API key with the narrowest available household permissions, place it in the deployment secret, and do not put it in YAML or environment values.
3. Land the provider catalogue refactor with existing MCP behavior and tests unchanged, coordinating the shared-memory branch against the same session binding interface.
4. Add the native Mealie provider and domain tools disabled by default when configuration is absent.
5. Mount the API-key file, add Mealie configuration, deploy to staging, and inspect health/version diagnostics without performing mutations.
6. Run scraper/imported, scraper/OpenAI, AI/imported, and AI/OpenAI imports against disposable recipes; then verify filtered search and non-destructive organizer operations.
7. Confirm no Mealie key appears in logs, health output, SQLite audits, tool results, or persisted sessions, and confirm out-of-scope tools are absent.
8. Promote the immutable image and configuration using the existing deployment procedure.

Rollback removes the Mealie configuration and secret mount and restores the prior Klaus image. The integration adds no Klaus application-data migration beyond any generic audit outcome extension, and imported Mealie recipes remain in Mealie for deliberate review rather than being automatically deleted.
