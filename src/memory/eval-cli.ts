import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { PiSessionFactory, createModelRuntime, extractFinalText } from "../agent/pi-runtime.js";
import { attributedUserPrompt, MemoryTurnContextRegistry } from "./context.js";
import { parseConfig } from "../config.js";
import { AppDatabase } from "../persistence/database.js";
import { SessionEntryRepository, ToolAuditRepository } from "../persistence/repositories.js";
import { SecretRedactor } from "../security/secrets.js";
import { MemoryProvider } from "./provider.js";
import { MemoryRepository, OVERVIEW_ID } from "./repository.js";

type Fixture = {
  notes: Array<{ id: string; title: string; tags: string[]; body: string }>;
  questions: Array<{
    id: string;
    question: string;
    expected: string[];
    no_match?: boolean;
  }>;
};

type RecallResult = {
  id: string;
  correct: boolean;
  expectedIds: string[];
  answer: string;
  error?: string;
};

function argument(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function includesEvery(haystack: string, needles: readonly string[]): boolean {
  return needles.every((needle) => haystack.includes(needle));
}

async function main(): Promise<void> {
  const configPath = resolve(argument("--config", "config.yaml")!);
  const fixturePath = resolve(argument("--fixture", "test/fixtures/memory-evaluation.json")!);
  const outputPath = argument("--output");
  const maximumQuestions = Number(argument("--max-questions", "0"));
  const skipCapture = process.argv.includes("--skip-capture");
  const skipRecall = process.argv.includes("--skip-recall");
  const parsedConfig = parseConfig(await readFile(configPath, "utf8"));
  const modelIdOverride = argument("--model-id");
  const config = modelIdOverride
    ? {
        ...parsedConfig,
        model: { ...parsedConfig.model, id: modelIdOverride },
      }
    : parsedConfig;
  const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as Fixture;
  if (fixture.notes.length < 12 || fixture.questions.length < 20) {
    throw new Error("Memory evaluation requires at least 12 notes and 20 questions");
  }

  const database = new AppDatabase(":memory:");
  database.migrate();
  const repository = new MemoryRepository(database, config.memory);
  const contexts = new MemoryTurnContextRegistry();
  const provider = new MemoryProvider(
    repository,
    contexts,
    new ToolAuditRepository(database),
    new SecretRedactor(),
  );
  await provider.start();
  const runtime: ModelRuntime = await createModelRuntime(config.model);
  const factory = new PiSessionFactory(
    config,
    runtime,
    new SessionEntryRepository(database),
    (sessionId) => provider.tools({ sessionId }),
    undefined,
    contexts,
  );

  const logicalToStored = new Map<string, string>();
  for (const [index, note] of fixture.notes.entries()) {
    const saved = repository.save(
      { title: note.title, body: note.body, tags: note.tags },
      { senderId: "evaluation-seed", updateId: `seed-${index + 1}` },
      `seed-${index + 1}`,
    );
    if (!saved.ok) throw new Error(`Could not seed ${note.id}: ${saved.message}`);
    logicalToStored.set(note.id, saved.id);
  }

  const runTurn = async (text: string, senderId: string, senderLabel: string): Promise<string> => {
    const sessionId = randomUUID();
    const managed = await factory.create(sessionId);
    const overview = repository.read(OVERVIEW_ID);
    if (!overview) throw new Error("Evaluation overview is missing");
    const token = contexts.set(sessionId, {
      chatId: "evaluation",
      senderId,
      senderLabel,
      updateId: randomUUID(),
      overview,
    });
    try {
      await managed.session.prompt(attributedUserPrompt({ senderId, senderLabel, text }));
      const response = extractFinalText(managed.session.messages);
      if (!response) {
        const messages = managed.session.messages.slice(-4).map((message) => ({
          role: message.role,
          ...("stopReason" in message ? { stopReason: message.stopReason } : {}),
          ...("errorMessage" in message ? { errorMessage: message.errorMessage } : {}),
          ...("provider" in message ? { provider: message.provider } : {}),
          ...("model" in message ? { model: message.model } : {}),
          content:
            "content" in message && Array.isArray(message.content)
              ? message.content.map((part) => ({
                  type: part.type,
                  ...("text" in part && typeof part.text === "string"
                    ? { text: part.text.slice(0, 300) }
                    : {}),
                }))
              : undefined,
        }));
        throw new Error(`Model returned no final text; tail=${JSON.stringify(messages)}`);
      }
      return response;
    } finally {
      contexts.clear(sessionId, token);
      managed.dispose();
    }
  };

  const recall: RecallResult[] = [];
  const recallQuestions = skipRecall
    ? []
    : Number.isInteger(maximumQuestions) && maximumQuestions > 0
      ? fixture.questions.slice(0, maximumQuestions)
      : fixture.questions;
  for (const [index, question] of recallQuestions.entries()) {
    process.stderr.write(`Recall ${index + 1}/${recallQuestions.length}: ${question.id}\n`);
    const expectedIds = question.expected.map((id) => {
      const stored = logicalToStored.get(id);
      if (!stored) throw new Error(`Unknown expected fixture note: ${id}`);
      return stored;
    });
    try {
      const answer = await runTurn(
        [
          "This is a memory recall evaluation.",
          "Answer only from the shared notebook, using memory search/list/read as needed.",
          "If the notebook does not support an answer, say so and do not invent one.",
          'End with exactly "MEMORY_IDS: NONE" or "MEMORY_IDS: <comma-separated stable note IDs>" for every note used.',
          `Question: ${question.question}`,
        ].join("\n"),
        "evaluation-reader",
        "Evaluation reader",
      );
      const correct = question.no_match
        ? /MEMORY_IDS:\s*NONE\s*$/i.test(answer.trim())
        : includesEvery(answer, expectedIds);
      recall.push({ id: question.id, correct, expectedIds, answer });
    } catch (error) {
      recall.push({
        id: question.id,
        correct: false,
        expectedIds,
        answer: "",
        error: error instanceof Error ? error.message : "Evaluation turn failed",
      });
    }
  }

  const captureStartCount = repository.list({ limit: 100 }).items.length;
  const captureAnswers: Record<string, string> = {};
  const captureTurn = async (
    id: string,
    text: string,
    senderId: string,
    senderLabel: string,
  ): Promise<void> => {
    process.stderr.write(`Capture: ${id}\n`);
    captureAnswers[id] = await runTurn(text, senderId, senderLabel);
  };

  if (!skipCapture) {
    await captureTurn(
      "explicit",
      "Please remember that I prefer sparkling water with lemon.",
      "101",
      "Mira",
    );
    await captureTurn(
      "decision",
      "We decided on 12 October 2026 to install the balcony bench on the west wall because it has afternoon shade. Please remember the decision and rationale.",
      "202",
      "Jonas",
    );
    await captureTurn(
      "tentative",
      "Please remember that painting the study green is only a tentative option; nobody has decided it.",
      "101",
      "Mira",
    );
    await captureTurn(
      "speaker_mira",
      "Remember that I, Mira, prefer the window seat on trains.",
      "101",
      "Mira",
    );
    await captureTurn(
      "speaker_jonas",
      "Remember that I, Jonas, prefer the aisle seat on trains.",
      "202",
      "Jonas",
    );
    await captureTurn(
      "correction_seed",
      "Please remember the picnic plan: Sunday at Stadtpark; bring the blanket and apples.",
      "101",
      "Mira",
    );
    await captureTurn(
      "correction",
      "Correction: the picnic is Saturday, not Sunday. Keep its location and packing details.",
      "101",
      "Mira",
    );
    await captureTurn(
      "opportunistic",
      "After comparing options, we settled on keeping the hallway spare key in the blue ceramic bowl because everyone can reach it. That is the final decision.",
      "202",
      "Jonas",
    );
  }
  const beforeMundane = repository.list({ limit: 100 }).items.length;
  if (!skipCapture) {
    await captureTurn("mundane", "Thanks. The weather is pleasant today.", "202", "Jonas");
  }
  const afterMundane = repository.list({ limit: 100 }).items.length;

  let compactionSummary = "";
  let compactionError: string | undefined;
  if (!skipCapture) {
    process.stderr.write("Capture: compaction_attribution\n");
    const compactionFactory = new PiSessionFactory(
      { ...config, model: { ...config.model, contextTokens: 8_192 } },
      runtime,
      new SessionEntryRepository(database),
      [],
      undefined,
      contexts,
    );
    const managed = await compactionFactory.create(randomUUID());
    const timestamp = Date.now();
    managed.session.sessionManager.appendMessage({
      role: "user",
      content: attributedUserPrompt({
        senderId: "101",
        senderLabel: "Mira",
        text: "For this conversation only: I prefer the window seat on trains.",
      }),
      timestamp,
    });
    managed.session.sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "Acknowledged for this conversation." }],
      api: "openai-codex-responses",
      provider: config.model.provider,
      model: config.model.id,
      usage: {},
      stopReason: "stop",
      timestamp: timestamp + 1,
    } as never);
    managed.session.sessionManager.appendMessage({
      role: "user",
      content: attributedUserPrompt({
        senderId: "202",
        senderLabel: "Jonas",
        text: "For this conversation only: I prefer the aisle seat on trains.",
      }),
      timestamp: timestamp + 2,
    });
    managed.session.sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "Acknowledged for this conversation." }],
      api: "openai-codex-responses",
      provider: config.model.provider,
      model: config.model.id,
      usage: {},
      stopReason: "stop",
      timestamp: timestamp + 3,
    } as never);
    managed.session.sessionManager.appendMessage({
      role: "user",
      content: `Unimportant background follows. ${"background context. ".repeat(1_800)}`,
      timestamp: timestamp + 4,
    });
    managed.session.sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "Background received." }],
      api: "openai-codex-responses",
      provider: config.model.provider,
      model: config.model.id,
      usage: {},
      stopReason: "stop",
      timestamp: timestamp + 5,
    } as never);
    try {
      await managed.session.compact();
      const entry = [...managed.session.sessionManager.getEntries()]
        .reverse()
        .find((candidate) => candidate.type === "compaction");
      if (entry?.type === "compaction") compactionSummary = entry.summary;
    } catch (error) {
      compactionError = error instanceof Error ? error.message : "Compaction evaluation failed";
    } finally {
      managed.dispose();
    }
  }

  const joinedBodies = (query: string): string =>
    repository
      .search({ query, limit: 20 })
      .items.map((item) => repository.read(item.id)?.body ?? "")
      .join("\n");
  const explicitBody = joinedBodies("sparkling lemon");
  const decisionBody = joinedBodies("balcony bench");
  const tentativeBody = joinedBodies("study green");
  const trainBody = `${joinedBodies("Mira window")}\n${joinedBodies("Jonas aisle")}`;
  const picnicBody = joinedBodies("picnic Stadtpark");
  const opportunisticBody = joinedBodies("hallway spare key");
  const capture = {
    explicitRemember: /sparkling/i.test(explicitBody) && /lemon/i.test(explicitBody),
    decisionRationale:
      /12 October 2026/i.test(decisionBody) &&
      /west wall/i.test(decisionBody) &&
      /afternoon shade/i.test(decisionBody),
    tentative: /green/i.test(tentativeBody) && /tentative|not decided/i.test(tentativeBody),
    alternatingAttribution:
      /Mira/i.test(trainBody) &&
      /window/i.test(trainBody) &&
      /Jonas/i.test(trainBody) &&
      /aisle/i.test(trainBody),
    correctionPreservesDetails:
      /Saturday/i.test(picnicBody) &&
      /Stadtpark/i.test(picnicBody) &&
      /blanket/i.test(picnicBody) &&
      /apples/i.test(picnicBody),
    compactionAttribution:
      /101|Mira/i.test(compactionSummary) &&
      /window/i.test(compactionSummary) &&
      /202|Jonas/i.test(compactionSummary) &&
      /aisle/i.test(compactionSummary),
    compactionSummary,
    ...(compactionError ? { compactionError } : {}),
    opportunisticCaptured:
      /spare key/i.test(opportunisticBody) &&
      /blue ceramic bowl/i.test(opportunisticBody) &&
      /final|decided|decision|settled/i.test(opportunisticBody),
    mundaneNotCaptured: beforeMundane === afterMundane,
    notesBeforeCapture: captureStartCount,
    notesAfterCapture: afterMundane,
    answers: captureAnswers,
  };

  const failures = recall.filter((result) => !result.correct).map((result) => result.id);
  const output = {
    timestamp: new Date().toISOString(),
    configPath,
    fixturePath,
    model: {
      provider: config.model.provider,
      id: config.model.id,
      reasoning: config.model.reasoning,
      contextTokens: config.model.contextTokens,
      basePrompt: config.agent.systemPromptFile ?? "built-in",
    },
    recall: {
      score: recall.length - failures.length,
      total: recall.length,
      threshold: 18,
      noMatchInventions: recall.filter(
        (result) =>
          fixture.questions.find((question) => question.id === result.id)?.no_match &&
          !result.correct,
      ).length,
      passed:
        skipRecall ||
        (recall.length - failures.length >= 18 &&
          recall.every(
            (result) =>
              !fixture.questions.find((question) => question.id === result.id)?.no_match ||
              result.correct,
          )),
      failures,
      results: recall,
    },
    capture: {
      ...capture,
      requiredPassed:
        capture.explicitRemember &&
        capture.alternatingAttribution &&
        capture.correctionPreservesDetails &&
        capture.compactionAttribution,
    },
  };
  const serialized = JSON.stringify(output, null, 2) + "\n";
  if (outputPath) {
    await writeFile(resolve(outputPath), serialized, "utf8");
    process.stdout.write(
      JSON.stringify({
        output: resolve(outputPath),
        recall: {
          score: output.recall.score,
          total: output.recall.total,
          noMatchInventions: output.recall.noMatchInventions,
          passed: output.recall.passed,
          failures: output.recall.failures,
        },
        capture: {
          explicitRemember: output.capture.explicitRemember,
          decisionRationale: output.capture.decisionRationale,
          tentative: output.capture.tentative,
          alternatingAttribution: output.capture.alternatingAttribution,
          correctionPreservesDetails: output.capture.correctionPreservesDetails,
          compactionAttribution: output.capture.compactionAttribution,
          opportunisticCaptured: output.capture.opportunisticCaptured,
          mundaneNotCaptured: output.capture.mundaneNotCaptured,
          requiredPassed: output.capture.requiredPassed,
        },
      }) + "\n",
    );
  } else {
    process.stdout.write(serialized);
  }
  database.close();
  if (!output.recall.passed || !output.capture.requiredPassed) process.exitCode = 1;
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Memory evaluation failed");
  process.exitCode = 1;
});
