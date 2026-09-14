## 1. MCP Exposure Configuration

- [x] 1.1 Make each MCP server's `tools` field optional while preserving the distinction between omission, a non-empty restriction list, and an explicit empty list; verify configuration tests cover all three states and continue rejecting malformed entries.
- [x] 1.2 Update typed fixtures and public configuration serialization for the optional field; verify existing configurations with non-empty lists retain their parsed restrictive policy.

## 2. Discovery and Registry Behavior

- [x] 2.1 Update MCP discovery to expose every valid discovered tool when `tools` is omitted, only named tools for a non-empty list, and no tools for an empty list; verify registry tests cover namespacing and each policy state.
- [x] 2.2 Apply the same exposure predicate during reconnect and verify a newly discovered tool becomes available automatically only for an unrestricted server.
- [ ] 2.3 Re-run capability-boundary tests and verify default-all MCP discovery does not enable Pi coding tools, generic HTTP, unconfigured servers, or bypass argument validation, execution bounds, credential isolation, and auditing.

## 3. Operator Experience and Verification

- [ ] 3.1 Update the README, example k3s configuration, deployment guidance, and staged checklist so omission is the primary trusted-server example and explicit list/empty-list restriction modes are documented; verify example configuration and manifest tests pass.
- [ ] 3.2 Run formatting, linting, type checking, unit/integration tests, production build, and strict OpenSpec validation; verify all project gates pass.
- [ ] 3.3 Remove the restrictive `tools` field from the local Home Assistant MCP configuration, restart the live bot, and verify representative formerly unlisted namespaced tools are available while readiness remains healthy.
