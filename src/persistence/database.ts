import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const migrations = [
  `CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chats (
      chat_id TEXT PRIMARY KEY,
      chat_type TEXT NOT NULL,
      active_session_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS telegram_updates (
      update_id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      text TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('claimed','complete','failed','indeterminate')),
      failure TEXT,
      received_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS session_entries (
      session_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      entry_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (session_id, sequence)
    );
    CREATE TABLE IF NOT EXISTS tool_executions (
      id TEXT PRIMARY KEY,
      update_id TEXT,
      server_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      arguments_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('started','success','failure','timeout','cancelled','indeterminate')),
      result_json TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT
    );
    CREATE TABLE IF NOT EXISTS outbox_messages (
      id TEXT PRIMARY KEY,
      dedupe_key TEXT NOT NULL UNIQUE,
      chat_id TEXT NOT NULL,
      reply_to_message_id TEXT,
      sequence INTEGER NOT NULL,
      text TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending','leased','sent','cancelled')),
      attempts INTEGER NOT NULL DEFAULT 0,
      available_at TEXT NOT NULL,
      lease_until TEXT,
      telegram_message_id TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      sent_at TEXT
    );
    CREATE TABLE IF NOT EXISTS runtime_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS outbox_ready_idx
      ON outbox_messages(state, available_at, sequence);`,
  `CREATE TABLE chat_model_preferences (
      chat_id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      model_id TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (chat_id) REFERENCES chats(chat_id)
    );
    ALTER TABLE outbox_messages ADD COLUMN reply_markup_json TEXT;
    CREATE TABLE telegram_updates_v2 (
      update_id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      text TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('claimed','complete','failed','cancelled','indeterminate')),
      failure TEXT,
      received_at TEXT NOT NULL,
      completed_at TEXT
    );
    INSERT INTO telegram_updates_v2(
      update_id,chat_id,sender_id,message_id,text,state,failure,received_at,completed_at
    ) SELECT update_id,chat_id,sender_id,message_id,text,state,failure,received_at,completed_at
      FROM telegram_updates;
    DROP TABLE telegram_updates;
    ALTER TABLE telegram_updates_v2 RENAME TO telegram_updates;`,
] as const;

export class AppDatabase {
  readonly connection: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.connection = new DatabaseSync(path);
    this.connection.exec(
      "PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;",
    );
  }

  migrate(): void {
    this.connection.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
    );
    const insert = this.connection.prepare(
      "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)",
    );
    for (const [index, sql] of migrations.entries()) {
      const version = index + 1;
      const exists = this.connection
        .prepare("SELECT 1 AS found FROM schema_migrations WHERE version = ?")
        .get(version);
      if (exists) continue;
      this.connection.exec("BEGIN IMMEDIATE");
      try {
        this.connection.exec(sql);
        insert.run(version, new Date().toISOString());
        this.connection.exec("COMMIT");
      } catch (error) {
        this.connection.exec("ROLLBACK");
        throw error;
      }
    }
  }

  close(): void {
    this.connection.close();
  }
}
