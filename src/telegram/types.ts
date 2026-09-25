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
  first_name?: string;
  last_name?: string;
};

export type TelegramChat = {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
};

export type TelegramPhotoSize = {
  file_id: string;
  width: number;
  height: number;
  file_size?: number;
};

export type TelegramDocument = {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
};

export type TelegramMessage = {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  text?: string;
  entities?: TelegramEntity[];
  caption?: string;
  caption_entities?: TelegramEntity[];
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
  audio?: unknown;
  voice?: unknown;
  video?: unknown;
  video_note?: unknown;
  animation?: unknown;
  sticker?: unknown;
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

export type TelegramParseMode = "HTML";

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
  "start" | "help" | "status" | "model" | "compact" | "stop" | "new" | "memory" | "unknown";

export type ParsedTelegramCommand = {
  name: TelegramCommandName;
  rawName: string;
  arguments: string;
};

export type TelegramVisualAttachment =
  | { kind: "photo"; variants: readonly TelegramPhotoSize[] }
  | { kind: "document"; document: TelegramDocument };

type AcceptedTelegramInputBase = {
  updateId: string;
  chatId: string;
  chatType: TelegramChat["type"];
  senderId: string;
  senderLabel?: string;
  messageId: string;
  text: string;
  visual?: TelegramVisualAttachment;
};

export type AcceptedTelegramInput = AcceptedTelegramInputBase &
  (
    | { kind: "message" }
    | { kind: "command"; command: ParsedTelegramCommand }
    | { kind: "callback"; callbackQueryId: string; callbackData: string }
  );
