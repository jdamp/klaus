import { randomUUID } from "node:crypto";

import type { AppDatabase } from "../../persistence/database.js";

export type PaperlessReceiptState =
  | "submitting"
  | "indeterminate"
  | "accepted"
  | "pending"
  | "started"
  | "consumed"
  | "failed"
  | "revoked"
  | "submission_failed";

export type PaperlessReceiptDetailCode =
  | "submission_claimed"
  | "accepted_by_paperless"
  | "restart_before_task_id_recorded"
  | "submission_outcome_unknown"
  | "submission_rejected"
  | "task_pending"
  | "task_started"
  | "task_consumed"
  | "task_failed"
  | "task_revoked"
  | "task_result_unverified"
  | "status_lookup_unavailable";

export type PaperlessUploadReceipt = {
  id: string;
  chatId: string;
  updateId: string;
  messageId: string;
  senderId: string;
  state: PaperlessReceiptState;
  taskId?: string;
  documentIds: number[];
  detailCode?: PaperlessReceiptDetailCode;
  createdAt: string;
  updatedAt: string;
};

export type PaperlessUploadIdentity = {
  updateId: string;
  attachmentKey: string;
  chatId: string;
  messageId: string;
  senderId: string;
};

type ReceiptRow = {
  id: string;
  chat_id: string;
  update_id: string;
  message_id: string;
  sender_id: string;
  state: PaperlessReceiptState;
  task_id: string | null;
  document_ids_json: string;
  detail_code: string | null;
  created_at: string;
  updated_at: string;
};

const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const DETAIL_CODES = new Set<PaperlessReceiptDetailCode>([
  "submission_claimed",
  "accepted_by_paperless",
  "restart_before_task_id_recorded",
  "submission_outcome_unknown",
  "submission_rejected",
  "task_pending",
  "task_started",
  "task_consumed",
  "task_failed",
  "task_revoked",
  "task_result_unverified",
  "status_lookup_unavailable",
]);

export class PaperlessUploadReceiptRepository {
  constructor(private readonly database: AppDatabase) {}

  claim(identity: PaperlessUploadIdentity): { receipt: PaperlessUploadReceipt; claimed: boolean } {
    validateIdentity(identity);
    const now = new Date().toISOString();
    const receiptId = randomUUID();
    const connection = this.database.connection;
    connection.exec("BEGIN IMMEDIATE");
    try {
      const inserted = connection
        .prepare(
          `INSERT OR IGNORE INTO paperless_upload_receipts(
            id,provider_id,update_id,attachment_key,chat_id,message_id,sender_id,state,
            document_ids_json,detail_code,created_at,updated_at
          ) VALUES (?,'paperless',?,?,?,?,?,'submitting','[]','submission_claimed',?,?)`,
        )
        .run(
          receiptId,
          identity.updateId,
          identity.attachmentKey,
          identity.chatId,
          identity.messageId,
          identity.senderId,
          now,
          now,
        );
      const row = connection
        .prepare(
          `SELECT id,chat_id,update_id,message_id,sender_id,state,task_id,
                  document_ids_json,detail_code,created_at,updated_at
           FROM paperless_upload_receipts
           WHERE provider_id='paperless' AND update_id=? AND attachment_key=?`,
        )
        .get(identity.updateId, identity.attachmentKey) as ReceiptRow | undefined;
      if (!row) throw new Error("Paperless upload receipt could not be claimed");
      connection.exec("COMMIT");
      return { receipt: toReceipt(row), claimed: Number(inserted.changes) === 1 };
    } catch (error) {
      connection.exec("ROLLBACK");
      throw error;
    }
  }

  findForChat(receiptId: string, chatId: string): PaperlessUploadReceipt | undefined {
    const row = this.database.connection
      .prepare(
        `SELECT id,chat_id,update_id,message_id,sender_id,state,task_id,
                document_ids_json,detail_code,created_at,updated_at
         FROM paperless_upload_receipts WHERE id=? AND chat_id=?`,
      )
      .get(receiptId, chatId) as ReceiptRow | undefined;
    return row ? toReceipt(row) : undefined;
  }

  markOrphanedSubmittingIndeterminate(): number {
    const result = this.database.connection
      .prepare(
        `UPDATE paperless_upload_receipts
         SET state='indeterminate',detail_code='restart_before_task_id_recorded',updated_at=?
         WHERE state='submitting'`,
      )
      .run(new Date().toISOString());
    return Number(result.changes);
  }

  markAccepted(receiptId: string, taskId: string): PaperlessUploadReceipt {
    if (!TASK_ID.test(taskId)) throw new Error("Invalid Paperless task identity");
    this.updateState(receiptId, ["submitting"], "accepted", "accepted_by_paperless", taskId, []);
    const receipt = this.findById(receiptId);
    if (!receipt) throw new Error("Paperless upload receipt was not found");
    return receipt;
  }

