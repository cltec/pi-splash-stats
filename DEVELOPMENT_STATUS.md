# DEVELOPMENT_STATUS — pi-splash-stats

Legend: `planned → implementing → awaiting verification → verified → integrated`;
`blocked` / `rework` when applicable. Leader integrates only after reviewer PASS on the exact
worker revision, then re-runs affected gates on `main`.

## Slice states

| Slice | State | Owner | Verifier | Branch/worktree | Commits | Evidence | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| S0 baseline (git init, pinned template import, team provisioning, plan) | integrated | leader | — | main | `25f5bec`, `963738d` | diff -r vs pinned clone (byte-identical) | Template @ `affec8daf662ecd815a87639ab55545acdc38089` |
| S1 package adaptation + silent walking skeleton | integrated | worker-impl-a | reviewer | `s1-walking-skeleton` | `7347722` (ff) | s1 worktree: doctor `20261120T112712-7184a53a`; print `20261120T112722-94b32673`; json `20261120T112724-25747893`; rpc `20261120T112727-181a96dd`; non-splash `20261120T112729-dde92c02` (reviewer re-runs, payload-hash equality) | Reviewer PASS: package identity, silence, isolation, privacy. `test:e2e` packed-archive step fails on this macOS host: pre-existing bsdtar lacks GNU `--quoting-style=escape` (harness byte-identical to baseline; independently root-caused). Checkout-RPC + headless-JSON e2e pass. |
| S2+S3 identity + prefill + generation (combined) | implementing | worker-impl-a | reviewer | `s2-identity-prefill` | — | — | merged slice (harness gate coupling); depends S1 |
| S2 identity-verified first request + prefill | (merged into S2+S3) | — | — | — | — | — | |
| S4 lifecycle, non-TUI modes, reload, ownership | planned | worker-impl-a | reviewer | — | — | — | depends S2+S3, S5a |
| S5a summary-transport spike + ADR input | integrated (ADR input) | worker-impl-b | reviewer | `s5a-summary-spike` | `44bac97`, `3aad43e` + ADR wording fix | s5a worktree `probe/evidence-rpc/`, `probe/evidence-tui/`, `docs/adr/0002-transport-coverage.md` | Reviewer PASS: hooks fire only for chat; compaction/tree summaries bypass `before_provider_request`/`provider_stream_event` (static + live evidence). Fetch observer required for S5. |
| S5 compaction/tree summaries + harness extension | planned | worker-impl-b | reviewer | — | — | — | depends S4, S5a (integrated) |
| S6 packed package, docs, final gates, qualification | planned | worker-impl-a | reviewer | — | — | — | depends S4/S5 |

## AC coverage (running)

No acceptance criteria verified yet. Harness-only passes (`.verification-evidence/20261120T*`)
are infrastructure proof only and count for no AC.

| AC | Status | Evidence |
| --- | --- | --- |
| AC-01 … AC-15 | not started | — |

## Uncovered / blocked

- Real Splash §12.4 manual qualification: BLOCKED (no real Splash install/model in this
  environment so far; to be confirmed during S6).
- Tool-follow-up, summary, mid-flight race, narrow-terminal journeys: harness gaps, tracked in
  S5/S6 and offline tests.

## Progress log

- 2026-11-20: Leader inspected repo (spec-only, no git). Initialized git, imported pinned
  template (byte-identical), provisioned 3 same-model subagents (capability-probed), wrote
  `DEVELOPMENT_PLAN.md`. Assigned S1 + S5a.
- 2026-11-20: S1 PASS (reviewer re-ran all gates on `7347722`; payload-hash equality; clean
  teardown) → integrated ff to `main`. S5a spike PASS (hooks miss summary requests; ADR 0002
  accepted) → merged to `main` with one wording fix. Post-integration re-checks on `main`:
  `npm test`/`npm run check`/`npm pack --dry-run` green, `doctor` READY_TO_LAUNCH.
  Merged S2+S3 into one assignment (harness `chat` gate couples prefill+generation; shared files).
  Assigned S2+S3.
