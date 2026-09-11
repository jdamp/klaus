# Deployment and staged rollout

## k3s deployment

The example uses one replica and the `Recreate` strategy. This deliberately stops the old
long-poll consumer before starting its replacement. It has separate persistent claims for SQLite
application data and mutable Pi authentication state, while configuration and service credentials
are mounted read-only.

1. Build and push an immutable image. Replace `ghcr.io/example/klaus-agent:1.0.0` in
   `deploy/k3s/klaus-agent.yaml` with that tag or, preferably, its registry digest.
2. Copy `deploy/k3s/secret.example.yaml` outside the repository, replace the placeholders, apply
   it, and do not commit the resulting file.
3. Replace the example Telegram IDs, provider/model selection, MCP URL, and reviewed tool allowlist
   in the ConfigMap.
4. Apply the workload:

   ```sh
   kubectl apply -f deploy/k3s/secret.yaml
   kubectl apply -f deploy/k3s/klaus-agent.yaml
   ```

5. Bootstrap OAuth against the persistent authentication claim before the first rollout, or run
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
- [ ] Each enabled non-critical action (for example a test light) is confirmed both in Telegram and
      at the target service.
- [ ] A discovered but unlisted MCP tool is absent from the agent and cannot be executed.
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
the pre-upgrade backup to a fresh data volume rather than attempting an in-place downgrade.
