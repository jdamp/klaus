# Shared-memory acceptance result

Run date: 2026-09-23

Tester: Codex, using the repository evaluator

Base revision: `98d3eb7` plus the uncommitted `add-shared-agent-memory` change

Configuration: `examples/config.local.yaml` with a command-line model override

Provider / model / reasoning: `openai-codex` / `gpt-5.5` / `medium`

Context allowance: 64,000 tokens; focused compaction case: 8,192 tokens

Base prompt: built-in

The evaluation used an isolated in-memory SQLite database and the synthetic fixture in
`test/fixtures/memory-evaluation.json`. It did not read or modify live memory.

## Results

- Recall: 20/20 (threshold: 18/20).
- No-match inventions: 0 across two no-match questions.
- Explicit remember request: pass.
- Decision with rationale and date: pass.
- Tentative wording preserved: pass.
- Alternating-speaker attribution: pass.
- Correction preserved the unrelated location and packing details: pass.
- Attribution after a real manual Pi compaction: pass for both sender 101 (Mira/window) and sender
  202 (Jonas/aisle).
- Mundane chat created no note: pass.
- Best-effort opportunistic capture: observed; the hallway spare-key decision and rationale were
  saved even though the user did not ask the agent to remember it.

Required capture checks passed. There were no recall failure cases or note-ID mismatches.

## Evaluation notes

The recall run and capture run were executed separately so the completed 20-question provider run
did not need to be repeated while the focused compaction case was added. Both used the same provider,
model, reasoning level, base prompt, fixture, repository implementation, and in-memory database
setup.

An earlier capture report showed a false failure for alternating speakers because its checker queried
`train seat` while the stored notes used `trains`; SQLite FTS5 does not stem those terms. The notes
themselves correctly attributed Mira and Jonas. The checker now searches the two distinctive
name/preference pairs and the corrected run passed.

Cancellation/delivery persistence, deletion, and overview clearing are deterministic storage
properties covered by the integration suite rather than claimed from this probabilistic model run.
