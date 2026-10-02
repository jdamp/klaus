import { describe, expect, it, vi } from "vitest";

import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

import type { AppConfig } from "../src/config.js";
import type { AppDatabase } from "../src/persistence/database.js";
import type { CapabilityCatalog } from "../src/capabilities/types.js";
import { SessionComponent } from "../src/runtime/services.js";
import { buildModelSelector } from "../src/telegram/command-handler.js";

describe("available model catalogue", () => {
  it("omits older versioned GPT models and retains GPT-6+ and nonmatching IDs", async () => {
    const available = [
      { provider: "openai-codex", id: "gpt-5.3-spark-codex" },
      { provider: "openai-codex", id: "gpt-5.5" },
      { provider: "openai-codex", id: "gpt-5.6-sol" },
      { provider: "openai-codex", id: "gpt-6-sol" },
      { provider: "openai-codex", id: "gpt-6.1-sol" },
      { provider: "openai-codex", id: "gpt-7-sol" },
      { provider: "openai", id: "gpt-image-2" },
      { provider: "other", id: "custom-model" },
    ];
    const runtime = {
      getAvailable: vi.fn(async () => available),
    } as unknown as ModelRuntime;
    const sessions = new SessionComponent(
      {} as AppConfig,
      runtime,
      {} as AppDatabase,
      {} as CapabilityCatalog,
    );

    const result = await sessions.availableModels(false);

    expect(result.models.map((model) => model.id)).toEqual([
      "gpt-6-sol",
      "gpt-6.1-sol",
      "gpt-7-sol",
      "gpt-image-2",
      "custom-model",
    ]);
    const selector = buildModelSelector(result.models, 0);
    const buttonLabels = JSON.stringify(selector?.replyMarkup.inline_keyboard);
    expect(buttonLabels).toContain("gpt-6-sol");
    expect(buttonLabels).not.toContain("gpt-5");
  });

  it("rejects direct selection of an older versioned GPT model", async () => {
    const runtime = {
      getAvailable: vi.fn(async () => [{ provider: "openai-codex", id: "gpt-5.5" }]),
    } as unknown as ModelRuntime;
    const sessions = new SessionComponent(
      {} as AppConfig,
      runtime,
      {} as AppDatabase,
      {} as CapabilityCatalog,
    );

    await expect(sessions.selectModel("chat", "session", "openai-codex/gpt-5.5")).rejects.toThrow(
      "Model is not available: openai-codex/gpt-5.5",
    );
  });

  it("passes a retained GPT-6 model through direct-selection availability checks", async () => {
    const getModel = vi.fn(() => ({}));
    const runtime = {
      getAvailable: vi.fn(async () => [{ provider: "openai-codex", id: "gpt-6-sol" }]),
      getModel,
    } as unknown as ModelRuntime;
    const sessions = new SessionComponent(
      {} as AppConfig,
      runtime,
      {} as AppDatabase,
      {} as CapabilityCatalog,
    );

    await expect(sessions.selectModel("chat", "session", "openai-codex/gpt-6-sol")).rejects.toThrow(
      "Session component is not started",
    );
    expect(getModel).toHaveBeenCalledWith("openai-codex", "gpt-6-sol");
  });
});
