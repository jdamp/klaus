import type { ParsedTelegramCommand, TelegramCommandName } from "./types.js";

export type TelegramCommandDefinition = {
  name: Exclude<TelegramCommandName, "help" | "unknown">;
  description: string;
};

export const TELEGRAM_COMMANDS: readonly TelegramCommandDefinition[] = [
  { name: "start", description: "Show available commands" },
  { name: "status", description: "Show model, usage, cost, and context" },
  { name: "model", description: "Select the model for this chat" },
  { name: "compact", description: "Compact the current conversation" },
  { name: "stop", description: "Stop the current operation" },
  { name: "new", description: "Start a fresh conversation" },
];

const supported = new Set<string>([...TELEGRAM_COMMANDS.map((command) => command.name), "help"]);

export function parseTelegramCommand(
  entityText: string,
  trailingText: string,
  botUsername: string,
): ParsedTelegramCommand | undefined {
  if (!entityText.startsWith("/")) return undefined;
  const [rawName = "", target] = entityText.slice(1).split("@", 2);
  if (target && target.toLowerCase() !== botUsername.toLowerCase()) return undefined;
  const normalized = rawName.toLowerCase();
  return {
    name: (supported.has(normalized) ? normalized : "unknown") as TelegramCommandName,
    rawName,
    arguments: trailingText.trim(),
  };
}

export function commandHelp(): string {
  return [
    "Available commands:",
    ...TELEGRAM_COMMANDS.map((command) => `/${command.name} - ${command.description}`),
  ].join("\n");
}
