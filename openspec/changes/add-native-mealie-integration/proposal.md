# Proposal

## Why

Klaus cannot currently search or import recipes from the household's self-hosted Mealie instance without deploying a broad third-party MCP server. A native integration can expose a deliberately bounded recipe surface, use Mealie's current AI workflows, and establish reusable application-tool composition for future service domains.

## What Changes

- Add an optional, operator-configured native Mealie integration authenticated by an API key loaded from a mounted secret file.
- Add URL recipe import using either Mealie's scraper workflow or its full AI workflow, with independently selectable OpenAI ingredient normalization after either path.
- Add bounded recipe retrieval and search by text, categories, tags, and ingredients, including all/any matching controls.
- Add non-destructive category and tag management: list/search, create, rename, and assign or clear organizers on recipes. Category and tag deletion is excluded.
- Introduce a generic application-tool catalogue/provider boundary so native tool domains, MCP tools, and future integrations can coexist without session construction depending directly on one transport.
- Apply schema validation, cancellation, timeouts, result bounds, auditing, credential redaction, and isolated health reporting to native integration calls.
- Require a current Mealie release with the unified AI recipe import API; the currently deployed Mealie 3.22.0 must be upgraded. No compatibility path for older Mealie APIs is added.
- Keep shopping lists and meal planning out of scope.

## Capabilities

### New Capabilities

- `mealie-recipe-management`: Native Mealie recipe import, ingredient parsing, recipe search and retrieval, and non-destructive category/tag management.

### Modified Capabilities

None. The generic provider refactor implements the existing application-defined tool extension contract without changing its externally observable requirements.

## Impact

- Affects application configuration and secret handling, runtime composition, session tool registration, capability health, tool auditing, deployment manifests, examples, and operator documentation.
- Adds a native authenticated HTTP/SSE client for the configured Mealie origin; it does not expose arbitrary HTTP access to the model.
- Adds recipe and organizer domain modules while retaining the existing MCP registry as a separate capability provider.
- Requires upgrading the target Mealie deployment from 3.22.0 to a release that provides `/api/recipes/create/ai` and `/api/recipes/create/ai/stream` (3.23.0 or newer).
- Uses existing Node.js platform APIs and is not expected to require a third-party Mealie SDK or runtime dependency.
