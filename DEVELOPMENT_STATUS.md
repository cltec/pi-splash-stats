# DEVELOPMENT_STATUS — pi-splash-stats

Legend: `planned → implementing → awaiting verification → verified → integrated`;
`blocked` / `rework` when applicable. Leader integrates only after reviewer PASS on the exact
worker revision, then re-runs affected gates on `main`.

## Slice states

| Slice | State | Owner | Verifier | Branch/worktree | Commits | Evidence | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| S0 baseline (git init, pinned template import, team provisioning, plan) | integrated | leader | — | main | `25f5bec`, `963738d` | diff -r vs pinned clone (byte-identical) | Template @ `affec8daf662ecd815a87639ab55545acdc38089` |
| S1 package adaptation + silent walking skeleton | integrated | worker-impl-a | reviewer | `s1-walking-skeleton` | `7347722` (ff) | s1 worktree: doctor `20261120T112712-7184a53a`; print `20261120T112722-94b32673`; json `20261120T112724-25747893`; rpc `20261120T112727-181a96dd`; non-splash `20261120T112729-dde92c02` (reviewer re-runs, payload-hash equality) | Reviewer PASS: package identity, silence, isolation, privacy. `test:e2e` packed-archive step fails on this macOS host: pre-existing bsdtar lacks GNU `--quoting-style=escape` (harness byte-identical to baseline; independently root-caused). Checkout-RPC + headless-JSON e2e pass. |
| S2+S3 identity + prefill + generation (combined) | integrated | worker-impl-a | reviewer | `s2-identity-prefill` | `688bb83` + rework `93e0167` (no-ff merge `5deffce`) | reviewer re-runs: doctor `20261120T125814-69fca55c`; chat `20261120T125825-5ea6284b` / post-rework `20261120T141102-ae880875`; cached `20261120T125833-e26cacf9`; non-splash `20261120T125839-f1296c50`; switch `20261120T125846-4cdb0e6a`; abort-prefill `20261120T125854-6e24ce6a`; reload `20261120T130114-16c51eca`; print/json/rpc `20261120T130121-*` | Reviewer round 1 FAIL (one gap: generation path bypassed §10.3 ≤10/s coalescing) → rework `93e0167` → round 2 PASS (157/157, chat PASS, clean teardown). `V run abort-generation` FAILs deterministically: INDEPENDENTLY CONFIRMED harness race (fixture emits finish+usage+[DONE] 0.2–0.4 ms after Escape; no-op baseline package fails identically). Recorded as known harness limitation. Post-integration re-run on main: 157/157 + chat/non-splash/switch/abort-prefill/print all exit 0. |
| S2 identity-verified first request + prefill | (merged into S2+S3) | — | — | — | — | — | |
| S4 lifecycle, non-TUI modes, reload, ownership | implementing | worker-impl-a | reviewer | `s4-lifecycle` | — | — | depends S2+S3 (integrated), S5a (integrated) |
| S5a summary-transport spike + ADR input | integrated (ADR input) | worker-impl-b | reviewer | `s5a-summary-spike` | `44bac97`, `3aad43e` + ADR wording fix | s5a worktree `probe/evidence-rpc/`, `probe/evidence-tui/`, `docs/adr/0002-transport-coverage.md` | Reviewer PASS: hooks fire only for chat; compaction/tree summaries bypass `before_provider_request`/`provider_stream_event` (static + live evidence). Fetch observer required for S5. |
| S5h harness extension: compact/tree journeys (parallel) | implementing | worker-impl-b | reviewer | `s5h-harness` | — | — | owns .cursor/skills only; journeys expected FAIL/BLOCKED until S5 impl |
| S5 compaction/tree summaries + harness extension | planned | worker-impl-b | reviewer | — | — | — | depends S4, S5a (integrated), S5h |
| S6 packed package, docs, final gates, qualification | planned | worker-impl-a | reviewer | — | — | — | depends S4/S5 |

## AC coverage (running)

Fixture-scoped progress (all statuses = "verified in fixture scope" unless noted; real-Splash
qualification still open for every AC):

| AC | Status | Evidence |
| --- | --- | --- |
| AC-01 | verified (checkout load; packed journey pending S6) | S1 reviewer report; `npm` gates green on main `5deffce` |
| AC-02 | PARTIAL — auto activation proven for directly launched Pi with configured provider; `splash pi` launcher pending real Splash | S2 chat run `20261120T141102-ae880875` |
| AC-03 | verified (fixture) | S2 chat run; 50% prefill after bounded discovery |
| AC-04 | verified (fixture) | S2 chat + cached runs (cache=20 baseline, 20.0 tok/s) |
| AC-05 | PARTIAL — chat verified (≈ counts, widget); tool-follow-up + summaries pending (S5) | S2 chat/cached runs |
| AC-06 | PARTIAL — reducer precedence + zero-rate verified offline (157 tests); final-frame fixture gate absent (documented) | S2 `test/progress.test.ts`; reviewer math spot-checks |
| AC-07 | verified (fixture, deceptive provider named `splash`) | S2 non-splash run `20261120T125839-f1296c50` |
| AC-08 | verified (fixture: llama.cpp-owned endpoint with compatible timings stays silent) | same non-splash run |
| AC-09 | verified (fixture) | S2 switch run `20261120T125846-4cdb0e6a` |
| AC-10 | PARTIAL — non-default port, prefixed mount, dummy auth verified; IPv6/aliases/remote pending (offline tests + real Splash) | S2 runs + offline suites |
| AC-11 | PARTIAL — abort-prefill, reload, shutdown verified; abort-generation BLOCKED by harness race (confirmed, no-op baseline fails identically); mid-flight races pending S4 wiring | S2 runs; reviewer race ruling |
| AC-12 | PARTIAL — no persistence/config mutation in fixture runs; full source audit pending S6 | S1/S2 reviewer privacy findings |
| AC-13 | verified (fixture) | S2 print/json/rpc runs `20261120T130121-*` |
| AC-14 | in progress — offline/package/real-Pi-fixture gates green on main; packed + real Splash pending | main `5deffce` gate sweep |
| AC-15 | PARTIAL — direct-Pi identity-based activation verified; `splash pi` equivalence pending real Splash | S2 chat + non-splash runs |

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
- 2026-11-20: S2+S3 verified (reviewer: FAIL → minimal coalescing rework → PASS; abort-generation
  confirmed harness race via no-op baseline reproduction) → merged no-ff to `main` (`5deffce`);
  post-integration re-checks green (157/157, chat/non-splash/switch/abort-prefill/print). Assigned S4
  (worker-impl-a) and S5h harness extension (worker-impl-b, parallel, skill-tree owned).
