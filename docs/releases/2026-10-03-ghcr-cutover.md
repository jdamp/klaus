# First public GHCR cutover — 2026-10-03 UTC

- Environment: development Deployment `klaus/klaus-agent` on `proxmox-1-worker-1` (`x64`).
- Source commit: `8fa8a59889188eae718f8f492c945ef599667471`.
- Image: `ghcr.io/jdamp/klaus-agent@sha256:6a11b2cdaa0e506c36b287421f5493deed1a67450c60b251c085bd1fb059738d`.
- CI: [main run 37104489811](https://github.com/jdamp/klaus/actions/runs/37104489811) passed quality, container verification, and publication. The manifest update is in [PR #3](https://github.com/jdamp/klaus/pull/3).
- Prior image: `ttl.sh/klaus-pi-1-0-20261002110504:24h@sha256:795247e0f5560b0da998473217967485381680a1f11b4c9b2391e5bd967ceeb7`. There is no previous durable digest.
- Configuration: live `klaus-agent-config` resource version `137108636` before and after rollout. The Deployment image changed, followed by a restart annotation; the existing Secrets and persistent claims were reused.
- Persistent claims: `klaus-agent-data` UID `c9920836-a2f4-401b-bbad-50dce29d4190`; `klaus-agent-auth` UID `b908eda2-7ffb-4cbf-8b0c-abab9d1a79d0`.
- Backup: the operator explicitly waived a new SQLite and Pi authentication backup because the deployment is still in development. No new data or Pi authentication backup was taken for this cutover.

## Verification

1. On 2026-10-03, an anonymous GHCR pull downloaded and verified all ten amd64 image layers. A temporary Pod on `proxmox-1-worker-1` pulled the digest with `imagePullPolicy: Always`, ran `node -p process.arch` (`x64`), had no `imagePullSecrets`, and was removed.
2. The image-only Deployment update created ReplicaSet `klaus-agent-6c7568cfb8` at `08:26:12Z`. `kubectl rollout status` succeeded with one ready replica and the `Recreate` strategy. The pod's `imageID` matched the GHCR digest; `/ready` returned HTTP 200 and persistence, capabilities, sessions, delivery, and Telegram were healthy.
3. A separate read-only MCP `initialize` and `tools/list` probe in the new pod discovered 11 Home Assistant tools and 36 Kaneo tools. Every configured Kaneo allowlisted tool was present. The application's `mcp.home` and `mcp.kaneo` health entries were degraded only because no active Pi MCP session had checked them; no Telegram conversation or action was sent as part of this release check.
4. `kubectl rollout restart` created replacement ReplicaSet `klaus-agent-67f49f8bfc` at `08:29:29Z`. It returned to one ready pod on the same digest. Aggregate counts before and after restart matched: 246 session entries, one memory note, 75 Telegram updates, and 77 outbox messages. No conversation content was read.

## Rollback state

This first cutover has neither a prior durable image nor a new data and Pi authentication backup, so rollback to the prior image and data state is unavailable. The ttl.sh image expires after 24 hours and is not a reliable rollback reference. Record the GHCR digest above as the previous durable image for the next release; take compatible backups before a later release that requires data rollback.
