## ADDED Requirements

### Requirement: Model selection filters older versioned GPT models
The system SHALL omit models with IDs matching the versioned `gpt-N` naming pattern when their major version is less than 6 from the available model choices. It SHALL retain versioned GPT models with major version 6 or greater and models whose IDs do not match that naming pattern. The same available choices SHALL govern both the model selector and direct model selection.

#### Scenario: Older versioned GPT models are unavailable for selection
- **WHEN** an authenticated backend reports models including `gpt-5.3-spark-codex`, `gpt-5.5`, and `gpt-5.6-sol`
- **THEN** those models are omitted from the selector and rejected by direct model selection

#### Scenario: GPT-6 and newer models remain available
- **WHEN** an authenticated backend reports models including `gpt-6-sol`, `gpt-6.1-sol`, and `gpt-7-sol`
- **THEN** those models remain available in the selector and direct model selection

#### Scenario: Models outside the versioned GPT naming pattern remain available
- **WHEN** an authenticated backend reports a model whose ID does not match `gpt-N` with a numeric major version
- **THEN** that model remains available in the selector and direct model selection
