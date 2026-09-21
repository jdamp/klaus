# Tasks

## 1. Generic Capability Foundation

- [x] 1.1 Define the lifecycle-aware application tool-provider contract, per-session binding context, and catalogue aggregation with duplicate-name rejection; verify focused tests cover provider ordering, health aggregation, session isolation, and duplicate failures.
- [x] 1.2 Adapt `McpRegistry` behind the provider contract without changing discovery, namespacing, allowlist/default-all, reconnect, cancellation, bounds, or health behavior; verify the existing MCP suite passes unchanged plus a catalogue coexistence test.
- [x] 1.3 Refactor `SessionComponent`, `PiSessionFactory`, runtime construction, and application startup/shutdown to consume the provider catalogue instead of `McpRegistry` directly; verify composition and agent tests prove capabilities start before session tool binding and stop afterward.
- [x] 1.4 Reconcile the provider and session-binding interfaces with the active shared-memory design so both features use one native-tool injection path; verify TypeScript compilation and a test session containing MCP, session-bound native, and shared native tool definitions without duplicate registration.
- [x] 1.5 Add a migration-safe `partial` tool-audit outcome and provider-oriented repository API while retaining existing SQLite rows and the `server_id` storage column; verify fresh and upgraded database tests accept every old outcome plus partial completion.
- [x] 1.6 Implement the reusable native-tool execution envelope for schema validation, combined cancellation/deadlines, redaction, result bounds, and audit transitions; verify unit tests cover success, validation failure, timeout, cancellation, partial, indeterminate, truncation, and secret-bearing errors.

## 2. Mealie Configuration, Transport, and Health

- [x] 2.1 Add optional Mealie configuration for base URL, mounted API-key file, ordinary/import deadlines, raw response bytes, and model-result bytes; verify configuration tests cover defaults, invalid schemes/credentials/query/fragment, normalized paths, omitted configuration, and redacted public output.
- [x] 2.2 Load the configured Mealie key into the central redactor and fail startup on a missing or empty configured secret without persisting it; verify secret fixtures do not appear in public configuration, logs, health output, audits, or serialized errors.
- [x] 2.3 Implement the private fixed-endpoint Mealie JSON/multipart client with bearer authentication, redirect rejection, incremental response bounds, and injected fetch transport; verify HTTP fixtures cover authorization, URL construction, status/error parsing, oversized bodies, cancellation, and cross-origin redirects.
- [x] 2.4 Implement bounded POST-based SSE handling for Mealie recipe imports, including fragmented frames and `progress`, `done`, `error`, premature close, timeout, and cancellation events; verify deterministic stream fixtures classify every terminal and indeterminate outcome without retrying.
- [x] 2.5 Implement Mealie provider startup and on-demand health/version checks against `/api/app/about`, requiring version 3.23.0 or newer while allowing remote outages to remain optional; verify 3.22.0 is incompatible, current versions become healthy, and outage/recovery does not require recreating a session.

## 3. Recipe Retrieval and Search

- [x] 3.1 Define runtime-validated Mealie boundary models and bounded recipe summary/detail projections for the fields required by the spec; verify malformed remote payloads fail closed and representative complete recipes retain ingredients, instructions, timing, source, categories, and tags.
- [x] 3.2 Implement exact category, tag, and food reference resolution by UUID, slug where supported, name, and alias with bounded candidate errors; verify fixtures cover unique, missing, case-normalized, and ambiguous references without fuzzy auto-selection.
- [x] 3.3 Implement bounded recipe search with text, resolved categories/tags/foods, independent require-all flags, pagination clamping, and no raw query-filter input; verify query fixtures and tool tests cover each filter alone, combinations, all/any semantics, empty results, and ambiguous preflight rejection.
- [x] 3.4 Implement recipe detail retrieval and not-found handling; verify tests return the bounded projection for a valid slug and never synthesize content for a missing recipe.
- [x] 3.5 Register `mealie_search_recipes` and `mealie_get_recipe` through the recipe domain with documented schemas and structured outcomes; verify Pi session tests expose them only when Mealie is configured and retain all built-in coding, shell, filesystem, and generic HTTP tools as disabled.

## 4. URL Import and Ingredient Normalization

