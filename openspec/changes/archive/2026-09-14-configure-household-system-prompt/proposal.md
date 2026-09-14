## Why

The household assistant's system instructions are currently compiled into the application, which forces operators to rebuild the service for household-specific behavior and guidance. Allowing an explicitly configured prompt file makes those instructions operator-maintainable while preserving the existing built-in prompt as the default.

## What Changes

- Add an optional `agent.systemPromptFile` configuration path.
- When omitted, retain the current built-in `HOUSEHOLD_SYSTEM_PROMPT`.
- When configured, read the file once at startup and use its contents as the complete replacement system prompt.
- Reject missing, unreadable, empty, or whitespace-only configured prompt files during startup.
- Do not enable implicit `AGENTS.md` or other context-file discovery; only the explicitly configured path is used.
- Document the configuration and add coverage for default, replacement, path normalization, and failure behavior.

## Capabilities

### New Capabilities

- `agent-prompt-configuration`: Configure the complete household system prompt through an explicitly selected, validated file.

### Modified Capabilities

None.

## Impact

- Updates configuration parsing and public configuration handling.
- Updates Pi session/runtime construction to load and apply the configured prompt.
- Adds configuration and runtime tests, plus example and operator documentation.
- No new dependencies or provider/API changes are required.
