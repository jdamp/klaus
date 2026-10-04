import { createHash } from "node:crypto";

import { NativeToolError } from "../../capabilities/execution.js";
import type { TrustedTurnContext } from "../../agent/turn-context.js";
import { PaperlessHttpError, type PaperlessClient } from "./client.js";
import type { PaperlessDocumentService } from "./documents.js";
import type { PaperlessOrganizerService } from "./organizers.js";
import type {
  PaperlessUploadReceiptRepository,
  PaperlessReceiptState,
  PaperlessUploadReceipt,
} from "./receipts.js";
import type { TelegramUploadFileLoader } from "../../telegram/upload-file.js";
import { asRecord } from "./types.js";

type OrganizerReference = string | number;

export type PaperlessUploadInput = {
  title?: string;
  created?: string;
  tags?: OrganizerReference[];
  correspondent?: OrganizerReference;
  documentType?: OrganizerReference;
};

export type PaperlessUploadResult = {
  receiptId: string;
  state: PaperlessReceiptState;
  taskId?: string;
  documentIds: number[];
  detailCode?: string;
  statusCheck?: "unavailable";
  documents?: Array<{ id: number; title: string }>;
  message: string;
};

const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const taskStatuses = ["pending", "started", "success", "failure", "revoked"] as const;
type PaperlessTaskStatus = (typeof taskStatuses)[number];

type PaperlessTask = {
  taskId: string;
  status: PaperlessTaskStatus;
  documentIds: number[];
};

export class PaperlessUploadService {
  constructor(
    private readonly client: PaperlessClient,
    private readonly documents: PaperlessDocumentService,
    private readonly organizers: PaperlessOrganizerService,
    private readonly receipts: PaperlessUploadReceiptRepository,
    private readonly fileLoader: TelegramUploadFileLoader,
  ) {}

  async submit(
    context: TrustedTurnContext,
    input: PaperlessUploadInput,
    signal: AbortSignal,
  ): Promise<PaperlessUploadResult> {
    const attachment = context.uploadAttachment;
    if (!attachment) throw new Error("No supported attachment is available in this Telegram turn");
    if (signal.aborted)
      throw new NativeToolError("Upload was cancelled before submission", "cancelled");
    const attachmentKey = attachmentIdentity(attachment);
    const prior = this.receipts.findByIdentity(context.updateId, attachmentKey);
    if (prior) {
      if (prior.chatId !== context.chatId || prior.senderId !== context.senderId) {
        throw new Error("Paperless upload receipt origin does not match this trusted turn");
      }
      return this.#duplicateResult(prior);
    }

    const metadata = await this.#resolveMetadata(input, signal);
    if (signal.aborted)
      throw new NativeToolError("Upload was cancelled before submission", "cancelled");
    const file = await this.fileLoader.load(attachment, signal);
    try {
      if (signal.aborted)
        throw new NativeToolError("Upload was cancelled before submission", "cancelled");
      const claimed = this.receipts.claim({
        updateId: context.updateId,
        attachmentKey,
        chatId: context.chatId,
        messageId: context.messageId,
        senderId: context.senderId,
      });
      if (!claimed.claimed) return this.#duplicateResult(claimed.receipt);

      if (signal.aborted) {
        const failed = this.receipts.markSubmissionFailed(
          claimed.receipt.id,
          "submission_not_dispatched",
        );
        return resultFromReceipt(failed);
      }

      let response: { body: unknown; apiVersion?: string; serverVersion?: string };
      try {
        response = await this.client.uploadDocument(file, metadata, signal);
      } catch (error) {
        if (error instanceof PaperlessHttpError && isDefinitiveRejection(error.status)) {
          return resultFromReceipt(this.receipts.markSubmissionFailed(claimed.receipt.id));
        }
        const uncertain = this.receipts.markIndeterminate(
          claimed.receipt.id,
          "submission_outcome_unknown",
        );
        throw new NativeToolError(
          "Paperless may have accepted this upload, but Klaus did not receive a verifiable task receipt. Do not retry automatically.",
          "indeterminate",
          resultFromReceipt(uncertain),
        );
      }

      const taskId =
        response.apiVersion === "10" && response.serverVersion
          ? taskIdentity(response.body)
          : undefined;
      if (!taskId) {
        const uncertain = this.receipts.markIndeterminate(
          claimed.receipt.id,
          "submission_outcome_unknown",
        );
        throw new NativeToolError(
          "Paperless returned an unrecognized upload receipt; the remote outcome is uncertain. Do not retry automatically.",
          "indeterminate",
          resultFromReceipt(uncertain),
        );
      }

      try {
        return resultFromReceipt(this.receipts.markAccepted(claimed.receipt.id, taskId));
      } catch {
        try {
          this.receipts.markIndeterminate(claimed.receipt.id, "submission_outcome_unknown", taskId);
        } catch {
          // The returned result still identifies the known remote task without claiming persistence.
        }
        throw new NativeToolError(
          "Paperless accepted the upload, but Klaus could not persist its task receipt. The remote task was not cancelled; do not retry.",
          "indeterminate",
          {
            receiptId: claimed.receipt.id,
            state: "indeterminate",
            taskId,
            documentIds: [],
            detailCode: "submission_outcome_unknown",
            message: "Paperless may be processing the upload; do not submit this attachment again.",
          },
        );
      }
    } finally {
      file.bytes.fill(0);
    }
  }

