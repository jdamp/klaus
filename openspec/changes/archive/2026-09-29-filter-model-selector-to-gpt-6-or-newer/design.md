## Context

Pi returns available models from authenticated backends. `ApplicationServices.availableModels` maps and sorts that catalogue, and both the selector and direct `/model provider/model-id` selection consume its result. See proposal.md for the motivation and the spec delta for the user-visible contract.

## Goals / Non-Goals

**Goals:**
- Apply one consistent availability rule to selector display and direct model selection.
- Preserve models outside the versioned `gpt-N` naming pattern.

**Non-Goals:**
- Change the configured fallback model or the behavior of an already active model.
- Filter models supplied by the provider runtime itself or alter provider authentication.

## Decisions

- Filter the list in the shared `availableModels` service path. This keeps selector contents, callback validation, and direct selection consistent; filtering only in the UI would leave older models selectable by explicit ID.
- Recognize a versioned GPT ID by a case-insensitive `gpt-` prefix followed by a numeric major version and a valid name boundary (end of ID, `.` or `-`). Include it when the major version is at least 6. Exclude recognized major versions below 6. If the ID does not match this pattern, leave it in the list as requested, including IDs such as `gpt-image-2`.
- Keep filtering based on model ID rather than provider name so equivalent IDs behave consistently across authenticated backends.

## Risks / Trade-offs

- [A future GPT ID format may use a different separator or omit a numeric major version] → It will be treated as outside the recognized pattern and remain available, matching the explicit inclusion rule for IDs that do not fit the naming scheme.
- [Filtering the shared available list also rejects direct selection of older recognized GPT models] → This is intentional so both selection paths honor the same model choices.

## Migration Plan

No data migration is required. Existing saved preferences are not rewritten; this change governs the available choices used by the selector and direct selection.
