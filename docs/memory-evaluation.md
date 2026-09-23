# Shared-memory real-model evaluation

This acceptance check exercises model behavior, not just repository correctness. Run it against
the exact model/reasoning configuration intended for the household. Do not substitute unit tests,
scripted tool calls, or expected-output matching for this run.

Record the date, image/config revision, provider/model ID, reasoning level, base-prompt source, and
tester. Start with an empty disposable notebook, then use the 12 notes and 20 recall cases in
`test/fixtures/memory-evaluation.json`.

The repeatable evaluator uses an isolated in-memory SQLite database and does not contact Telegram or
the live notebook. It does make external calls to the authenticated provider configured in the
selected file:

```sh
npm run eval:memory -- \
  --config /path/to/config.yaml \
  --fixture test/fixtures/memory-evaluation.json \
  --output /tmp/klaus-memory-evaluation.json
```

Review the complete output file before recording a result. A non-zero exit means the recall
threshold, no-match requirement, or required capture cases failed.

## Recall protocol

1. Create each fixture note through normal agent dialogue or the five exposed memory tools.
2. Start a fresh chat session with `/new`.
3. Ask every recall question verbatim in its specified chat. The agent may search directly or
   browse and read when vocabulary differs.
4. Score a case correct only when the answer is supported by the current note and attributes the
   correct participant where applicable. For `no_match` cases, any invented household memory is a
   failure.
5. Require at least 18 of 20 correct retrievals/browse-read recoveries and zero inventions across
   no-match cases. Record every miss, search query, browse fallback, and cited note ID.

## Capture and maintenance protocol

In normal conversation, separately exercise:

- an explicit remember request;
- a settled decision with rationale and date;
- a tentative option that must remain tentative;
- two alternating speakers with different preferences;
- a correction that preserves an unrelated note detail;
- deletion and overview clearing;
- mundane chat that should not become a note; and
- a save followed by cancellation or response-delivery failure.

The explicit request, alternating-speaker attribution, and correction cases must succeed. Report
opportunistic-capture misses separately; they are model-quality observations, not deterministic
tool-test failures. Inspect results with `/memory` and exact reads. Note that a committed mutation
survives cancellation, and deletion is logical notebook removal rather than erasure of transcripts
or backups.

## Result template

```text
Date / tester:
Image and config revision:
Provider / model / reasoning:
Base prompt:
Recall score: __ / 20
No-match inventions: __
Explicit remember: pass/fail
Alternating attribution: pass/fail
Compaction attribution: pass/fail
Correction preservation: pass/fail
Decision/rationale: pass/fail
Tentative wording: pass/fail
Mundane-chat capture: pass/fail (pass means no note)
Cancellation/delivery observation:
Opportunistic capture: observed/missed (best-effort, not a rollout gate)
Failure cases and note IDs:
```

The evaluator's non-required opportunistic case records a settled household decision without asking
the agent to remember it. Keep that observation separate from the required explicit-request,
attribution, correction, and compaction checks.