- [x] 4.1 Implement the staged URL import service with required scraper/AI source and imported/OpenAI ingredient strategies, strategy-specific option validation, and `createNewOrganizers=false`; verify all four strategy combinations target the correct current Mealie endpoints and no automatic source fallback or retry occurs.
- [x] 4.2 Implement source-stage outcome tracking and post-creation verification so success, pre-creation failure, partial failure with slug/stage, cancellation, timeout, and indeterminate stream closure remain distinct; verify each fixture produces the specified tool result and audit status without deleting a created recipe.
- [x] 4.3 Implement bulk OpenAI ingredient parsing using `originalText`, `display`, then `note`, requiring usable text and a one-to-one parser response; verify missing text and response-count mismatches stop before recipe mutation.
- [x] 4.4 Implement preservation-aware ingredient replacement and verification for ordering, section titles, stable reference IDs, parsed units/foods/notes, and substitutions; verify linked instruction references and section ordering survive representative reparses.
- [x] 4.5 Reuse the normalization service for existing recipes and register `mealie_import_recipe_url` plus `mealie_reparse_recipe_ingredients`; verify tool-schema tests require explicit strategy choices, reject irrelevant cross-strategy options, and return bounded verified or partial results.

## 5. Category and Tag Management

- [x] 5.1 Implement bounded list/search, create, and rename services for `category` and `tag`, including mutation read-back verification; verify fixtures cover pagination, successful mutations, duplicate/invalid names, not-found IDs, and remote validation failures.
- [x] 5.2 Implement recipe organizer replacement with pre-resolution of every supplied reference, omission-as-unchanged, empty-array clearing, one patch, and read-back verification; verify categories and tags can be replaced together without partial preflight mutation and either type can be cleared independently.
- [x] 5.3 Register `mealie_list_organizers`, `mealie_create_organizer`, `mealie_rename_organizer`, and `mealie_set_recipe_organizers` with kind-discriminated schemas; verify catalogue inspection contains no organizer deletion, recipe deletion, upload, shopping-list, meal-planning, or arbitrary Mealie operation.

## 6. Runtime, Deployment, and Documentation

- [x] 6.1 Wire the configured Mealie provider, shared executor, audit repository, redactor, and provider-level health into application construction while leaving unconfigured deployments unchanged; verify runtime tests cover absent configuration, healthy startup, degraded remote startup, incompatible version, and recovery.
- [x] 6.2 Update local/container examples and k3s resources with an optional Mealie section and read-only API-key secret mount; verify example parsing and Kubernetes manifest/deployment tests accept the configuration and no key value is committed.
- [x] 6.3 Update README and operational guidance with the Mealie 3.23+ prerequisite, AI-provider setup, dedicated API-key handling, both strategy axes, partial/indeterminate outcomes, Mealie HTTP allow/disallow responsibility, excluded domains, smoke testing, and rollback; verify documented YAML passes configuration validation.
- [x] 6.4 Add privacy-safe staged evidence placeholders/checklists for both import paths, both ingredient modes, filtered search, organizer mutations, outage recovery, excluded tools, and credential scans; verify the documentation requests no recipe content, source URL, household identifier, or credential in committed evidence.

## 7. Verification and Rollout

- [x] 7.1 Run formatting, linting, type checking, all unit/integration tests, production build, and strict OpenSpec validation for `add-native-mealie-integration`; verify every command succeeds.
- [ ] 7.2 Upgrade the self-hosted Mealie deployment from 3.22.0 to a current release, configure its default AI provider, create a dedicated automation API key outside the repository, and verify the unified AI import works in Mealie before enabling Klaus.
- [ ] 7.3 Build and deploy an immutable Klaus image with the mounted Mealie key, then verify readiness remains true and Mealie health reports healthy without exposing the key or its path.
- [ ] 7.4 Against disposable recipes, exercise scraper/imported, scraper/OpenAI, AI/imported, and AI/OpenAI imports, an existing-recipe reparse, text/category/tag/ingredient searches, organizer create/rename/assign/clear, and a temporary Mealie outage; verify outcomes in both Telegram and Mealie and record privacy-safe evidence.
- [ ] 7.5 Inspect the live native catalogue, logs, health output, SQLite tool audits, and persisted session data; verify shopping-list, meal-planning, upload, and deletion tools are absent and the Mealie API key appears nowhere outside its mounted secret file.
