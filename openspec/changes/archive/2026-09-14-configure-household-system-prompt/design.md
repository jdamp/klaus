## Context

The application currently passes a hard-coded `HOUSEHOLD_SYSTEM_PROMPT` to Pi's resource loader while disabling automatic context-file discovery. Configuration paths are normalized to absolute paths during parsing, and application startup already provides a single point where validated runtime settings can be assembled. See `proposal.md` and the agent-prompt-configuration specification for the motivation and behavior contract.

## Goals / Non-Goals

**Goals:**

- Preserve the current prompt as the default for backward compatibility.
- Resolve an explicitly configured prompt file once during startup and reuse the resulting text for session creation.
- Fail clearly before Telegram polling when the configured file is unusable.
- Keep prompt-file content out of logs and retain the existing disabled implicit context discovery behavior.

**Non-Goals:**

- Supporting automatic discovery or merging of `AGENTS.md`, `CLAUDE.md`, or ancestor context files.
- Hot-reloading prompt changes while the process is running.
- Adding prompt templating, frontmatter interpretation, per-chat prompts, or runtime user control.
- Changing Pi tools, skills, MCP permissions, or conversation persistence.

## Decisions

### 1. Add an optional `agent.systemPromptFile` setting

The configuration schema will add an optional `agent` object with an optional `systemPromptFile` path. The existing path transformation will resolve relative paths consistently with other configured files. The default remains absent, rather than pointing at a repository-relative `AGENTS.md`, so deployments remain deterministic and existing installations keep their current prompt.

Alternatives considered:

- A top-level `systemPromptFile` is shorter but places agent behavior beside unrelated service settings and leaves room for future agent settings to become inconsistent.
- Re-enabling Pi's context-file discovery would implicitly load files based on the process working directory and could change behavior when deployment layout changes.

### 2. Load the effective prompt once during startup

Runtime assembly will resolve the effective prompt before the session factory is used: it will select `HOUSEHOLD_SYSTEM_PROMPT` when the setting is absent, otherwise read the configured file as UTF-8. The resolved string will be injected into `PiSessionFactory`, while each `DefaultResourceLoader` will continue to receive prompt text and `noContextFiles: true`.

The loader's native file-source option is not used for validation because an invalid source can be treated as literal prompt input by Pi. Explicit application-side reading makes missing and unreadable files fatal and ensures all sessions in one process use the same validated prompt snapshot.

### 3. Reject semantically empty content

Validation will reject prompt content when `content.trim()` is empty. The original content, including meaningful whitespace and line breaks, will otherwise be passed unchanged to Pi. File-read errors will be wrapped with the configured path without logging file contents.

### 4. Keep prompt content out of operational output

Configuration serialization may expose the normalized prompt-file path as ordinary configuration metadata, but it will never serialize the file contents. Startup errors may identify the path and operating-system failure, but must not include prompt text.

## Risks / Trade-offs

- **A malformed custom prompt can weaken assistant behavior** -> Replacement semantics are intentional and operator-controlled; documentation will state that the file is the complete system prompt and must include all required household guidance.
- **Prompt edits require a restart** -> This gives every session a consistent prompt snapshot and matches the application's startup-only configuration model.
- **A prompt file may contain sensitive household information** -> Treat it as operator-managed configuration, mount it with restricted permissions, and never include its contents in logs or persisted conversation records.
- **Relative paths depend on the process working directory** -> Follow the existing configuration convention, resolve paths during parsing, and document absolute paths for container deployments.

## Migration Plan

1. Deploy the schema and runtime support with no `agent` section; existing deployments continue using the built-in prompt.
2. If customization is desired, mount a prompt file and add `agent.systemPromptFile` to configuration.
3. Restart the service and verify startup readiness and one authorized conversation.
4. To roll back, remove the setting and restart; the built-in prompt is restored without a database migration.
