import { parseTelegramCommand } from "./commands.js";
import type {
  AcceptedTelegramInput,
  BotIdentity,
  ParsedTelegramCommand,
  TelegramDocument,
  TelegramEntity,
  TelegramMessage,
  TelegramUpdate,
  TelegramUploadAttachment,
} from "./types.js";

export type AdmissionPolicy = {
  allowedUsers: ReadonlySet<string>;
  allowedChats: ReadonlySet<string>;
  paperlessEnabled?: boolean;
};

const IMAGE_EXTENSIONS = /\.(?:jpe?g|png|webp|gif|apng|avif|tiff?|bmp)$/iu;
const NEUTRAL_VISUAL_PROMPT = "Please respond to the attached image.";
const NEUTRAL_DOCUMENT_PROMPT = "What would you like me to do with this document?";

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

function withoutBotMentions(
  text: string,
  entities: readonly TelegramEntity[],
  bot: BotIdentity,
): string {
  let cleaned = text;
  const mentions = entities
    .filter((entity) => targetsBot(text, entity, bot))
    .sort((left, right) => right.offset - left.offset);
  for (const mention of mentions) {
    cleaned = cleaned.slice(0, mention.offset) + cleaned.slice(mention.offset + mention.length);
  }
  return cleaned.replace(/[ \t]{2,}/g, " ").trim();
}

function captionOrText(
  message: TelegramMessage,
): { text: string; entities: readonly TelegramEntity[] } | undefined {
  if (message.text !== undefined) return { text: message.text, entities: message.entities ?? [] };
  if (message.caption !== undefined)
    return { text: message.caption, entities: message.caption_entities ?? [] };
  return undefined;
}

function messageCommand(
  message: TelegramMessage,
  bot: BotIdentity,
): ParsedTelegramCommand | undefined {
  const source = captionOrText(message);
  if (!source?.text) return undefined;
  const entity = source.entities.find(
    (candidate) => candidate.type === "bot_command" && candidate.offset === 0,
  );
  if (!entity) return undefined;
  return parseTelegramCommand(
    entityText(source.text, entity),
    source.text.slice(entity.offset + entity.length),
    bot.username,
  );
}

function explicitlyTriggers(
  message: TelegramMessage,
  bot: BotIdentity,
  command: ParsedTelegramCommand | undefined,
): boolean {
  const source = captionOrText(message);
  if (command && command.name !== "unknown") return true;
  if (message.reply_to_message?.from?.id.toString() === bot.id) return true;
  return Boolean(
    source?.text && source.entities.some((entity) => targetsBot(source.text, entity, bot)),
  );
}

function authorized(policy: AdmissionPolicy, chatId: string, senderId: string): boolean {
  return policy.allowedChats.has(chatId) && policy.allowedUsers.has(senderId);
}

function senderLabel(user: {
  username?: string;
  first_name?: string;
  last_name?: string;
}): string | undefined {
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  return name || user.username;
}

function imageDocument(document: TelegramDocument): boolean {
  return (
    Boolean(document.mime_type?.toLowerCase().startsWith("image/")) ||
    Boolean(document.file_name && IMAGE_EXTENSIONS.test(document.file_name))
  );
}

function visualAttachment(message: TelegramMessage) {
  if (message.photo && message.photo.length > 0) {
    return { kind: "photo" as const, variants: message.photo };
  }
  if (message.document && imageDocument(message.document)) {
    return { kind: "document" as const, document: message.document };
  }
  return undefined;
}

function uploadAttachment(message: TelegramMessage): TelegramUploadAttachment | undefined {
  if (message.photo && message.photo.length > 0) {
    return { kind: "photo", variants: message.photo };
  }
  const document = message.document;
  if (!document) return undefined;
  const mime = document.mime_type?.toLowerCase();
  const name = document.file_name?.toLowerCase() ?? "";
  const supported =
    mime === "application/pdf" ||
    mime === "image/jpeg" ||
    mime === "image/png" ||
    /\\.pdf$/u.test(name) ||
    /\\.jpe?g$/u.test(name) ||
    /\\.png$/u.test(name);
  return supported ? { kind: "document", document } : undefined;
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
    const label = senderLabel(query.from);
    if (!authorized(policy, chatId, senderId)) return undefined;
    return {
      kind: "callback",
      updateId: update.update_id.toString(),
      chatId,
      chatType: message.chat.type,
      senderId,
      ...(label ? { senderLabel: label } : {}),
      messageId: message.message_id.toString(),
      text: query.data,
      callbackQueryId: query.id,
      callbackData: query.data,
    };
  }

  if (!update.message) return undefined;
  const message = update.message;
  if (!message.from || message.from.is_bot) return undefined;
  if (
    message.audio ||
    message.voice ||
    message.video ||
    message.video_note ||
    message.animation ||
    message.sticker
  )
    return undefined;
  const paperlessUpload = policy.paperlessEnabled ? uploadAttachment(message) : undefined;
  if (message.document && !imageDocument(message.document) && !paperlessUpload) return undefined;

  const source = captionOrText(message);
  const visual = visualAttachment(message);
  if (!source?.text.trim() && !visual && !paperlessUpload) return undefined;

  const chatId = message.chat.id.toString();
  const senderId = message.from.id.toString();
  const label = senderLabel(message.from);
  if (!authorized(policy, chatId, senderId)) return undefined;

  const command = messageCommand(message, bot);
  if (message.chat.type !== "private" && !explicitlyTriggers(message, bot, command)) {
    return undefined;
  }

  const groupText = source ? withoutBotMentions(source.text, source.entities, bot) : "";
  const text =
    message.chat.type === "private"
      ? source?.text.trim() ||
        (visual ? NEUTRAL_VISUAL_PROMPT : paperlessUpload ? NEUTRAL_DOCUMENT_PROMPT : "")
      : groupText ||
        (visual ? NEUTRAL_VISUAL_PROMPT : paperlessUpload ? NEUTRAL_DOCUMENT_PROMPT : "");
  if (!text && !visual && !paperlessUpload) return undefined;

  const base = {
    updateId: update.update_id.toString(),
    chatId,
    chatType: message.chat.type,
    senderId,
    ...(label ? { senderLabel: label } : {}),
    messageId: message.message_id.toString(),
    text,
    ...(visual ? { visual } : {}),
    ...(paperlessUpload ? { uploadAttachment: paperlessUpload } : {}),
  };
  return command ? { kind: "command", ...base, command } : { kind: "message", ...base };
}
