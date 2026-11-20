# Compaction and branch-summary statistics

During context summarization, users retain Pi's own working spinner while progress and generation
counts appear above the editor. Summaries must be attributed to their actual model/backend.

## Sub-features

- `summary-manual`: manual `/compact` preserves spinner and switches widget phases.
- `summary-auto`: automatic and overflow-recovery compaction use the same lifecycle.
- `summary-tree`: `/tree` with summary requested shows feedback; navigation without summary does not.
- `summary-model`: a different summary backend is verified independently.
- `summary-error`: failure, Escape, or model/session change cannot leave a widget.

## How to get to it (user POV)

- Build a conversation, then enter `/compact` (optionally with instructions).
- Fill enough context to trigger automatic compaction, or encounter overflow recovery.
- Open `/tree`, select an earlier conversation entry, and choose to summarize the abandoned branch.
- Navigate `/tree` without requesting a summary for the negative entry point.

## Driving it with verify.py

Preconditions: an implemented extension, a usable multi-turn conversation/branch, summary-capable
server responses, and a driver that can select the actual tree entry and summary choice.

- **Current result: BLOCKED, not chat coverage.** The supplied helper does not seed or drive
  these journeys. It disables automatic compaction, uses an in-memory session, and emits a short
  chat response—not the summary content/long context needed to establish all preconditions.
- **Manual entry once extended.** Through the owned PTY, submit several genuine conversation
  turns, then the exact editor command `/compact`. Require the actual summary HTTP request,
  capture Pi's preserved compaction spinner + above-editor prefill, then generation, then cleared UI
  and a usable next chat response. A "not enough messages" response is failed preconditions.
- **Tree entry once extended.** Submit at least three turns; send `/tree`; select an earlier
  entry by its displayed prompt text (not hard-coded coordinates). Record the actual menu labels
  from Pi 1.5.2 and select summary. Capture request/backend and both phases; inspect the resulting
  branch summary and then continue chatting. Repeat without summary and require no stats/inference.
- **Automatic/recovery entry once extended.** Seed real context usage and a compatible overflow
  error through the external provider boundary. Record the triggering prompt, actual summary call,
  preserved spinner, cleanup, and successful recovery. Do not invoke lifecycle handlers directly.
- **Alternate summary model/failures.** Extend the fixture/driver to select the summary backend,
  then repeat with non-Splash ownership, disconnect, and Escape. Record each independently.

## Gotchas

- Missing conversation, branch, overflow seed, menu automation or valid summary response is a
  blocker to record, never permission to replace a journey with normal chat.
- Ordinary chat provider hooks do not establish summary hook delivery. Public-hook or fetch-observer
  transport coverage must be demonstrated for each phase (spec §10.2), with ADR evidence.
- A summary can use another model; selected chat identity alone is not enough.
- The helper's `--no-session` keeps state in memory; it proves no persisted-session branch journey.
  Add isolated session storage if persistence/navigation needs it, and preserve that side-effect evidence.
