import { randomUUID } from "node:crypto";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import { isInlineKeyboardMarkup, type TelegramInlineKeyboardMarkup } from "../telegram/types.js";
import type { AppDatabase } from "./database.js";

export type AcceptedUpdate = {
  updateId: string;
  chatId: string;
  senderId: string;
  messageId: string;
  text: string;
};

export class StateRepository {
  constructor(private readonly database: AppDatabase) {}

  get(key: string): string | undefined {
    const row = this.database.connection
      .prepare("SELECT value FROM runtime_state WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row?.value;
  }

  set(key: string, value: string): void {
    this.database.connection
      .prepare(
        "INSERT INTO runtime_state(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, value);
  }
}

export class ChatRepository {
  constructor(private readonly database: AppDatabase) {}

  ensure(chatId: string, chatType: string): string {
    const now = new Date().toISOString();
    const sessionId = randomUUID();
    this.database.connection
      .prepare(
        `INSERT OR IGNORE INTO chats(chat_id,chat_type,active_session_id,created_at,updated_at)
         VALUES (?,?,?,?,?)`,
      )
      .run(chatId, chatType, sessionId, now, now);
    return this.activeSession(chatId);
  }

  activeSession(chatId: string): string {
    const row = this.database.connection
      .prepare("SELECT active_session_id FROM chats WHERE chat_id = ?")
      .get(chatId) as { active_session_id: string } | undefined;
    if (!row) throw new Error(`Unknown chat: ${chatId}`);
    return row.active_session_id;
  }

  newSession(chatId: string): string {
    const sessionId = randomUUID();
    const changed = this.database.connection
      .prepare("UPDATE chats SET active_session_id=?, updated_at=? WHERE chat_id=?")
      .run(sessionId, new Date().toISOString(), chatId);
    if (changed.changes !== 1) throw new Error(`Unknown chat: ${chatId}`);
    return sessionId;
  }

  modelPreference(chatId: string): { provider: string; modelId: string } | undefined {
    const row = this.database.connection
      .prepare("SELECT provider,model_id FROM chat_model_preferences WHERE chat_id=?")
      .get(chatId) as { provider: string; model_id: string } | undefined;
    return row ? { provider: row.provider, modelId: row.model_id } : undefined;
  }

  setModelPreference(chatId: string, provider: string, modelId: string): void {
    const changed = this.database.connection
      .prepare(
        `INSERT INTO chat_model_preferences(chat_id,provider,model_id,updated_at)
         VALUES (?,?,?,?)
         ON CONFLICT(chat_id) DO UPDATE SET
           provider=excluded.provider,model_id=excluded.model_id,updated_at=excluded.updated_at`,
      )
      .run(chatId, provider, modelId, new Date().toISOString());
    if (changed.changes !== 1) throw new Error(`Could not store model preference: ${chatId}`);
  }
}

export class UpdateRepository {
  constructor(private readonly database: AppDatabase) {}

  claim(update: AcceptedUpdate): boolean {
    const result = this.database.connection
      .prepare(
        `INSERT OR IGNORE INTO telegram_updates(
          update_id,chat_id,sender_id,message_id,text,state,received_at
        ) VALUES (?,?,?,?,?,'claimed',?)`,
      )
      .run(
        update.updateId,
        update.chatId,
        update.senderId,
        update.messageId,
        update.text,
        new Date().toISOString(),
      );
    return result.changes === 1;
  }

  finish(
    updateId: string,
    state: "complete" | "failed" | "cancelled" | "indeterminate",
    failure?: string,
  ): void {
    this.database.connection
      .prepare(
        "UPDATE telegram_updates SET state=?,failure=?,completed_at=? WHERE update_id=? AND state='claimed'",
      )
      .run(state, failure ?? null, new Date().toISOString(), updateId);
  }

  markInterruptedIndeterminate(): number {
    const result = this.database.connection
      .prepare(
        `UPDATE telegram_updates
         SET state='indeterminate',failure=?,completed_at=?
         WHERE state='claimed'`,
      )
      .run("Interrupted before completion; automatic replay is disabled", new Date().toISOString());
    return Number(result.changes);
  }
}

export class SessionEntryRepository {
  constructor(private readonly database: AppDatabase) {}

  replace(sessionId: string, entries: readonly SessionEntry[]): void {
    this.database.connection.exec("BEGIN IMMEDIATE");
    try {
      this.database.connection
        .prepare("DELETE FROM session_entries WHERE session_id=?")
        .run(sessionId);
      const insert = this.database.connection.prepare(
        "INSERT INTO session_entries(session_id,sequence,entry_json,created_at) VALUES (?,?,?,?)",
      );
      entries.forEach((entry, sequence) => {
        insert.run(sessionId, sequence, JSON.stringify(entry), new Date().toISOString());
      });
      this.database.connection.exec("COMMIT");
    } catch (error) {
      this.database.connection.exec("ROLLBACK");
      throw error;
    }
  }

  load(sessionId: string): SessionEntry[] {
    const rows = this.database.connection
      .prepare("SELECT entry_json FROM session_entries WHERE session_id=? ORDER BY sequence")
      .all(sessionId) as Array<{ entry_json: string }>;
    return rows.map((row) => JSON.parse(row.entry_json) as SessionEntry);
  }
}

export type ToolOutcome = "success" | "failure" | "timeout" | "cancelled" | "indeterminate";

export class ToolAuditRepository {
  constructor(private readonly database: AppDatabase) {}

  start(serverId: string, toolName: string, argumentsValue: unknown, updateId?: string): string {
    const id = randomUUID();
    this.database.connection
      .prepare(
        `INSERT INTO tool_executions(
          id,update_id,server_id,tool_name,arguments_json,status,started_at
        ) VALUES (?,?,?,?,?,'started',?)`,
      )
      .run(
        id,
        updateId ?? null,
        serverId,
        toolName,
        JSON.stringify(argumentsValue),
        new Date().toISOString(),
      );
    return id;
  }

  finish(id: string, status: ToolOutcome, result?: unknown): void {
    this.database.connection
      .prepare(
        "UPDATE tool_executions SET status=?,result_json=?,finished_at=? WHERE id=? AND status='started'",
      )
      .run(
        status,
        result === undefined ? null : JSON.stringify(result),
        new Date().toISOString(),
        id,
      );
  }

  markInterruptedIndeterminate(): number {
    const result = this.database.connection
      .prepare(
        "UPDATE tool_executions SET status='indeterminate',finished_at=? WHERE status='started'",
      )
      .run(new Date().toISOString());
    return Number(result.changes);
  }
}

export type OutboxDraft = {
  id?: string;
  dedupeKey: string;
  chatId: string;
  replyToMessageId?: string;
  sequence: number;
  text: string;
  replyMarkup?: TelegramInlineKeyboardMarkup;
  availableAt?: Date;
};

export type LeasedOutboxMessage = {
  id: string;
  chatId: string;
  replyToMessageId?: string;
  sequence: number;
  text: string;
  replyMarkup?: TelegramInlineKeyboardMarkup;
  attempts: number;
};

export class OutboxRepository {
  constructor(private readonly database: AppDatabase) {}

  enqueue(draft: OutboxDraft): boolean {
    if (draft.replyMarkup && !isInlineKeyboardMarkup(draft.replyMarkup)) {
      throw new Error("Invalid Telegram inline keyboard");
    }
    const result = this.database.connection
      .prepare(
        `INSERT OR IGNORE INTO outbox_messages(
          id,dedupe_key,chat_id,reply_to_message_id,sequence,text,reply_markup_json,state,available_at,created_at
        ) VALUES (?,?,?,?,?,?,?,'pending',?,?)`,
      )
      .run(
        draft.id ?? randomUUID(),
        draft.dedupeKey,
        draft.chatId,
        draft.replyToMessageId ?? null,
        draft.sequence,
        draft.text,
        draft.replyMarkup ? JSON.stringify(draft.replyMarkup) : null,
        (draft.availableAt ?? new Date()).toISOString(),
        new Date().toISOString(),
      );
    return result.changes === 1;
  }

  lease(now: Date, leaseMs: number): LeasedOutboxMessage | undefined {
    this.database.connection.exec("BEGIN IMMEDIATE");
    try {
      this.database.connection
        .prepare(
          "UPDATE outbox_messages SET state='pending',lease_until=NULL WHERE state='leased' AND lease_until<=?",
        )
        .run(now.toISOString());
      const row = this.database.connection
        .prepare(
          `SELECT id,chat_id,reply_to_message_id,sequence,text,reply_markup_json,attempts
           FROM outbox_messages
           WHERE state='pending' AND available_at<=?
           ORDER BY created_at,sequence LIMIT 1`,
        )
        .get(now.toISOString()) as
        | {
            id: string;
            chat_id: string;
            reply_to_message_id: string | null;
            sequence: number;
            text: string;
            reply_markup_json: string | null;
            attempts: number;
          }
        | undefined;
      if (!row) {
        this.database.connection.exec("COMMIT");
        return undefined;
      }
      this.database.connection
        .prepare(
          "UPDATE outbox_messages SET state='leased',attempts=attempts+1,lease_until=? WHERE id=?",
        )
        .run(new Date(now.getTime() + leaseMs).toISOString(), row.id);
      this.database.connection.exec("COMMIT");
      return {
        id: row.id,
        chatId: row.chat_id,
        ...(row.reply_to_message_id ? { replyToMessageId: row.reply_to_message_id } : {}),
        sequence: row.sequence,
        text: row.text,
        ...(row.reply_markup_json
          ? { replyMarkup: this.#parseReplyMarkup(row.reply_markup_json) }
          : {}),
        attempts: row.attempts + 1,
      };
    } catch (error) {
      this.database.connection.exec("ROLLBACK");
      throw error;
    }
  }

  #parseReplyMarkup(serialized: string): TelegramInlineKeyboardMarkup {
    const parsed: unknown = JSON.parse(serialized);
    if (!isInlineKeyboardMarkup(parsed)) throw new Error("Invalid stored Telegram inline keyboard");
    return parsed;
  }

  sent(id: string, telegramMessageId: string): void {
    this.database.connection
      .prepare(
        "UPDATE outbox_messages SET state='sent',telegram_message_id=?,sent_at=?,lease_until=NULL WHERE id=? AND state='leased'",
      )
      .run(telegramMessageId, new Date().toISOString(), id);
  }

  retry(id: string, availableAt: Date, error: string): void {
    this.database.connection
      .prepare(
        "UPDATE outbox_messages SET state='pending',available_at=?,last_error=?,lease_until=NULL WHERE id=? AND state='leased'",
      )
      .run(availableAt.toISOString(), error, id);
  }

  cancel(id: string): void {
    this.database.connection
      .prepare("UPDATE outbox_messages SET state='cancelled',lease_until=NULL WHERE id=?")
      .run(id);
  }
}
