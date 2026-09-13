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
    from?: TelegramUser;
  };
};

export type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
};

export type BotIdentity = {
  id: string;
  username: string;
};

export type AcceptedTelegramInput = {
  updateId: string;
  chatId: string;
  chatType: TelegramChat["type"];
  senderId: string;
  messageId: string;
  text: string;
  command?: "new";
};
