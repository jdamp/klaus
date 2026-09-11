import type { AppDatabase } from "./database.js";

export class MaintenanceRepository {
  constructor(private readonly database: AppDatabase) {}

  run(cutoff: Date): void {
    const value = cutoff.toISOString();
    this.database.connection.exec("BEGIN IMMEDIATE");
    try {
      this.database.connection
        .prepare(
          `DELETE FROM session_entries
           WHERE created_at < ?
             AND session_id NOT IN (SELECT active_session_id FROM chats)`,
        )
        .run(value);
      this.database.connection
        .prepare(
          `UPDATE telegram_updates SET text='',failure=NULL
           WHERE received_at < ? AND state IN ('complete','failed','indeterminate')`,
        )
        .run(value);
      this.database.connection
        .prepare(
          `UPDATE tool_executions SET arguments_json='{}',result_json=NULL
           WHERE started_at < ? AND status <> 'started'`,
        )
        .run(value);
      this.database.connection
        .prepare(
          `UPDATE outbox_messages SET text='',last_error=NULL
           WHERE created_at < ? AND state IN ('sent','cancelled')`,
        )
        .run(value);
      this.database.connection.exec("COMMIT");
    } catch (error) {
      this.database.connection.exec("ROLLBACK");
      throw error;
    }
  }
}
