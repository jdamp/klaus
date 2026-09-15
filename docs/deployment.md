# Deployment and staged rollout

## k3s deployment

The checked-in manifests target the pre-provisioned `klaus` namespace. Confirm the target before
applying changes with `kubectl get namespace klaus`; do not create or use the legacy
`klaus-agent` namespace. Inspect the test rollout with:

```sh
kubectl -n klaus get deployment,pods,pvc
kubectl -n klaus rollout status deployment/klaus-agent --timeout=5m
```

The example uses one replica and the `Recreate` strategy. This deliberately stops the old
long-poll consumer before starting its replacement. It has separate persistent claims for SQLite
application data and mutable Pi authentication state, while configuration and service credentials
are mounted read-only.

1. Build and push an immutable image. Replace `ghcr.io/example/klaus-agent:1.0.0` in
   `deploy/k3s/klaus-agent.yaml` with that tag or, preferably, its registry digest.
2. Copy `deploy/k3s/secret.example.yaml` outside the repository, replace the placeholders, apply
   it, and do not commit the resulting file. Create a dedicated Kaneo API key under the automation
   account and set `kaneo-api-key`; do not reuse a personal key.
3. Replace the example Telegram IDs, provider/model selection, and Home Assistant MCP URL in the
   ConfigMap. The Kaneo entry uses the pinned package over stdio and an explicit non-destructive
   project/task allowlist. An MCP server with no `tools` field exposes its discovered catalogue;
   add a list only when you want to restrict that server, or `tools: []` to expose none.
4. If using a custom household prompt, add `agent.systemPromptFile` to the ConfigMap and include the
   UTF-8 prompt as a read-only ConfigMap or mounted file at that path. The file completely replaces
   the built-in prompt and must be non-empty; restart the pod after changes.
5. Apply the workload:

   ```sh
   kubectl apply -f deploy/k3s/secret.yaml
   kubectl apply -f deploy/k3s/klaus-agent.yaml
   ```

6. Bootstrap OAuth against the persistent authentication claim before the first rollout, or run
   the container locally with that claim mounted and execute:

   ```sh
   node --experimental-sqlite dist/src/cli.js auth login --type oauth --config /etc/klaus-agent/config.yaml
   ```

The pod is non-root, drops Linux capabilities, prevents privilege escalation, uses a read-only root
filesystem, and writes only to the two persistent volumes. Its 40-second termination grace exceeds
the application's 30-second shutdown deadline.

## Staged smoke-test checklist

Perform this with a dedicated test bot and a reviewed non-critical MCP endpoint before household
rollout. Record the image digest, configuration revision, time, tester, and result for each item.

- [ ] Readiness becomes healthy; optional unavailable MCP servers are reported as degraded.
- [ ] Each allowlisted adult can send a direct message and receives exactly one reply in that chat.
- [ ] Each allowlisted adult can invoke the bot in the family group by an entity-backed mention.
- [ ] Replying to a bot-authored group message invokes it.
- [ ] A supported bot command invokes it.
- [ ] Ambient group text and text merely resembling the bot name receive no response and are not
      stored.
- [ ] A non-allowlisted user in the family group receives no response and creates no stored update.
- [ ] An allowlisted user in a non-allowlisted chat receives no response and creates no stored
      update.
- [ ] An allowlisted MCP read operation succeeds and returns a bounded result.
- [ ] Kaneo workspace/project/task reads succeed through the namespaced stdio tools.
- [ ] A harmless create/update operation in a designated non-critical Kaneo project is confirmed
      both in Telegram and in Kaneo; excluded deletion and workspace-mutation tools are unavailable.
- [ ] Each enabled non-critical action (for example a test light) is confirmed both in Telegram and
      at the target service.
- [ ] With `tools` omitted, the configured MCP server catalogue is exposed and a representative
      formerly unlisted namespaced tool is available.
- [ ] With the MCP endpoint stopped, unrelated conversation still works and health reports
      degradation.
- [ ] After terminating the pod during a turn, the recorded update is not replayed and any
      ambiguous tool execution is marked indeterminate.
- [ ] After terminating the pod during delivery, a pending response is delivered once after
      restart without rerunning the agent.
- [ ] Logs, health output, SQLite rows, and Telegram replies contain no configured credential.
- [ ] `/new` resets only the current chat's session.

Do not enable locks, alarms, garage doors, or other critical infrastructure. Do not check off an
action test unless the physical/service result was independently observed. If an action has an
indeterminate audit outcome, inspect the target state manually before attempting it again.

## Rollout and replacement

Apply Secrets and ConfigMap changes before changing the image. Back up SQLite as described in
`docs/operations.md`, then update the pinned image reference. Wait for the old pod to terminate
before the replacement becomes active; `Recreate` enforces this at Deployment level. Confirm
readiness and repeat the authorization, one read-only MCP call, and one harmless action checks.

Rollback must also use `Recreate`. If the previous image cannot read the upgraded schema, restore
the pre-upgrade backup to a fresh data volume rather than attempting an in-place downgrade. Remove
the Kaneo entry and mount when rolling back, and revoke the dedicated Kaneo API key if the
integration is retired or the secret may have been exposed.
