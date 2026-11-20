# Live generated-token feedback

Users see an above-editor generation count during chat and summaries. Live estimates are visibly
approximate; final authoritative counts/rates may replace them before transient cleanup.

## Sub-features

- `generation-chat`: normal chat has approximate feedback even after the working spinner stops (AC-05).
- `generation-fields`: text/reasoning/tool fragments count once; empty/role-only chunks do not.
- `generation-final`: usage wins over conflicting timing count; authoritative native rates only (AC-06).
- `generation-tool`: tool follow-up requests reset counts instead of accumulating earlier work (AC-05).
- `generation-summary`: compaction/tree counts use the summary widget, not chat UI.

## How to get to it (user POV)

- Send a chat prompt or follow-up to Splash.
- Let a model perform a tool call and continue its response.
- Use compaction or a branch summary, as mapped in [summaries](summaries.md).

## Driving it with verify.py

Preconditions: skill baseline; tools and summarization need additional seed/driver capabilities.

- **Chat estimate.** Run `"$V" run chat`. After the fixture emits three nonempty text chunks,
  inspect `first-generation.screen.txt`: require `Generating` and `≈`, no stale prefill.
  The helper checks phase/approximation; manually inspect compact count formatting and placement.
- **Second prompt reset.** Run `"$V" run cached` and compare both generation snapshots.
  Counters must belong to their own completion; a second user prompt is not a tool follow-up.
- **Final data.** The fixture sends timings predicted_n=9, then usage completion_tokens=7,
  with authoritative generation rate=82.4. These are deliberate conflicting values.
  Cleanup must be immediate; final frames may never be visible in a snapshot. Therefore the helper
  does **not** claim final-count/rate precedence: require deterministic reducer/wiring tests
  and, if needed, a new bounded final-frame fixture gate.
- **Tool path.** Currently BLOCKED: helper uses `--no-tools`, emits no tool calls, and seeds no
  scratch tool side effect. Extend the external fixture with an actual declared Pi tool call,
  execute a harmless scratch-file operation, capture its file result and the next completion,
  then assert counters reset. Never fake an extension event or declare chat-follow-up coverage sufficient.
- **Reasoning/tool/role-only cases.** Require spec §12.1/12.2 fixtures, not assertions over
  the current text-only path.

## Gotchas

- Character/chunk counts are estimates, never exact live tok/s. Approximate counts must carry `≈`.
- Exact authoritative counts may correct downward; zero native rates mean unavailable.
- Text output only proves generation began; it does not prove every raw field reached the extension.
- No persistent report or minimum final-display delay is required. Do not add one to make a screenshot easier.