  markIndeterminate(
    receiptId: string,
    detailCode: Extract<
      PaperlessReceiptDetailCode,
      "submission_outcome_unknown" | "task_result_unverified"
    >,
  ): PaperlessUploadReceipt {
    this.updateState(
      receiptId,
      ["submitting", "accepted", "pending", "started"],
      "indeterminate",
      detailCode,
    );
    const receipt = this.findById(receiptId);
    if (!receipt) throw new Error("Paperless upload receipt was not found");
    return receipt;
  }

  markSubmissionFailed(receiptId: string): PaperlessUploadReceipt {
    this.updateState(receiptId, ["submitting"], "submission_failed", "submission_rejected");
    const receipt = this.findById(receiptId);
    if (!receipt) throw new Error("Paperless upload receipt was not found");
    return receipt;
  }

  recordTaskState(
    receiptId: string,
    state: Extract<
      PaperlessReceiptState,
      "pending" | "started" | "consumed" | "failed" | "revoked"
    >,
    detailCode: Extract<
      PaperlessReceiptDetailCode,
      "task_pending" | "task_started" | "task_consumed" | "task_failed" | "task_revoked"
    >,
    documentIds: readonly number[] = [],
  ): PaperlessUploadReceipt {
    const uniqueIds = [...new Set(documentIds)];
    if (uniqueIds.length > 100 || uniqueIds.some((id) => !Number.isSafeInteger(id) || id < 1)) {
      throw new Error("Invalid Paperless document references");
    }
    this.updateState(
      receiptId,
      ["accepted", "pending", "started", "consumed", "failed", "revoked"],
      state,
      detailCode,
      undefined,
      uniqueIds,
    );
    const receipt = this.findById(receiptId);
    if (!receipt) throw new Error("Paperless upload receipt was not found");
    return receipt;
  }

  private updateState(
    receiptId: string,
    allowedStates: readonly PaperlessReceiptState[],
    state: PaperlessReceiptState,
    detailCode: PaperlessReceiptDetailCode,
    taskId?: string,
    documentIds?: readonly number[],
  ): void {
    if (!DETAIL_CODES.has(detailCode)) throw new Error("Invalid Paperless receipt detail code");
    const placeholders = allowedStates.map(() => "?").join(",");
    const result = this.database.connection
      .prepare(
        `UPDATE paperless_upload_receipts
         SET state=?,detail_code=?,
             task_id=COALESCE(?,task_id),
             document_ids_json=COALESCE(?,document_ids_json),updated_at=?
         WHERE id=? AND state IN (${placeholders})`,
      )
      .run(
        state,
        detailCode,
        taskId ?? null,
        documentIds === undefined ? null : JSON.stringify(documentIds),
        new Date().toISOString(),
        receiptId,
        ...allowedStates,
      );
    if (Number(result.changes) !== 1) throw new Error("Invalid Paperless receipt state transition");
  }

  private findById(receiptId: string): PaperlessUploadReceipt | undefined {
    const row = this.database.connection
      .prepare(
        `SELECT id,chat_id,update_id,message_id,sender_id,state,task_id,
                document_ids_json,detail_code,created_at,updated_at
         FROM paperless_upload_receipts WHERE id=?`,
      )
      .get(receiptId) as ReceiptRow | undefined;
    return row ? toReceipt(row) : undefined;
  }
}

function validateIdentity(identity: PaperlessUploadIdentity): void {
  for (const [name, value, maximum] of [
    ["updateId", identity.updateId, 128],
    ["attachmentKey", identity.attachmentKey, 64],
    ["chatId", identity.chatId, 128],
    ["messageId", identity.messageId, 128],
    ["senderId", identity.senderId, 128],
  ] as const) {
    if (typeof value !== "string" || !value || value.length > maximum) {
      throw new Error(`Invalid Paperless receipt ${name}`);
    }
  }
  if (!/^[a-f0-9]{64}$/u.test(identity.attachmentKey)) {
    throw new Error("Invalid Paperless attachment identity");
  }
}

function toReceipt(row: ReceiptRow): PaperlessUploadReceipt {
  const documentIds = JSON.parse(row.document_ids_json) as unknown;
  if (
    !Array.isArray(documentIds) ||
    documentIds.some((id) => !Number.isSafeInteger(id) || id < 1)
  ) {
    throw new Error("Stored Paperless document references are invalid");
  }
  return {
    id: row.id,
    chatId: row.chat_id,
    updateId: row.update_id,
    messageId: row.message_id,
    senderId: row.sender_id,
    state: row.state,
    ...(row.task_id ? { taskId: row.task_id } : {}),
    documentIds: documentIds as number[],
    ...(row.detail_code && DETAIL_CODES.has(row.detail_code as PaperlessReceiptDetailCode)
      ? { detailCode: row.detail_code as PaperlessReceiptDetailCode }
      : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
