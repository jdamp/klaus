export type TelegramEntity = {
  type: string;
  offset: number;
  length: number;
  user?: TelegramUser;
};

export type TelegramUser = {
  id: number;
  is_bot?: boolean;
  username?: string;
};

export type TelegramChat = {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
};

export type TelegramMessage = {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  text?: string;
  entities?: TelegramEntity[];
  reply_to_message?: {
    message_id?: number;
    from?: TelegramUser;
    chat?: TelegramChat;
  };
};

export type TelegramCallbackQuery = {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
};

export type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
};

export type BotIdentity = {
  id: string;
  username: string;
};

export type TelegramInlineKeyboardButton = {
  text: string;
  callback_data: string;
};

export type TelegramInlineKeyboardMarkup = {
  inline_keyboard: TelegramInlineKeyboardButton[][];
};

export function isInlineKeyboardMarkup(value: unknown): value is TelegramInlineKeyboardMarkup {
  if (!value || typeof value !== "object") return false;
  const rows = (value as { inline_keyboard?: unknown }).inline_keyboard;
  if (!Array.isArray(rows) || rows.length === 0) return false;
  return rows.every(
    (row) =>
      Array.isArray(row) &&
      row.length > 0 &&
      row.every(
        (button) =>
          button !== null &&
          typeof button === "object" &&
          typeof (button as { text?: unknown }).text === "string" &&
          (button as { text: string }).text.length > 0 &&
          typeof (button as { callback_data?: unknown }).callback_data === "string" &&
          Buffer.byteLength((button as { callback_data: string }).callback_data) <= 64,
      ),
  );
}

export type TelegramCommandName =
  "start" | "help" | "status" | "model" | "compact" | "stop" | "new" | "unknown";

export type ParsedTelegramCommand = {
  name: TelegramCommandName;
  rawName: string;
  arguments: string;
};

type AcceptedTelegramInputBase = {
  updateId: string;
  chatId: string;
  chatType: TelegramChat["type"];
  senderId: string;
  messageId: string;
  text: string;
};

export type AcceptedTelegramInput = AcceptedTelegramInputBase &
  (
    | { kind: "message" }
    | { kind: "command"; command: ParsedTelegramCommand }
    | { kind: "callback"; callbackQueryId: string; callbackData: string }
  );
