# Database operations

SQLite is the source of truth for accepted Telegram updates, Pi session entries, tool audit
metadata, Telegram outbox state, and the shared notebook (notes, overview, revisions, mutation
receipts, and derived FTS index). Pi provider authentication is a separate mutable store and must
be backed up independently with filesystem permissions preserved.

## Backup

The online backup command uses SQLite's backup API, so it produces a consistent snapshot while the
service is running in WAL mode:

```sh
node --experimental-sqlite dist/src/cli.js db backup \
  --config /etc/klaus-agent/config.yaml \
  --destination /backups/klaus-2026-09-11.sqlite
```

The command refuses to overwrite an existing file and runs an integrity check on the result. Copy
the SQLite backup and the Pi authentication volume to protected storage. Never put either in source
control.

## Restore

1. Stop Klaus Agent so no Telegram poller, model turn, MCP call, or outbox worker is active.
2. Preserve the current data volume for rollback; do not overwrite it.
3. Point a configuration file at a fresh empty data directory.
4. Restore and start:

   ```sh
   node --experimental-sqlite dist/src/cli.js db restore \
     --config /etc/klaus-agent/restore-config.yaml \
     --backup /backups/klaus-2026-09-11.sqlite
   node --experimental-sqlite dist/src/cli.js --config /etc/klaus-agent/restore-config.yaml
   ```

5. Confirm `/ready`, chat-session continuity, pending outbox state, tool audit history, `/memory`
   listing/exact reads, overview revision, and search before switching the production volume
   reference. Startup reconstructs the derived notebook search index from canonical note rows.

Restore refuses to overwrite an existing database and verifies SQLite integrity before and after
the copy.

## Migration and upgrade

Migrations run transactionally and idempotently at startup before Telegram polling begins.
The initial memory migration creates an empty revision-1 `overview` only when absent; it never
repopulates an overview that a participant cleared.

1. Record the current image digest and configuration revision.
2. Run the quality and migration suites for the target version.
3. Back up SQLite and Pi authentication state.
4. Stop the existing single replica.
5. Start the new image against the existing volumes.
6. Confirm the schema version, readiness, session continuity, one authorized conversation, and
   outbox delivery.

Inspect schema versions without exposing conversation content:

```sh
sqlite3 /var/lib/klaus-agent/klaus.sqlite \
  'SELECT version, applied_at FROM schema_migrations ORDER BY version;'
```

## Rollback

If the previous image supports the current schema, stop the new pod and redeploy the previously
recorded image digest against the same volumes.

If a migration is not backward-compatible:

1. Stop the new pod.
2. Retain the upgraded volume for investigation.
3. Provision a fresh data volume.
4. Restore the pre-upgrade SQLite snapshot into it.
5. Restore the matching Pi authentication backup if provider state changed.
6. Deploy the previous image and configuration against those restored volumes.
7. Verify readiness and perform the staged authorization and delivery checks.

A release that changes Telegram commands also changes command metadata stored by Telegram outside
the application volumes. Before rolling back to an image that does not synchronize or implement the
new catalogue, use BotFather to restore the previous default, private-chat, and group-chat command
scopes, or delete those scopes. Otherwise Telegram can continue advertising commands the rolled-back
binary cannot handle. This metadata cleanup does not alter chat authorization.

Never copy only the main SQLite file from a running WAL database. Use the application backup
command so committed WAL pages are included.
