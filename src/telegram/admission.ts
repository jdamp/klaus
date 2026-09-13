import type {
  AcceptedTelegramInput,
  BotIdentity,
  TelegramEntity,
  TelegramMessage,
  TelegramUpdate,
} from "./types.js";

export type AdmissionPolicy = {
  allowedUsers: ReadonlySet<string>;
  allowedChats: ReadonlySet<string>;
};

function entityText(text: string, entity: TelegramEntity): string {
  return text.slice(entity.offset, entity.offset + entity.length);
}

function targetsBot(text: string, entity: TelegramEntity, bot: BotIdentity): boolean {
  if (entity.type === "text_mention") return entity.user?.id.toString() === bot.id;
  return (
    entity.type === "mention" &&
    entityText(text, entity).toLowerCase() === `@${bot.username.toLowerCase()}`
  );
}

function withoutBotMentions(message: TelegramMessage, bot: BotIdentity): string {
  let text = message.text ?? "";
  const mentions = (message.entities ?? [])
    .filter((entity) => targetsBot(text, entity, bot))
    .sort((left, right) => right.offset - left.offset);
  for (const mention of mentions) {
    text = text.slice(0, mention.offset) + text.slice(mention.offset + mention.length);
  }
  return text.replace(/[ \t]{2,}/g, " ").trim();
}

function supportedCommand(message: TelegramMessage, bot: BotIdentity): "new" | undefined {
  if (!message.text) return undefined;
  for (const entity of message.entities ?? []) {
    if (entity.type !== "bot_command" || entity.offset !== 0) continue;
    const command = entityText(message.text, entity).toLowerCase();
    if (command === "/new" || command === `/new@${bot.username.toLowerCase()}`) return "new";
  }
  return undefined;
}

function explicitlyTriggers(message: TelegramMessage, bot: BotIdentity): boolean {
  if (!message.text) return false;
  if (supportedCommand(message, bot)) return true;
  if (message.reply_to_message?.from?.id.toString() === bot.id) return true;
  return (message.entities ?? []).some((entity) => targetsBot(message.text ?? "", entity, bot));
}

export function admitUpdate(
  update: TelegramUpdate,
  policy: AdmissionPolicy,
  bot: BotIdentity,
): AcceptedTelegramInput | undefined {
  if (update.edited_message || !update.message) return undefined;
  const message = update.message;
  if (!message.from || message.from.is_bot || !message.text?.trim()) return undefined;

  const chatId = message.chat.id.toString();
  const senderId = message.from.id.toString();
  if (!policy.allowedChats.has(chatId) || !policy.allowedUsers.has(senderId)) return undefined;
  if (message.chat.type !== "private" && !explicitlyTriggers(message, bot)) return undefined;

  const command = supportedCommand(message, bot);
  return {
    updateId: update.update_id.toString(),
    chatId,
    chatType: message.chat.type,
    senderId,
    messageId: message.message_id.toString(),
    text: message.chat.type === "private" ? message.text.trim() : withoutBotMentions(message, bot),
    ...(command ? { command } : {}),
  };
}