  async status(
    context: TrustedTurnContext,
    receiptId: string,
    signal: AbortSignal,
  ): Promise<PaperlessUploadResult> {
    const receipt = this.receipts.findForChat(receiptId, context.chatId);
    if (!receipt) throw new Error("Paperless receipt was not found in this chat");
    if (!receipt.taskId) return resultFromReceipt(receipt);

    let task: PaperlessTask | undefined;
    try {
      task = await this.#findTask(receipt.taskId, signal);
    } catch {
      return {
        ...resultFromReceipt(receipt),
        statusCheck: "unavailable",
        message:
          "Paperless status could not be checked. The saved receipt state is unchanged; try again later.",
      };
    }
    if (!task) return resultFromReceipt(receipt);

    if (task.status === "pending") {
      return resultFromReceipt(
        this.receipts.recordTaskState(receipt.id, "pending", "task_pending"),
      );
    }
    if (task.status === "started") {
      return resultFromReceipt(
        this.receipts.recordTaskState(receipt.id, "started", "task_started"),
      );
    }
    if (task.status === "failure") {
      return resultFromReceipt(this.receipts.recordTaskState(receipt.id, "failed", "task_failed"));
    }
    if (task.status === "revoked") {
      return resultFromReceipt(
        this.receipts.recordTaskState(receipt.id, "revoked", "task_revoked"),
      );
    }
    if (task.documentIds.length === 0) {
      return resultFromReceipt(
        this.receipts.markIndeterminate(
          receipt.id,
          "task_result_unverified",
          receipt.taskId,
          task.documentIds,
        ),
      );
    }

    try {
      const verified = await Promise.all(
        task.documentIds.map((id) => this.documents.verifyReadable(id, signal)),
      );
      return {
        ...resultFromReceipt(
          this.receipts.recordTaskState(receipt.id, "consumed", "task_consumed", task.documentIds),
        ),
        documents: verified,
        message: "Paperless consumed the upload and the resulting document is readable.",
      };
    } catch (error) {
      if (error instanceof PaperlessHttpError && [403, 404].includes(error.status)) {
        return resultFromReceipt(
          this.receipts.markIndeterminate(
            receipt.id,
            "task_result_unverified",
            receipt.taskId,
            task.documentIds,
          ),
        );
      }
      const uncertain = this.receipts.markIndeterminate(
        receipt.id,
        "task_result_unverified",
        receipt.taskId,
        task.documentIds,
      );
      return {
        ...resultFromReceipt(uncertain),
        ...(signal.aborted ? { statusCheck: "unavailable" as const } : {}),
        message:
          "Paperless reported task success, but Klaus could not verify access to the resulting document. The receipt and document IDs are saved; check status again, but do not resubmit.",
      };
    }
  }

  async #findTask(taskId: string, signal: AbortSignal): Promise<PaperlessTask | undefined> {
    const records: unknown[] = [];
    let expectedCount: number | undefined;
    for (let page = 1; page <= 10; page += 1) {
      const response = await this.client.findTask(taskId, page, signal);
      if (response.apiVersion !== "10" || !response.serverVersion) {
        throw new Error("Paperless task API v10 compatibility is unverified");
      }
      const body = asRecord(response.body);
      if (
        !Number.isSafeInteger(body.count) ||
        (body.count as number) < 0 ||
        !Array.isArray(body.results) ||
        body.results.length > 10
      ) {
        throw new Error("Paperless task response is incompatible");
      }
      const count = body.count as number;
      if (expectedCount !== undefined && count !== expectedCount) {
        throw new Error("Paperless task pagination count changed");
      }
      expectedCount = count;
      if (body.results.length === 0) return undefined;
      for (const record of body.results as unknown[]) records.push(record);
      if (records.length >= count) {
        return matchingTask({ count: records.length, results: records }, taskId);
      }
    }
    throw new Error("Paperless task lookup exceeded its bounded page limit");
  }

  #duplicateResult(receipt: PaperlessUploadReceipt): PaperlessUploadResult {
    const result = resultFromReceipt(receipt);
    if (receipt.state === "indeterminate" || receipt.state === "submitting") {
      throw new NativeToolError(
        "This attachment already has an uncertain or active Paperless submission; do not retry it automatically.",
        "indeterminate",
        result,
      );
    }
    return result;
  }

  async #resolveMetadata(
    input: PaperlessUploadInput,
    signal: AbortSignal,
  ): Promise<Record<string, string | number | readonly number[] | undefined>> {
    const metadata: Record<string, string | number | readonly number[] | undefined> = {};
    if (input.title !== undefined) {
      if (
        typeof input.title !== "string" ||
        !input.title.trim() ||
        input.title.trim().length > 512
      ) {
        throw new Error("Document title must be 1 to 512 characters");
      }
      metadata.title = input.title.trim();
    }
    if (input.created !== undefined) {
      validateCreatedDate(input.created);
      metadata.created = input.created;
    }
    if (input.tags !== undefined) {
      if (!Array.isArray(input.tags) || input.tags.length > 20) throw new Error("Invalid tags");
      const resolved = await Promise.all(
        input.tags.map((reference) => this.organizers.resolve("tag", reference, signal)),
      );
      metadata.tags = [...new Set(resolved.map(({ id }) => id))];
    }
    if (input.correspondent !== undefined) {
      metadata.correspondent = (
        await this.organizers.resolve("correspondent", input.correspondent, signal)
      ).id;
    }
    if (input.documentType !== undefined) {
      metadata.document_type = (
        await this.organizers.resolve("document_type", input.documentType, signal)
      ).id;
    }
    return metadata;
  }
}

