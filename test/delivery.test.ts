import { describe, expect, it } from "vitest";

import { enqueueRenderedAgentResponse, enqueueResponse } from "../src/delivery/intents.js";
import { OutboxWorker } from "../src/delivery/outbox-worker.js";
import {
  renderTelegramMarkdown,
  splitTelegramHtml,
  splitTelegramText,
} from "../src/delivery/render.js";
import { AppDatabase } from "../src/persistence/database.js";
import { OutboxRepository } from "../src/persistence/repositories.js";

describe("Telegram delivery", () => {
  it("splits safely and reconstructs the original text", () => {
    const text = "one two\n" + "🙂".repeat(20);
    const chunks = splitTelegramText(text, 10);
    expect(chunks.every((chunk) => Array.from(chunk).length <= 10)).toBe(true);
    expect(chunks.join("")).toBe(text);
  });

  it("renders supported Markdown as escaped Telegram HTML", () => {
    expect(renderTelegramMarkdown("# Heading\n\n**bold** and *italic* with `code`")).toBe(
      "<b>Heading</b>\n\n<b>bold</b> and <i>italic</i> with <code>code</code>",
    );
    expect(renderTelegramMarkdown("<b>raw</b> ~~unsupported~~ [bad](javascript:alert(1))")).toBe(
      "&lt;b&gt;raw&lt;/b&gt; ~~unsupported~~ [bad](javascript:alert(1))",
    );
    expect(renderTelegramMarkdown("**bold and *italic***")).toBe("<b>bold and <i>italic</i></b>");
    expect(renderTelegramMarkdown("[safe](https://example.com/?a=1&b=2)")).toBe(
      '<a href="https://example.com/?a=1&amp;b=2">safe</a>',
    );
    expect(renderTelegramMarkdown("1. **first**\n2. `second`\n\n```\nconst x = 1;\n```")).toBe(
      "\u00a01. <b>first</b>\n\u00a02. <code>second</code>\n\n<pre>const x = 1;</pre>",
    );
    expect(
      renderTelegramMarkdown(
        "Projekt:\n\n- 💡 **Beleuchtung**\n  - Aufgaben: **1**\n  - Fortschritt: **0 %**",
      ),
    ).toBe(
      "Projekt:\n\n\u00a0• 💡 <b>Beleuchtung</b>\n\u00a0\u00a0\u00a0\u00a0• Aufgaben: <b>1</b>\n\u00a0\u00a0\u00a0\u00a0• Fortschritt: <b>0 %</b>",
    );
  });

  it("splits rendered HTML into independently valid formatted messages", () => {
    expect(splitTelegramHtml("<b>abcdefghij</b>", 3)).toEqual([
      "<b>abc</b>",
      "<b>def</b>",
      "<b>ghi</b>",
      "<b>j</b>",
    ]);
    expect(splitTelegramHtml("<pre>🙂🙂🙂</pre>", 2)).toEqual(["<pre>🙂🙂</pre>", "<pre>🙂</pre>"]);
    expect(splitTelegramHtml('<a href="https://example.com"><i>abcdef</i></a>', 2)).toEqual([
      '<a href="https://example.com"><i>ab</i></a>',
      '<a href="https://example.com"><i>cd</i></a>',
      '<a href="https://example.com"><i>ef</i></a>',
    ]);
    expect(splitTelegramHtml("first\nsecond", 20)).toEqual(["first\nsecond"]);
  });

  it("queues ordered reply intents only for the originating chat", () => {
    const database = new AppDatabase(":memory:");
    database.migrate();
    const outbox = new OutboxRepository(database);
    enqueueResponse(outbox, { updateId: "1", chatId: "-100", messageId: "7" }, "hello", {
      inline_keyboard: [[{ text: "Choose", callback_data: "k:model:s:test" }]],
    });
    const row = database.connection
      .prepare(
        "SELECT chat_id,reply_to_message_id,text,parse_mode,reply_markup_json FROM outbox_messages",
      )
      .get() as Record<string, string>;
    expect(row).toEqual({
      chat_id: "-100",
      reply_to_message_id: "7",
      text: "hello",
      parse_mode: null,
      reply_markup_json:
        '{"inline_keyboard":[[{"text":"Choose","callback_data":"k:model:s:test"}]]}',
    });
    database.close();
  });

  it("queues rendered agent output with durable HTML mode", () => {
    const database = new AppDatabase(":memory:");
    database.migrate();
    const outbox = new OutboxRepository(database);
    enqueueRenderedAgentResponse(
      outbox,
      { updateId: "1", chatId: "-100", messageId: "7" },
      "**hello**",
    );
    expect(
      database.connection.prepare("SELECT text,parse_mode FROM outbox_messages").get(),
    ).toEqual({ text: "<b>hello</b>", parse_mode: "HTML" });
    database.close();
  });

  it("retries transient failures without recreating work", async () => {
    const database = new AppDatabase(":memory:");
    database.migrate();
    const outbox = new OutboxRepository(database);
    const now = new Date("2026-01-01T00:00:00Z");
    outbox.enqueue({
      id: "m",
      dedupeKey: "d",
      chatId: "1",
      sequence: 0,
      text: "hello",
      parseMode: "HTML",
      replyMarkup: {
        inline_keyboard: [[{ text: "Choose", callback_data: "k:model:s:test" }]],
      },
      availableAt: now,
    });
    let calls = 0;
    let observedMarkup: unknown;
    let observedParseMode: unknown;
    const worker = new OutboxWorker(outbox, {
      async sendMessage(_chat, _text, _reply, _signal, replyMarkup, parseMode) {
        calls += 1;
        observedMarkup = replyMarkup;
        observedParseMode = parseMode;
        if (calls === 1) throw new Error("temporary");
        return "77";
      },
    });
    await worker.runOnce(now);
    await worker.runOnce(new Date(now.getTime() + 1_000));
    const row = database.connection
      .prepare("SELECT state,attempts,telegram_message_id FROM outbox_messages WHERE id='m'")
      .get() as Record<string, unknown>;
    expect(row).toMatchObject({ state: "sent", attempts: 2, telegram_message_id: "77" });
    expect(observedMarkup).toEqual({
      inline_keyboard: [[{ text: "Choose", callback_data: "k:model:s:test" }]],
    });
    expect(observedParseMode).toBe("HTML");
    database.close();
  });
});
