# Mealie Recipe Management Specification Delta

## Purpose

Provide a bounded native connection to a current self-hosted Mealie instance for recipe discovery, URL import, structured ingredient parsing, and non-destructive organization.

## ADDED Requirements

### Requirement: Operators can enable an authenticated native Mealie integration
The system SHALL enable native Mealie tools only when an operator configures a Mealie base URL and mounted API-key file. The credential MUST NOT be included in model prompts, tool arguments, persisted conversation content, public configuration output, health details, or logs, and the integration MUST NOT provide arbitrary model-selected HTTP requests.

#### Scenario: Configured Mealie integration starts
- **WHEN** the configured Mealie origin accepts the mounted API key and reports a supported current version
- **THEN** the native Mealie tools are available to agent sessions without requiring an MCP server

#### Scenario: Mealie credential is handled
- **WHEN** the application authenticates any Mealie request or reports a Mealie failure
- **THEN** the API key and its filesystem location are absent from model-visible, persisted, public, health, and log output

#### Scenario: Mealie is not configured
- **WHEN** the operator omits Mealie configuration
- **THEN** no native Mealie tools are exposed and other configured capabilities continue normally

### Requirement: URL imports support scraper and AI source strategies
The system SHALL provide one URL-import operation with an explicit source strategy selecting either Mealie's current URL scraper workflow or its current unified AI recipe workflow. Both strategies SHALL use Mealie's streaming import interface, return the created recipe slug and verified recipe summary on success, and SHALL NOT automatically retry a creation request whose outcome is indeterminate.

#### Scenario: Scraper source import succeeds
- **WHEN** the agent imports an HTTP or HTTPS recipe URL using the scraper source strategy
- **THEN** Mealie's scraper workflow creates the recipe and the tool returns its slug and verified summary

#### Scenario: AI source import succeeds
- **WHEN** the agent imports an HTTP or HTTPS recipe URL using the AI source strategy and Mealie has an enabled AI provider
- **THEN** Mealie's unified AI workflow creates the recipe and the tool returns its slug and verified summary

#### Scenario: Import outcome is indeterminate
- **WHEN** an import stream ends without a definitive success or failure event
- **THEN** the tool reports an indeterminate outcome and does not automatically submit the creation request again

### Requirement: Ingredient normalization is independently selectable
The URL-import operation SHALL allow the caller to retain ingredients produced by the selected source workflow or normalize them with Mealie's OpenAI ingredient parser after creation. OpenAI normalization SHALL preserve ingredient ordering, section titles, and stable recipe references when replacing parsed ingredient data.

#### Scenario: Imported ingredients are retained
- **WHEN** the caller selects imported ingredient handling
- **THEN** the created recipe retains the ingredient representation produced by the source workflow

#### Scenario: OpenAI ingredients are requested
- **WHEN** the caller selects OpenAI ingredient handling and the source workflow creates a recipe
- **THEN** the system submits the recipe's ingredient text to Mealie's OpenAI ingredient parser, updates the recipe with the structured results, and verifies the updated recipe

#### Scenario: Existing recipe ingredients are reparsed
- **WHEN** the agent requests OpenAI ingredient parsing for an existing recipe slug
- **THEN** the system normalizes that recipe's ingredients with the same preservation and verification behavior used after URL import

### Requirement: Multi-stage recipe mutations report partial outcomes accurately
The system SHALL distinguish complete success, failure before recipe creation, partial failure after recipe creation, cancellation, timeout, and indeterminate creation outcomes. If a recipe exists when a later parsing, update, or verification stage fails, the result MUST identify the created recipe slug and failed stage and MUST NOT claim complete success or automatically delete the recipe.

#### Scenario: Ingredient parsing fails after import
- **WHEN** Mealie creates the recipe but OpenAI ingredient parsing subsequently fails
- **THEN** the tool reports a partial outcome containing the recipe slug and parsing stage without claiming that normalization succeeded

#### Scenario: Import fails before creation
- **WHEN** Mealie definitively rejects the source before creating a recipe
- **THEN** the tool reports failure without presenting a recipe slug

### Requirement: Recipes can be searched with household-oriented filters
The system SHALL provide bounded recipe search by free text, categories, tags, and ingredients, with independent all-or-any matching controls for each multi-value filter. Category, tag, and ingredient references SHALL accept stable identifiers or exact human-facing names, and unresolved or ambiguous names MUST produce a clear error rather than silently broadening the search.

