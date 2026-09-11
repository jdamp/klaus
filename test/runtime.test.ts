import { describe, expect, it } from "vitest";

import { HealthServer } from "../src/health/server.js";
import { Logger } from "../src/observability/logger.js";
import { MaintenanceRepository } from "../src/persistence/maintenance.js";
import { AppDatabase } from "../src/persistence/database.js";
import {
  ChatRepository,
  OutboxRepository,
  ToolAuditRepository,
  UpdateRepository,
} from "../src/persistence/repositories.js";
import { SecretRedactor } from "../src/security/secrets.js";

describe("runtime operations", () => {
  it("emits structured redacted logs with correlation identifiers", () => {
    const lines: string[] = [];
    const redactor = new SecretRedactor();
    redactor.add("super-secret");
    const logger = new Logger(redactor, (line) => lines.push(line));
    const id = logger.correlationId();
    logger.log("info", "tool.complete", { id, authorization: "Bearer super-secret" });
    expect(id).toMatch(/^[0-9a-f-]+$/);
    expect(lines[0]).not.toContain("super-secret");
    const payload = JSON.parse(lines[0]!) as { event: string };
    expect(payload.event).toBe("tool.complete");
  });

  it("serves distinct liveness and readiness with degraded integrations", async () => {
    const server = new HealthServer("127.0.0.1", 0, () => ({
      live: true,
      ready: true,
      integrations: { mcp: { status: "degraded", detail: "offline" } },
    }));
    await server.start();
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing health address");
    const ready = await fetch(`http://127.0.0.1:${address.port}/ready`);
    expect(ready.status).toBe(200);
    expect((await ready.json()) as object).toMatchObject({
      ready: true,
      integrations: { mcp: { status: "degraded" } },
    });
    await server.stop();
  });

  it("retains dedupe rows and active sessions while removing old sensitive payloads", () => {
    const database = new AppDatabase(":memory:");
    database.migrate();
    const chats = new ChatRepository(database);
    const updates = new UpdateRepository(database);
    const outbox = new OutboxRepository(database);
    const audits = new ToolAuditRepository(database);
    chats.ensure("1", "private");
    updates.claim({ updateId: "1", chatId: "1", senderId: "1", messageId: "1", text: "private" });
    updates.finish("1", "complete");
    outbox.enqueue({
      id: "o",
      dedupeKey: "d",
      chatId: "1",
      sequence: 0,
      text: "private",
      availableAt: new Date(0),
    });
    const leased = outbox.lease(new Date(1), 1_000)!;
    outbox.sent(leased.id, "2");
    const audit = audits.start("home", "light", { private: true });
    audits.finish(audit, "success", { private: true });
    database.connection.exec(
      "UPDATE telegram_updates SET received_at='1970-01-01'; UPDATE tool_executions SET started_at='1970-01-01'; UPDATE outbox_messages SET created_at='1970-01-01'",
    );
    new MaintenanceRepository(database).run(new Date("2000-01-01"));
    const update = database.connection
      .prepare("SELECT update_id,text FROM telegram_updates")
      .get() as { update_id: string; text: string };
    expect(update).toEqual({ update_id: "1", text: "" });
    expect(database.connection.prepare("SELECT active_session_id FROM chats").get()).toBeDefined();
    expect(
      database.connection.prepare("SELECT dedupe_key,text FROM outbox_messages").get(),
    ).toMatchObject({ dedupe_key: "d", text: "" });
    database.close();
  });
});
