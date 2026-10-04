# Deployment and staged rollout

## Public image release

`.github/workflows/publish-image.yml` runs formatting, linting, type checking, tests, the
application build, and a container smoke build for pull requests to `main` and pushes to `main`.
Only a successful `main` push publishes the Dockerfile's `final` target to
`ghcr.io/jdamp/klaus-agent:sha-<full-commit-sha>`. Read the `Published
ghcr.io/jdamp/klaus-agent@sha256:...` reference from that run's summary. Use the digest, not the
commit tag, in the k3s manifest.

The first amd64-only release is source commit `8fa8a59889188eae718f8f492c945ef599667471`
from [main run 37104489811](https://github.com/jdamp/klaus/actions/runs/37104489811). The
checked-in deployment pins
`ghcr.io/jdamp/klaus-agent@sha256:6a11b2cdaa0e506c36b287421f5493deed1a67450c60b251c085bd1fb059738d`.
All three jobs passed, and an anonymous pull of its amd64 image and all ten layers succeeded on
2026-10-03. A temporary pod on the current `klaus` node, `proxmox-1-worker-1`, freshly pulled the
same digest with `imagePullPolicy: Always`, ran `node -p process.arch` successfully (`x64`), and
had no `imagePullSecrets`; it was then removed. The package is public. For each later release,
verify an unauthenticated pull of the reported digest before updating the manifest. Confirm the
target k3s node is `amd64` and make a fresh pull on that node before applying the deployment. A
public image needs no Kubernetes registry pull Secret. The workflow uses its repository
`GITHUB_TOKEN` to push; the cluster and this repository need no GHCR credential.

The [first GHCR cutover record](releases/2026-10-03-ghcr-cutover.md) documents the live rollout and
the operator's choice to skip a new SQLite and Pi authentication backup because this is still a
development deployment. There is no previous durable digest or new backup for rollback to the
prior state. For later releases, record the source commit, published digest, previous durable
digest, configuration revision, backup locations or explicit waiver, rollout time, and verification
results. Do not treat the expiring ttl.sh reference as a reliable rollback image.

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

1. Confirm the quality and container jobs passed on `main`, the GHCR image is public, the target
   k3s node is amd64, and the digest can be freshly pulled there without authentication. For a
   later release, replace the image in `deploy/k3s/klaus-agent.yaml` with
   `ghcr.io/jdamp/klaus-agent@sha256:<published-digest>` and record the previous digest before
   applying the manifest. The first cutover has no previous durable digest because the existing
   ttl.sh image expires.
2. Copy `deploy/k3s/secret.example.yaml` outside the repository, replace the placeholders, apply
   it, and do not commit the resulting file. Create a dedicated Kaneo API key under the automation
   account and set `kaneo-api-key`; do not reuse a personal key. If enabling Mealie, first upgrade it
   to 3.23.0 or newer and configure its AI provider. The Mealie key lives in a **separate** Secret
   named `mealie-api-key`, under data key `MEALIE_API_KEY`; mount it as `/run/secrets/mealie/api-key`.
   Paperless remains disabled by default. Only after completing the Paperless staging review below,
   copy `deploy/k3s/paperless-secret.example.yaml` outside the repository, replace its placeholder,
   and apply it as the separate `paperless-api-token` Secret. The optional read-only volume is inert
   while Paperless configuration is omitted. Never commit any generated Secret or real key.
3. Replace the example Telegram IDs, provider/model selection, and Home Assistant MCP URL in the
   ConfigMap. The Kaneo entry uses the pinned package over stdio and an explicit non-destructive
   project/task allowlist. The optional Mealie section is commented out until its endpoint and key
   have been reviewed; when enabled it exposes only recipe and non-destructive organizer tools.
   Set `mealie.baseUrl` to the internal API service and `mealie.publicUrl` to the browser-accessible
   origin (currently recorded in the separate `mealie-config` ConfigMap as `MEALIE_BASE_URL`); the
   application reads these values from `klaus-agent-config`, not environment variables. Keep the
   `paperless` block commented out unless its separate opt-in review is complete. When approved,
   set its `baseUrl` to the API root (including any application subpath), `publicUrl` to the
   user-accessible Paperless application root, and `apiTokenFile` to
   `/run/secrets/paperless/api-token`. Configure only bounded limits and the reviewed staging
   contract; these values are read from `klaus-agent-config`, not environment variables. MCP servers
   use `exposure: deferred` by default: their permitted tools are loaded with `tool_search` when
   needed. Set `exposure: direct` for a small catalogue that should be declared from the first model
   call. Omitting `tools` permits the full discovered catalogue, a non-empty list restricts it, and
   `tools: []` disables all tools from that server. Model-visible names use Pi's
   `mcp__<server>__<tool>` namespace.
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
the application's 30-second shutdown deadline. Set `PI_CODING_AGENT_DIR` to a directory on the Pi
authentication volume so Pi's MCP OAuth store does not try to write under the read-only home directory.

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
- [ ] With `tools` omitted, the configured MCP server catalogue is discoverable through
      `tool_search`; with `exposure: direct`, permitted tools are declared from the first turn.
- [ ] With the MCP endpoint stopped, unrelated conversation still works and health reports
      degradation.
- [ ] If Mealie is enabled, verify scraper/imported, scraper/OpenAI, AI/imported, and AI/OpenAI
      imports against disposable recipes; verify an existing-recipe reparse, filtered searches,
      organizer create/rename/assign/clear, and recovery after a temporary outage. OpenAI
      normalization resolves existing food/unit IDs by exact name; `createMissingCatalogEntries`
      defaults to false and must be explicitly enabled to create up to 20 missing shared food/unit
      records for that operation. Inspect partial outcomes before any retry.
- [ ] After terminating the pod during a turn, the recorded update is not replayed and any
      ambiguous tool execution is marked indeterminate.
- [ ] After terminating the pod during delivery, a pending response is delivered once after
      restart without rerunning the agent.
- [ ] Logs, health output, SQLite rows, and Telegram replies contain no configured credential.
- [ ] `/new` resets only the current chat's session.
- [ ] An explicit harmless remember request creates a readable note; `/memory` lists it and
      `/memory <id>` returns its literal body without a model call.
- [ ] The same note is visible from an authorized private and group chat, while an unauthorized
      interaction cannot inspect it.
- [ ] A correction advances the note revision without dropping an unrelated detail; a stale edit
      conflicts.
- [ ] `/stop` after a confirmed memory save does not undo it, and the acknowledgement does not
      claim rollback.
- [ ] Clearing `overview` survives restart; ordinary note writes still work when the overview is
      at its configured limit.
- [ ] Deleting a test note removes it from current reads/search and exact overview links. Record
      that historical messages and backups remain outside logical deletion.
- [ ] Run the real-model capture and recall protocol in `docs/memory-evaluation.md` and record its
      model, settings, score, opportunistic misses, and all failure cases.

Do not enable locks, alarms, garage doors, or other critical infrastructure. Do not check off an
action test unless the physical/service result was independently observed. If an action has an
indeterminate audit outcome, inspect the target state manually before attempting it again.

## Paperless activation checklist

Paperless must remain disabled unless the operator separately approves it. The checked-in ConfigMap
omits Paperless configuration and the deployment's Paperless Secret volume is optional. The example
Secret contains only a placeholder; it does not establish an instance URL, installed version, or
permission model.

Before enabling against a household instance:

1. Review a staging instance's installed release and confirm its authenticated API v10 response
   headers and task/document schemas. Do not infer compatibility from the latest upstream release.
2. Create a distinct least-privilege API token and store it only in the separate read-only Secret
   file. Review the single shared account's document visibility, correspondent/type/tag permissions,
   and which authorized private chats and the one allowlisted group can invoke Klaus.
3. Review Paperless workflows, default ownership, and metadata overrides. Confirm uploaded documents
   will be visible to the household UI accounts where intended; Klaus does not change Paperless
   permissions or workflows.
4. Against disposable staging records, verify search/read, organizer create/rename/assignment, PDF,
   JPEG, and PNG upload receipts/status, rejected formats, denied access, group triggers, uncertain
   submissions, and recovery after an outage. Confirm no automatic retry or Telegram PDF delivery.
5. Back up SQLite and Pi authentication state, add the reviewed `paperless` block and separate
   Secret, then roll out with the standard Recreate procedure. Confirm `/ready`, tool outcomes, and
   that receipts survive a restart before allowing household use.

Rollback removes the Paperless configuration and optional Secret mount (and may revoke the dedicated
API token) before redeploying the previous image. Keep SQLite receipt history and deduplication
tombstones; do not automatically replay an uncertain upload or delete remotely created documents.
No staging or household endpoint has been inspected as part of this change, and household activation
is not authorized by this checklist.

## Rollout and replacement

Apply Secrets and ConfigMap changes before changing the image. For a later release requiring data
rollback, back up SQLite and Pi authentication state as described in `docs/operations.md` before
updating the pinned image reference. Wait for the old pod to terminate before the replacement
becomes active; `Recreate` enforces this at Deployment level. Confirm readiness and repeat the
authorization, one read-only MCP call, and one harmless action checks.

Rollback must also use `Recreate`. If the previous image cannot read the upgraded schema, restore
the pre-upgrade backup to a fresh data volume rather than attempting an in-place downgrade. Remove
the Kaneo entry and mount when rolling back, and revoke the dedicated Kaneo API key if the
integration is retired or the secret may have been exposed. If Mealie is enabled, remove its
configuration and mount and revoke its dedicated API key on rollback.