#### Scenario: Combined filtered search
- **WHEN** the agent searches with text plus category, tag, or ingredient filters
- **THEN** the system resolves the filters, applies the requested all-or-any semantics, and returns a bounded page of concise recipe summaries with pagination metadata

#### Scenario: Exact display names are used
- **WHEN** a supplied category, tag, or ingredient exactly identifies one Mealie organizer or food
- **THEN** the system resolves it to the corresponding stable filter and applies it to the recipe search

#### Scenario: Filter name is ambiguous
- **WHEN** a supplied human-facing filter matches multiple possible Mealie records
- **THEN** the search is rejected with bounded candidate information and no broader query is executed

### Requirement: Complete recipe details can be retrieved
The system SHALL retrieve a recipe by slug and return bounded details sufficient to answer household questions about its ingredients, instructions, yield, timing, source, categories, and tags.

#### Scenario: Recipe exists
- **WHEN** the agent requests a valid recipe slug
- **THEN** the tool returns the bounded recipe details

#### Scenario: Recipe does not exist
- **WHEN** Mealie reports that the requested slug does not exist
- **THEN** the tool reports a not-found outcome without inventing recipe content

### Requirement: Categories and tags support non-destructive management
The system SHALL support listing and searching categories and tags, creating them, renaming them, and replacing or clearing a recipe's category and tag assignments. Omitted assignment collections SHALL remain unchanged while an explicitly empty collection SHALL clear that organizer type. The native tool surface MUST NOT expose category or tag deletion.

#### Scenario: Organizer is created or renamed
- **WHEN** the agent performs a schema-valid create or rename operation for a category or tag
- **THEN** the system applies the mutation and returns the verified organizer identity and name

#### Scenario: Recipe organizers are replaced
- **WHEN** the agent supplies category or tag references for a recipe
- **THEN** the system resolves the references, replaces only the supplied organizer collections, and returns the verified assignments

#### Scenario: Recipe organizers are cleared
- **WHEN** the agent supplies an explicitly empty category or tag collection
- **THEN** the system clears that organizer type while leaving any omitted organizer type unchanged

#### Scenario: Organizer deletion is requested
- **WHEN** the model attempts to delete a Mealie category or tag
- **THEN** no native deletion tool is available and the integration performs no deletion

### Requirement: Mealie operations are bounded, auditable, and isolated
The system SHALL validate native tool arguments, propagate user cancellation, enforce separate bounded deadlines suitable for ordinary requests and streaming AI imports, bound remote responses and model-visible results, redact configured secrets, and audit each operation and outcome. Mealie unavailability MUST degrade only the optional integration and MUST remain observable to users of affected tools and service operators.

#### Scenario: Mealie request times out
- **WHEN** a Mealie operation exceeds its configured deadline
- **THEN** the system stops waiting, records a timeout outcome, and reports that the operation did not complete

#### Scenario: Mealie result exceeds its bound
- **WHEN** Mealie returns more data than the configured response or tool-result limit
- **THEN** the system rejects or truncates the data safely, marks the bounded outcome, and does not admit unbounded content into conversation context

#### Scenario: Mealie is unavailable
- **WHEN** the configured Mealie instance cannot be reached
- **THEN** Mealie health is degraded and affected tool calls report unavailability without disrupting Telegram, sessions, or unrelated capability providers

### Requirement: The native surface remains recipe-scoped
The first native Mealie release MUST NOT expose shopping-list, meal-planning, organizer-deletion, arbitrary recipe-deletion, filesystem-upload, or generic Mealie API operations.

#### Scenario: Out-of-scope operation is requested
- **WHEN** the model requests a shopping-list, meal-plan, deletion, upload, or arbitrary API action through the native integration
- **THEN** no corresponding native tool is available and no Mealie mutation is performed

### Requirement: The integration targets the current unified AI API
The system SHALL target Mealie 3.23.0 or newer and SHALL NOT implement alternate request paths for older Mealie APIs. An explicitly configured unsupported deployment MUST be reported as incompatible before its tools are used.

#### Scenario: Supported Mealie version is configured
- **WHEN** Mealie reports version 3.23.0 or newer and its required current endpoints are available
- **THEN** the integration may become healthy and expose its native tools

#### Scenario: Mealie 3.22.0 is configured
- **WHEN** the configured instance reports Mealie 3.22.0
- **THEN** the integration reports an incompatible-version condition and instructs the operator to upgrade rather than attempting a legacy API flow