function attachmentIdentity(
  attachment: NonNullable<TrustedTurnContext["uploadAttachment"]>,
): string {
  const fileIds =
    attachment.kind === "document"
      ? [attachment.document.file_id]
      : attachment.variants.map(({ file_id }) => file_id).sort();
  return createHash("sha256")
    .update(`${attachment.kind}\n${fileIds.join("\n")}`)
    .digest("hex");
}

function taskIdentity(body: unknown): string | undefined {
  const taskId = asRecord(body).task_id;
  return typeof taskId === "string" && TASK_ID.test(taskId) ? taskId.toLowerCase() : undefined;
}

function matchingTask(body: unknown, expectedTaskId: string): PaperlessTask | undefined {
  const page = asRecord(body);
  if (
    !Number.isSafeInteger(page.count) ||
    !Array.isArray(page.results) ||
    page.results.length > 100
  ) {
    throw new Error("Paperless task response is incompatible");
  }
  const matches: PaperlessTask[] = [];
  for (const value of page.results) {
    const record = asRecord(value);
    if (typeof record.task_id !== "string" || !TASK_ID.test(record.task_id)) {
      throw new Error("Paperless task response has an invalid identity");
    }
    if (record.task_id.toLowerCase() !== expectedTaskId.toLowerCase()) continue;
    if (
      typeof record.status !== "string" ||
      !taskStatuses.includes(record.status as PaperlessTaskStatus)
    ) {
      throw new Error("Paperless task response has an unknown status");
    }
    const documentIds =
      record.related_document_ids === undefined || record.related_document_ids === null
        ? []
        : record.related_document_ids;
    if (
      !Array.isArray(documentIds) ||
      documentIds.some((id) => !Number.isSafeInteger(id) || id < 1)
    ) {
      throw new Error("Paperless task response has invalid document references");
    }
    matches.push({
      taskId: record.task_id.toLowerCase(),
      status: record.status as PaperlessTaskStatus,
      documentIds: [...new Set(documentIds as number[])].sort((left, right) => left - right),
    });
  }
  if (matches.length === 0) return undefined;
  const first = matches[0]!;
  if (
    matches.some(
      (task) => task.status !== first.status || !sameIds(task.documentIds, first.documentIds),
    )
  ) {
    throw new Error("Paperless returned conflicting task outcomes");
  }
  return first;
}

function resultFromReceipt(receipt: PaperlessUploadReceipt): PaperlessUploadResult {
  return {
    receiptId: receipt.id,
    state: receipt.state,
    ...(receipt.taskId ? { taskId: receipt.taskId } : {}),
    documentIds: receipt.documentIds,
    ...(receipt.detailCode ? { detailCode: receipt.detailCode } : {}),
    message: stateMessage(receipt.state),
  };
}

function stateMessage(state: PaperlessReceiptState): string {
  switch (state) {
    case "submitting":
      return "This attachment already has a submission in progress; do not retry it.";
    case "indeterminate":
      return "Paperless may have accepted this upload. Check the receipt status; do not retry automatically.";
    case "accepted":
      return "Paperless accepted the upload request. This does not mean document processing is complete.";
    case "pending":
    case "started":
      return "Paperless is processing the upload; the document is not confirmed as consumed yet.";
    case "consumed":
      return "Paperless consumed the upload and a readable document was verified.";
    case "failed":
      return "Paperless reported that document processing failed.";
    case "revoked":
      return "Paperless revoked the document-processing task.";
    case "submission_failed":
      return "Paperless rejected the upload request; it was not accepted.";
  }
}

function isDefinitiveRejection(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408;
}

function validateCreatedDate(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw new Error("Invalid created date; use YYYY-MM-DD");
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error("Invalid created date; use a real calendar date");
  }
}

function sameIds(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}
