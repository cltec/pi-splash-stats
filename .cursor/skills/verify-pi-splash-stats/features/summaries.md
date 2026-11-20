# Summary statistics

**Status: `compact` and `tree` journeys are drivable and currently FAIL at the product stats assertions (summary stats not implemented); `tree-negative` (navigate without summary) PASSES end-to-end. Automatic/recovery compaction and explicit alternate-summary-model entries remain BLOCKED.**

Covers SPECIFICATION.md §4.2–4.6 and §10.2. The extension must show the same above-editor
prefill/generation stats for `/compact` and `/tree` branch-summary streams, with Pi's
compaction/branch-summary spinner preserved, and must never show summary stats for
navigate-without-summary.

## Current implementation status (2026-11-20)

- `scripts/verify.py` drives all three journeys against the loopback fixture with a real
  Pi 1.5.2 PTY: seeded multi-turn conversations (3 real user turns each), the exact
  `/compact` command, and the `/tree` Session Tree with **type-to-search selection by the
  displayed prompt text** (never coordinates), then the "Summarize" / "No summary" menu.
- Summary streams are gated by the fixture exactly like chat (held prefill + generation),
  and `keepRecentTokens: 200` is set in the isolated settings for `compact` so the small
  seeded session actually issues a summary request (the default 20k makes small sessions
  report "Nothing to compact (session too small)").
- Summary journeys run with **persisted in-scratch sessions** (no `--no-session`); the
  session file is kept as side-effect evidence in `files-after.json`.
- Recorded outcomes on the current extension (S2–S4 chat stats only; no summary support):
  - `run compact` → **FAIL**: "Expected summary prefill stats". The real summary HTTP
    request fires and is captured as that request itself in `summary-request.json`
    (`return_progress: null` — see the enrichment gotcha below), the Pi
    `Compacting context...` spinner is captured in `summary-prefill.screen.txt`, and the
    run fails at the first above-editor-stats assertion. Cleanup is clean and
    `files-after.json` is written even on this failing run.
  - `run tree` → **FAIL**: "Expected summary prefill stats". Type-to-search lands the
    cursor on the target entry (`(1/1)` in `terminal.ansi`), the "Summarize" choice fires
    the real branch-summary request, and the `Summarizing branch...` spinner is captured.
  - `run tree-negative` → **PASS**: "No summary" navigates instantly, issues **no**
    inference request, shows no stats, and the post-navigation chat turn works.

## Manual driving

```sh
python3 .cursor/skills/verify-pi-splash-stats/scripts/verify.py run compact
python3 .cursor/skills/verify-pi-splash-stats/scripts/verify.py run tree
python3 .cursor/skills/verify-pi-splash-stats/scripts/verify.py run tree-negative
```

Each run records, under `.verification-evidence/<run-id>/`:

- `summary-request.json` (compact/tree): the actual summary HTTP request — endpoint,
  model, auth, streaming flag — captured from the loopback server log.
- `summary-prefill.screen.txt` / `summary-generation.screen.txt` (compact/tree): the
  gated phase snapshots, which must keep Pi's spinner (`Compacting context...` /
  `Summarizing branch...`) and (once implemented) the above-editor stats.
- `tree-negative-idle.screen.txt`: no stats and no inference request after
  navigate-without-summary.
- `*-turn-*-idle.*`: the seeded conversation turns; `after-*` snapshots: the usable
  post-summary chat turn driven by the ordinary chat journey.
- `terminal.ansi`, `actions.jsonl`, `http.jsonl`, `files-after.json` (includes the
  persisted session file), `process-cleanup.json`.

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
  chosen with Deliberate Enter/Down+Enter; a pasted slash command's `\r` can silently
  confirm the menu and consume the command.
- **Summary streams bypass the provider hooks** (see `docs/adr/0002-transport-coverage.md`
  in the repository): `before_provider_request`/`after_provider_response`/
  `provider_stream_event` do not fire for compaction or branch summaries in Pi 1.5.2, only
  `before_provider_headers` does. The extension has no summary hook today (no header hook,
  no stream hook), so it neither enriches summary requests nor observes summary samples;
  S5 needs a scoped fetch observer for summary streams. Until it lands, `compact`/`tree`
  fail at the stats assertions even though the request, spinner, and gating all work.
- **The summary request body is not enriched by the extension.** The captured summary
  POST has `return_progress: null` — `before_provider_request` does not fire for
  summaries (ADR 0002), so the extension cannot add it. The
  `stream_options.include_usage` in the body is added natively by pi-ai's
  openai-completions transport, not by the extension. The extension has no header hook.
- **S5 consequence — summary progress sourcing is undecided.** The loopback fixture emits
  `prompt_progress` samples only when the payload has `return_progress: true`. Summary
  payloads do not, so the fixture never emits summary progress and the `compact`/`tree`
  prefill-stats assertions cannot pass until S5 decides how summary progress is sourced —
  observer-side enrichment of the owned summary requests versus a fixture behavior change.
  That is an S5 decision to be documented against SPECIFICATION.md §6/§10.2; the harness
  records the red assertion as-is and does not paper over it.
- **Automatic compaction, recovery compaction, and explicit alternate-summary-model
  entries remain BLOCKED**: the fixture cannot drive an automatic overflow/recovery
  compaction deterministically, and the alternate-model entry requires a second provider
  model in the isolated `models.json`. Manual `/compact` and manual `/tree` summarization
  are the drivable entries.
- The no-op harness package fails these journeys on the same stats assertions as the
  chat journey; that red path is expected and recorded, never papered over.

## Required vs optional evidence

| Evidence | Requirement |
| --- | --- |
| Seeded multi-turn conversation (3 real turns, idle-settled) | Required |
| Real summary HTTP request (endpoint/model/auth from server log) | Required for `compact`/`tree` |
| Gated prefill + generation snapshots with Pi spinner preserved | Required for `compact`/`tree` |
| Above-editor prefill/generation stats during the summary stream | Required once implemented; the current honest failure point |
| No stats + no inference for navigate-without-summary | Required |
| Usable post-summary chat response | Required |
| Persisted session file kept as side-effect evidence | Required |
| Automatic/recovery compaction, alternate-summary-model entries | Required for qualification; BLOCKED |
