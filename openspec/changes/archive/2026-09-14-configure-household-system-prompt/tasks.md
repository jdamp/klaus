## 1. Configuration Contract

- [x] 1.1 Add optional `agent.systemPromptFile` configuration with the existing absolute-path normalization behavior, and verify omitted and relative-path configurations parse as expected.
- [x] 1.2 Include the configured prompt-file path in absolute-path validation and public configuration handling without exposing prompt contents, and verify configuration serialization contains no file text.

## 2. Prompt Resolution

- [x] 2.1 Implement effective-prompt resolution that returns `HOUSEHOLD_SYSTEM_PROMPT` when no file is configured and otherwise reads the configured file once as UTF-8, rejecting read failures and empty or whitespace-only content; verify focused unit tests cover default, replacement, missing, unreadable, and empty files.
- [x] 2.2 Integrate the validated prompt snapshot into Pi session construction while retaining disabled implicit context-file discovery, and verify new sessions use exact configured file contents rather than the built-in prompt.
- [x] 2.3 Ensure prompt-resolution failures prevent application startup and Telegram polling without logging prompt contents, and verify the runtime startup test observes the failure boundary.

## 3. Documentation and Examples

- [x] 3.1 Document `agent.systemPromptFile`, replacement semantics, startup validation, restart behavior, and restricted file handling in the README and operator documentation; verify the documented YAML is valid.
- [x] 3.2 Add the optional setting and an example prompt-file mount/path to the local and container configuration examples without changing the default behavior; verify deployment/configuration tests continue to pass.

## 4. Verification

- [x] 4.1 Run formatting, linting, TypeScript validation, unit/integration tests, and the production build; verify formatting, linting, type checking, tests, and build pass.
- [x] 4.2 Run strict OpenSpec validation for `configure-household-system-prompt`; verify all proposal, spec, design, and task artifacts are accepted.
