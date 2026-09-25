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
  `ALTER TABLE outbox_messages ADD COLUMN parse_mode TEXT CHECK (parse_mode IS NULL OR parse_mode='HTML');`,
  `CREATE TABLE IF NOT EXISTS tool_executions (
      id TEXT PRIMARY KEY,
      update_id TEXT,
      server_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      arguments_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('started','success','failure','timeout','cancelled','indeterminate','partial')),
      result_json TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT
    );
    CREATE TABLE tool_executions_v2 (
      id TEXT PRIMARY KEY,
      update_id TEXT,
      server_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      arguments_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('started','success','failure','timeout','cancelled','indeterminate','partial')),
      result_json TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT
    );
    INSERT INTO tool_executions_v2 SELECT * FROM tool_executions;
    DROP TABLE tool_executions;
    ALTER TABLE tool_executions_v2 RENAME TO tool_executions;`,
  `CREATE TABLE memory_notes (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      tags_json TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision > 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      source_sender_id TEXT,
      source_update_id TEXT,
      source_description TEXT
    );
    CREATE TABLE memory_mutations (
      update_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      operation TEXT NOT NULL CHECK (operation IN ('save','delete')),
      target_id TEXT NOT NULL,
      outcome_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (update_id, tool_call_id)
    );
    CREATE VIRTUAL TABLE memory_notes_fts USING fts5(
      id UNINDEXED,
      title,
      tags,
      body,
      tokenize='unicode61 remove_diacritics 2'
    );
    CREATE TRIGGER memory_notes_fts_insert AFTER INSERT ON memory_notes BEGIN
      INSERT INTO memory_notes_fts(id,title,tags,body)
      VALUES (new.id,new.title,new.tags_json,new.body);
    END;
    CREATE TRIGGER memory_notes_fts_update AFTER UPDATE ON memory_notes BEGIN
      DELETE FROM memory_notes_fts WHERE id=old.id;
      INSERT INTO memory_notes_fts(id,title,tags,body)
      VALUES (new.id,new.title,new.tags_json,new.body);
    END;
    CREATE TRIGGER memory_notes_fts_delete AFTER DELETE ON memory_notes BEGIN
      DELETE FROM memory_notes_fts WHERE id=old.id;
    END;
    INSERT OR IGNORE INTO memory_notes(
      id,title,body,tags_json,revision,created_at,updated_at
    ) VALUES ('overview','Overview','','[]',1,datetime('now'),datetime('now'));`,
  `UPDATE memory_notes
     SET title='Overview',
         revision=revision+1,
         updated_at=datetime('now')
     WHERE id='overview' AND title='Household overview';`,
  `ALTER TABLE outbox_messages ADD COLUMN delivery_kind TEXT NOT NULL DEFAULT 'text'
      CHECK (delivery_kind IN ('text','photo'));
    ALTER TABLE outbox_messages ADD COLUMN media_blob BLOB;
    ALTER TABLE outbox_messages ADD COLUMN media_type TEXT
      CHECK (media_type IS NULL OR media_type IN ('image/png','image/jpeg'));`,
  `ALTER TABLE tool_executions ADD COLUMN tool_call_id TEXT;`,
  `CREATE INDEX IF NOT EXISTS outbox_pending_order_idx
      ON outbox_messages(state, created_at, sequence);`,
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
