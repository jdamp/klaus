## Why

The `/model` selector includes many older models from authenticated backends, making current choices harder to find. Limit versioned GPT choices to GPT-6 and newer while keeping model IDs that do not use the `gpt-N` naming pattern available.

## What Changes

- Filter available models so recognized GPT major versions below 6 are omitted from the selector and direct model selection.
- Keep recognized GPT major versions 6 or newer, along with model IDs that do not match the versioned `gpt-N` pattern.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `agent-conversations`: Define which available model choices users can see and select.

## Impact

- Affects model catalogue handling and model selection in `src/runtime/services.ts`.
- Clarifies `/model` behavior in `README.md` and extends the `agent-conversations` capability contract.
