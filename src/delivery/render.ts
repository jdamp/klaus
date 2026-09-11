export function splitTelegramText(text: string, limit = 4_096): string[] {
  if (limit < 1) throw new Error("Telegram chunk limit must be positive");
  const characters = Array.from(text);
  if (characters.length === 0) return [""];
  const chunks: string[] = [];
  let position = 0;

  while (position < characters.length) {
    let end = Math.min(position + limit, characters.length);
    if (end < characters.length) {
      const candidate = characters.slice(position, end).join("");
      const newline = candidate.lastIndexOf("\n");
      const space = candidate.lastIndexOf(" ");
      const boundary = Math.max(newline, space);
      if (boundary > Math.floor(limit * 0.5))
        end = position + Array.from(candidate.slice(0, boundary + 1)).length;
    }
    chunks.push(characters.slice(position, end).join(""));
    position = end;
  }
  return chunks;
}
