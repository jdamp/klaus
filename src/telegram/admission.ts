import { parseTelegramCommand } from "./commands.js";
import type {
  AcceptedTelegramInput,
  BotIdentity,
  ParsedTelegramCommand,
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

function messageCommand(
  message: TelegramMessage,
  bot: BotIdentity,
): ParsedTelegramCommand | undefined {
  if (!message.text) return undefined;
  const entity = (message.entities ?? []).find(
    (candidate) => candidate.type === "bot_command" && candidate.offset === 0,
  );
  if (!entity) return undefined;
  return parseTelegramCommand(
    entityText(message.text, entity),
    message.text.slice(entity.length),
    bot.username,
  );
}

function explicitlyTriggers(
  message: TelegramMessage,
  bot: BotIdentity,
  command: ParsedTelegramCommand | undefined,
): boolean {
  if (!message.text) return false;
  if (command && command.name !== "unknown") return true;
  if (message.reply_to_message?.from?.id.toString() === bot.id) return true;
  return (message.entities ?? []).some((entity) => targetsBot(message.text ?? "", entity, bot));
}

function authorized(policy: AdmissionPolicy, chatId: string, senderId: string): boolean {
  return policy.allowedChats.has(chatId) && policy.allowedUsers.has(senderId);
}

export function admitUpdate(
  update: TelegramUpdate,
  policy: AdmissionPolicy,
  bot: BotIdentity,
): AcceptedTelegramInput | undefined {
  if (update.edited_message) return undefined;

  if (update.callback_query) {
    const query = update.callback_query;
    const message = query.message;
    if (
      query.from.is_bot ||
      !message ||
      message.from?.id.toString() !== bot.id ||
      typeof query.data !== "string" ||
      !query.data.startsWith("k:model:")
    ) {
      return undefined;
    }
    const chatId = message.chat.id.toString();
    const senderId = query.from.id.toString();
    if (!authorized(policy, chatId, senderId)) return undefined;
    return {
      kind: "callback",
      updateId: update.update_id.toString(),
      chatId,
      chatType: message.chat.type,
      senderId,
      messageId: message.message_id.toString(),
      text: query.data,
      callbackQueryId: query.id,
      callbackData: query.data,
    };
  }

  if (!update.message) return undefined;
  const message = update.message;
  if (!message.from || message.from.is_bot || !message.text?.trim()) return undefined;

  const chatId = message.chat.id.toString();
  const senderId = message.from.id.toString();
  if (!authorized(policy, chatId, senderId)) return undefined;

  const command = messageCommand(message, bot);
  if (message.chat.type !== "private" && !explicitlyTriggers(message, bot, command)) {
    return undefined;
  }

  const base = {
    updateId: update.update_id.toString(),
    chatId,
    chatType: message.chat.type,
    senderId,
    messageId: message.message_id.toString(),
    text: message.chat.type === "private" ? message.text.trim() : withoutBotMentions(message, bot),
  };
  return command ? { kind: "command", ...base, command } : { kind: "message", ...base };
}
