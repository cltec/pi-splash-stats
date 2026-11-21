# Summary statistics

**Status: all three journeys PASS end-to-end — `compact`, `tree`, and `tree-negative` — against the
loopback fixture with a real Pi 1.5.2 PTY. Summary statistics are implemented via the scoped
`fetch` observer (S5, ADR 0002). Automatic/recovery compaction and explicit alternate-summary-model
entries remain BLOCKED/unverified.**

Covers SPECIFICATION.md §4.2–4.6 and §10.2. The extension shows the same above-editor
prefill/generation stats for `/compact` and `/tree` branch-summary streams, with Pi's
compaction/branch-summary spinner preserved, and never shows summary stats for
navigate-without-summary.

## How it is implemented

Summary streams do not fire Pi's provider hooks (`before_provider_request`,
`provider_stream_event`); only `before_provider_headers` does. S5 therefore added a **scoped global
`fetch` observer** (`src/fetch-observer.ts`, see `docs/adr/0002-transport-coverage.md` in the
repository) that is installed once per runtime in TUI mode. For an eligible owned summary request it
enriches the body (`return_progress: true`, `stream_options.include_usage: true`) and observes the
SSE response in a single pass, forwarding bytes, status, headers, streaming, backpressure, errors,
and cancellation unchanged. The observer attributes each request to the foreground operation active
at send time (compaction vs. branch) and requires the request's actual backend to be a verified owned
Splash candidate via the identity/discovery modules, so chat requests pass through untouched and no
double-counting occurs. The prefill and generation math and rendering are the same pure modules used
for chat.

Latest passing runs (loopback fixture, real Pi 1.5.2 PTY):

- `run compact` → **PASS** — evidence `20261120T233705-5fdffba5`: the gated prefill snapshot shows
  the above-editor stats (`Prefilling... ██████████░░░░░░░░░░  50% · 2s · 20.0 tok/s`) with Pi's
  `Compacting context...` spinner preserved; the gated generation snapshot shows
  `Generating... ≈5 tok`; the settled idle clears both the stats and the spinner.
- `run tree` → **PASS** — evidence `20261120T233716-ea6c97c2`: the same gated summary assertions
  with the `Summarizing branch...` spinner, then a `Branch summary` entry and a working
  continuation turn.
- `run tree-negative` → **PASS** — evidence `20261120T233727-261e8d26`: "No summary" navigates
  instantly, issues **no** inference request, shows no stats, and the post-navigation chat turn
  works.

## Manual driving

```sh
python3 .cursor/skills/verify-pi-splash-stats/scripts/verify.py run compact
python3 .cursor/skills/verify-pi-splash-stats/scripts/verify.py run tree
python3 .cursor/skills/verify-pi-splash-stats/scripts/verify.py run tree-negative
```

Each run records, under `.verification-evidence/<run-id>/`:

- `summary-request.json` (compact/tree): the actual summary HTTP request — endpoint, model, auth,
  streaming flag, and `return_progress: true` (set by the observer) — captured from the loopback
  server log.
- `summary-prefill.screen.txt` / `summary-generation.screen.txt` (compact/tree): the gated phase
  snapshots, which keep Pi's spinner (`Compacting context...` / `Summarizing branch...`) and the
  above-editor stats.
- `summary-idle.screen.txt` and `after-compact-*-idle.*`: the settled idle after the summary and the
  usable post-summary chat turn (driven by the ordinary chat journey).
- `tree-negative-idle.screen.txt`: no stats and no inference request after
  navigate-without-summary.
- `*-turn-*-idle.*`: the seeded conversation turns; `terminal.ansi`, `actions.jsonl`, `http.jsonl`,
  `files-after.json` (includes the persisted session file), `process-cleanup.json`.

## What the harness asserts

- `compact`: three seeded turns → `/compact` → real summary POST to
  `/splash/v1/chat/completions` (model/auth/stream checked) → gated prefill snapshot
  (spinner + `Prefilling` + `50%` + throughput) → gated generation snapshot (spinner +
  `Generating` + `≈`, no prefill) → settled idle (no stale spinner/stats) → ordinary
  chat journey for the post-compaction response.
- `tree`: three seeded turns → `/tree` → type the first turn's prompt into the tree
  search → require the `›` cursor on that displayed row → Enter → "Summarize" → same
  gated summary assertions as `compact` (spinner `Summarizing branch...`) → require the
  `Branch summary` entry after navigation → ordinary chat journey for the continuation.
- `tree-negative`: same tree selection → "No summary" → require **no** new inference
  request, no stats in the idle snapshot, and a working post-navigation chat turn.

## Gotchas

- **Keep `keepRecentTokens: 200` for `compact`.** With the default 20k, the seeded
  session is too small and Pi reports "Nothing to compact (session too small)" without
  any provider request — the journey would assert on a stream that never happens.
- **Tree selection is text-driven.** The harness types the displayed prompt text into
  the Session Tree's type-to-search filter and requires the `›` cursor on that row.
  Seed prompts are unique per scenario (`Verify <scenario>-turn-<n>.`) so the match is
  exactly one row. Never select by arrow-count coordinates.
- **Navigation restores the prompt into the editor.** After any `/tree` navigation Pi
  puts the target prompt back in the editor; the harness clears it (ctrl+U) before
  sending further commands, or the next paste appends to the restored text.
- **Menu confirmations are explicit key presses.** "No summary" and "Summarize" are
  chosen with deliberate Enter/Down+Enter; a pasted slash command's `\r` can silently
  confirm the menu and consume the command.
- **Summary streams bypass the provider hooks** (see
  `docs/adr/0002-transport-coverage.md` in the repository):
  `before_provider_request`/`provider_stream_event` do not fire for compaction or branch
  summaries in Pi 1.5.2, only `before_provider_headers` does. The scoped `fetch` observer
  is what sees these streams, enriches them, and observes their samples; without it the
  extension neither enriches summary requests nor observes summary progress.
- **Summary progress is observer-sourced.** Because the observer sets `return_progress: true` on
  the owned summary request, the fixture (and a real backend) emits `prompt_progress` samples on the
  summary stream; the same prefill/generation math and rendering as chat then apply. The live
  `summary-request.json` from the passing runs records `return_progress: true` and
  `stream_options: {"include_usage": true}`.
- **Automatic compaction, recovery compaction, and explicit alternate-summary-model
  entries remain BLOCKED**: the fixture cannot drive an automatic overflow/recovery
  compaction deterministically, and the alternate-model entry requires a second provider
  model in the isolated `models.json`. Manual `/compact` and manual `/tree` summarization
  are the drivable entries.
- The infrastructure-only `test_verify.py` stand-in package has no observer and no summary
  support, so it does not drive these journeys; they are driven only by the real extension
  package.

## Required vs optional evidence

| Evidence | Requirement |
| --- | --- |
| Seeded multi-turn conversation (3 real turns, idle-settled) | Required |
| Real summary HTTP request (endpoint/model/auth from server log, `return_progress: true`) | Required for `compact`/`tree` |
| Gated prefill + generation snapshots with Pi spinner preserved | Required for `compact`/`tree` |
| Above-editor prefill/generation stats during the summary stream | Required; passes via the scoped `fetch` observer |
| No stats + no inference for navigate-without-summary | Required |
| Usable post-summary chat response | Required |
| Persisted session file kept as side-effect evidence | Required |
| Automatic/recovery compaction, alternate-summary-model entries | Required for qualification; BLOCKED |
