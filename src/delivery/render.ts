import { marked, type Token, type Tokens } from "marked";

const telegramHtmlTag = /<\/?(?:b|i|code|pre|a)(?: href="[^"]*")?>/g;
const telegramHtmlTagParts = /^<(\/)?(b|i|code|pre|a)(?: href="[^"]*")?>$/;
const allowedLink = /^(https?:\/\/)/i;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function inlineTokens(token: Token): Token[] {
  return "tokens" in token && Array.isArray(token.tokens) ? token.tokens : [];
}

function tokenText(token: Token): string {
  return "text" in token && typeof token.text === "string" ? token.text : token.raw;
}

function listItems(token: Token): Tokens.ListItem[] {
  const value: unknown = (token as { items?: unknown }).items;
  return Array.isArray(value) ? (value as Tokens.ListItem[]) : [];
}

function renderInline(tokens: readonly Token[]): string {
  return tokens
    .map((token) => {
      const content = inlineTokens(token);
      switch (token.type) {
        case "text":
          return content.length > 0 ? renderInline(content) : escapeHtml(tokenText(token));
        case "escape":
          return escapeHtml(tokenText(token));
        case "br":
          return "\n";
        case "strong":
          return `<b>${renderInline(content)}</b>`;
        case "em":
          return `<i>${renderInline(content)}</i>`;
        case "codespan":
          return `<code>${escapeHtml(tokenText(token))}</code>`;
        case "link": {
          const href = "href" in token && typeof token.href === "string" ? token.href : "";
          if (!allowedLink.test(href)) return escapeHtml(token.raw);
          return `<a href="${escapeHtml(href)}">${renderInline(content)}</a>`;
        }
        default:
          return escapeHtml(token.raw);
      }
    })
    .join("");
}

function renderListItem(tokens: readonly Token[], nestedDepth: number): string {
  return tokens
    .map((token) => {
      if (token.type === "list") return `\n${renderList(token as Tokens.List, nestedDepth)}`;
      return renderInline([token]);
    })
    .join("");
}

function renderList(token: Tokens.List, depth = 0): string {
  const start = typeof token.start === "number" ? token.start : 1;
  const indent = "\u00a0".repeat(depth * 3 + 1);
  return listItems(token)
    .map((item, index) => {
      const marker = token.ordered ? `${start + index}. ` : "• ";
      return `${indent}${marker}${renderListItem(item.tokens, depth + 1)}`;
    })
    .join("\n");
}

function renderBlock(token: Token): string {
  switch (token.type) {
    case "space":
      return "";
    case "paragraph":
      return `${renderInline(inlineTokens(token))}\n\n`;
    case "heading":
      return `<b>${renderInline(inlineTokens(token))}</b>\n\n`;
    case "code":
      return `<pre>${escapeHtml(tokenText(token))}</pre>\n\n`;
    case "list":
      return `${renderList(token as Tokens.List)}\n\n`;
    case "blockquote":
      return `> ${renderInline(inlineTokens(token))}\n\n`;
    default:
      return `${escapeHtml(token.raw)}\n\n`;
  }
}

/** Converts a supported CommonMark subset to escaped Telegram HTML. */
export function renderTelegramMarkdown(text: string): string {
  return marked.lexer(text, { gfm: true, breaks: true }).map(renderBlock).join("").trimEnd();
}

function htmlTokens(html: string): string[] {
  const tokens: string[] = [];
  let position = 0;
  for (const match of html.matchAll(telegramHtmlTag)) {
    const index = match.index ?? 0;
    if (index > position) tokens.push(html.slice(position, index));
    tokens.push(match[0]);
    position = index + match[0].length;
  }
  if (position < html.length) tokens.push(html.slice(position));
  return tokens;
}

function visibleUnits(text: string): string[] {
  return text.match(/&(?:amp|lt|gt|quot|#39);|[\s\S]/gu) ?? [];
}

function closingTag(openingTag: string): string {
  const match = telegramHtmlTagParts.exec(openingTag);
  if (!match || match[1]) throw new Error("Expected an opening Telegram HTML tag");
  return `</${match[2]}>`;
}

/** Splits generated Telegram HTML into independently valid messages by visible character count. */
export function splitTelegramHtml(html: string, limit = 4_096): string[] {
  if (limit < 1) throw new Error("Telegram chunk limit must be positive");
  if (html.length === 0) return [""];

  const chunks: string[] = [];
  const openTags: string[] = [];
  let chunk = "";
  let visibleLength = 0;

  const flush = (): void => {
    if (visibleLength === 0) return;
    chunks.push(chunk + openTags.map(closingTag).reverse().join(""));
    chunk = openTags.join("");
    visibleLength = 0;
  };

  for (const token of htmlTokens(html)) {
    const tag = telegramHtmlTagParts.exec(token);
    if (tag) {
      if (tag[1]) {
        const opening = openTags.pop();
        if (!opening || closingTag(opening) !== token)
          throw new Error("Invalid generated Telegram HTML");
      } else {
        openTags.push(token);
      }
      chunk += token;
      continue;
    }

    for (const unit of visibleUnits(token)) {
      if (visibleLength === limit) flush();
      chunk += unit;
      visibleLength += 1;
    }
  }
  flush();
  return chunks;
}

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
