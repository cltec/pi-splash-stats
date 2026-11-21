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
| S4 lifecycle, non-TUI modes, reload, ownership | integrated | worker-impl-a | reviewer | `s4-lifecycle` | `25bc73e` (no-ff merge `4f071ca`) | reviewer re-runs `20261120T155110-*`…`155308-*` (9 PASS + known abort-generation race) | Reviewer PASS: ownership generations, finalize-once, safety net, shutdown disposal, reload fresh cache, coexistence. Post-integration: 162/162 + 8 journeys PASS on main. Residual (accepted): same-model late-chunk ambiguity at hook layer — resolved by S5 observer attribution. |
| S5a summary-transport spike + ADR input | integrated (ADR input) | worker-impl-b | reviewer | `s5a-summary-spike` | `44bac97`, `3aad43e` + ADR wording fix | s5a worktree `probe/evidence-rpc/`, `probe/evidence-tui/`, `docs/adr/0002-transport-coverage.md` | Reviewer PASS: hooks fire only for chat; compaction/tree summaries bypass `before_provider_request`/`provider_stream_event` (static + live evidence). Fetch observer required for S5. |
| S5h harness extension: compact/tree journeys (parallel) | integrated | worker-impl-b | reviewer | `s5h-harness` | `532a5aa` → rework `5daabf2` (no-ff merge `ec34b31`) | reviewer re-runs: compact `20261120T162211-66c3124c`, tree `20261120T162225-305b93eb`, tree-negative `20261120T162237-8261bfbf` | Round 1 FAIL (harness captured seed-turn POST as summary request; false "header hook enrichment" doc claim) → rework → PASS. summary-request.json shows the genuine summary POST with `return_progress: null` (confirms ADR 0002; pi-ai adds include_usage natively). Honest red path: compact/tree FAIL at first summary-stats assertion = S5 product gap. |
| S5 compaction/tree summaries + fetch observer | integrated | worker-impl-b | reviewer | `s5-summaries` | `d8f3d8e` + follow-up `1d724e1` (no-ff merge `7bca16c`) | reviewer sweep: compact `20261120T175229-884c4cb3`, tree `20261120T175244-d33defde`, tree-negative `20261120T175255-99f801f5` + 9 regression journeys; follow-up re-verify 198/198 | Reviewer PASS after one evidence-location ruling (typo, checkouts confirmed correct) + 2 non-gating follow-ups (ADR `return_progress` sentence; retained-wrapper unit test). §10.2 observer verified bullet-by-bullet; ADR 0002 Accepted. Post-integration: 198/198 + 13 journeys green on main. |
| s6h harness: abort-generation race fix (parallel) | integrated | worker-impl-a | reviewer | `s6h-abort-race` | `22aecf9` (no-ff merge `754009f`) | reviewer re-runs: abort-generation ×2 PASS (`20261120T174830-cd7c95b6`, `…174842-87e28c8c`) + chat/abort-prefill/non-splash | Reviewer PASS: 0.5 s final-frame hold (`ABORT_GENERATION_HOLD_SECONDS`), abort-generation scenario only, no assertion changes. abort-generation now deterministic on main. |
| S6 packed package, docs, final gates, qualification | integrated | worker-impl-a | reviewer | `s6-final` | `fb2a7e0`…`c006dc2` + rework `f815f1c` (no-ff merge `d1ec81e`) | reviewer sweep: all 14 journeys PASS (packed `20261120T204117-15f9419f`), e2e 4/4 incl. portable packed-archive, 198/198; rework re-verify `20261121T022831-*` | Round 1 FAIL (docs-only: summaries.md stale, README missing `splash pi` workflow, ADR missing timing-field rationale, template leftovers) → rework → PASS. Packed journey loads the npm-packed tarball (no --extension). Qualification record final: real Splash NOT PERFORMED. |

## AC coverage (running)

Fixture-scoped progress (all statuses = "verified in fixture scope" unless noted; real-Splash
qualification still open for every AC):

| AC | Status | Evidence |
| --- | --- | --- |
| AC-01 | verified (checkout load + packed-tarball journey) | S6 packed run `20261120T204117-15f9419f`; final sweep on `d1ec81e` |
| AC-02 | verified (fixture) — direct-Pi auto activation; `splash pi` documented, real-launcher equivalence pending real Splash | S6 chat run; README workflow section |
| AC-03 | verified (fixture) | final sweep chat run on `d1ec81e` |
| AC-04 | verified (fixture) | final sweep chat + cached runs |
| AC-05 | verified (fixture) — chat + compaction + branch summaries (≈ counts, widget); tool-follow-up pending real Splash | final sweep chat/compact/tree runs |
| AC-06 | verified (fixture + offline) — reducer precedence, zero-rate, final-frame via harness gates | 198 offline tests + journey gates |
| AC-07 | verified (fixture, deceptive provider named `splash`) | final sweep non-splash run |
| AC-08 | verified (fixture: llama.cpp-owned endpoint with compatible timings stays silent) | final sweep non-splash run; ADR 0001 rationale |
| AC-09 | verified (fixture) | final sweep switch run |
| AC-10 | PARTIAL — non-default port, prefixed mount, dummy auth verified (fixture); IPv6/aliases/remote pending real Splash | S2/S6 runs + offline suites |
| AC-11 | verified (fixture) — abort-prefill, abort-generation (post s6h), reload, shutdown | final sweep runs |
| AC-12 | verified (fixture + source audit) — no persistence/config mutation; reviewer privacy audits each slice | reviewer privacy findings S1–S6 |
| AC-13 | verified (fixture) | final sweep print/json/rpc runs |
| AC-14 | PARTIAL — offline/package/real-Pi-fixture/packed gates all green with recorded evidence; real Splash manual qualification NOT PERFORMED (no real Splash in environment) | qualification record; final sweep on `d1ec81e` |
| AC-15 | PARTIAL — direct-Pi identity-based activation verified (fixture); `splash pi` equivalence pending real Splash | S6 runs; README |

## Uncovered / blocked

- Real Splash §12.4 manual qualification: NOT PERFORMED — no real Splash install/model in this
  environment. Recorded as unverified in the qualification record (spec-permitted residual;
  everything fixture-verifiable is verified).
- Real-Splash-only residuals: `splash pi` launcher equivalence, tool follow-up, automatic/recovery
  compaction, alternate summary model, remote/IPv6/auth-failure paths, exact final transient
  counts, narrow layout, other-extension coexistence under load.

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
  (worker-impl-a) and S5h harness extension (worker-impl-b, parallel, skill-tree owned). S4 PASS →
  integrated (`4f071ca`; 162/162 + 8 journeys green on main). S5h FAIL (wrong POST capture + false doc
  claim) → rework → PASS → integrated (`ec34b31`). Transport decision for S5: scoped fetch observer
  with observer-side enrichment of owned verified summary requests. Assigned S5 + s6h (abort-generation
  fixture race fix, parallel). S5 + s6h both verified PASS (S5 after evidence-location ruling + 2
  non-gating follow-ups) → integrated (`754009f`, `7bca16c`; 198/198 + 13 journeys green on main).
  S6 round 1 FAIL (docs-only: stale summaries.md, missing `splash pi` workflow, missing ADR
  timing-field rationale, template leftovers) → rework `f815f1c` → PASS → integrated (`d1ec81e`).
  FINAL state on main: 198/198 tests, e2e 4/4 (portable packed-archive), all 14 harness journeys
  PASS incl. packed-tarball journey; real Splash qualification recorded as NOT PERFORMED.
  All slices complete.
