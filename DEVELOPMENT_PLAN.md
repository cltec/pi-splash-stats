# DEVELOPMENT_PLAN — pi-splash-stats

Role: Team Leader / integration owner. Authority: `SPECIFICATION.md`. Verification how-to:
`.cursor/skills/verify-pi-splash-stats/SKILL.md` + `features/` map.

## 1. Observed baseline (2026-11-20)

- Repo root was **not** a Git repository; only `SPECIFICATION.md`, the verification skill/harness,
  `DEVELOPMENT_PROMPT.md`, and `.verification-evidence/` (harness-only runs) existed. No package,
  no source, no tests.
- Leader actions taken before delegation (commits on `main`):
  1. `25f5bec` — committed the pre-implementation baseline.
  2. `963738d` — imported `pi-extension-template` at the spec-pinned commit
     `affec8daf662ecd815a87639ab55545acdc38089` (verified byte-identical with `diff -r`).
- `verify.py doctor` → exit 2, **BLOCKED: no package.json** (expected pre-implementation).
- Harness is proven infrastructure-only: `self-test` = HARNESS_ONLY_PASS; `test_verify.py` green.
  That is **not** extension proof.

## 2. Tool and model availability

| Item | Value |
| --- | --- |
| Main agent model (effective) | `ukisai/Swift-1.5-Qwen3.8-27B-GGUF:Q4_K_M` (provider `splash`) |
| Subagent pool (max 3, all same model, `model=` set explicitly per call) | `worker-impl-a` (writable), `worker-impl-b` (writable), `reviewer` (independent verifier). Defined in `~/.pi/agent/agents/`, capability-probed OK. |
| No further delegation | Workers/reviewer are instructed never to call `subagent`. |
| Pi | 1.5.2 installed at `/Users/cirolucio.tecce/.pi/agent/install/releases/1.5.2` (spec baseline) |
| Node / Python | v22.23.5 (≥22.18.0) / 3.13.18; `fd`, `rg` present |
| Template source | `git@github.com:cltec/pi-extension-template.git` @ `affec8daf662ecd815a87639ab55545acdc38089` (cloneable; imported) |
| Isolation strategy | Git worktrees per assignment off `main`; no two workers share files concurrently; integration is leader-only cherry-pick/merge of reviewed commits; worker branches never self-merge. |

## 3. Dependency graph and vertical slices

```
S0 (leader, done): git init + pinned template import + team provisioning
S1 walking skeleton ──> S2 identity+prefill ──> S3 generation ──> S4 lifecycle/modes/reload
                          │
S5a summary-transport spike (parallel, worker-impl-b, own worktree; read-real-Pi only)
                          └──────────────────────────> S5 summaries (needs S4 UI ownership + S5a ADR)
S6 packaging/docs/final gates (after S4, S5 merged; S5 harness work may feed in earlier)
```

### S1 — Package adaptation + silent walking skeleton
- **Outcome:** `pi-splash-stats` loads through its manifest in real Pi and is completely
  invisible: no command, no output, no request modification, in TUI and non-TUI modes.
- **Scope:** rename package metadata (name `pi-splash-stats`, `private: true`, keep
  `pi.extensions: ["./src/index.ts"]`, peer deps, engines, Apache-2.0 LICENSE); delete
  `/hello`, `template-greeting`, greeting module/tests; adapt README/AGENTS minimally; keep
  check-package allowlist, isolation scripts, e2e harness, package allowlist semantics
  (allow new source files as needed); e2e smoke assertions adapted to a silent extension.
- **Non-goals:** any stats behavior (S2+), any docs beyond package rename accuracy.
- **Files:** `package.json`, `src/**`, `test/**`, `e2e/**`, `scripts/check-package.mjs` (only if
  allowlist must widen for new module layout), `README.md` (rename), `CHANGELOG.md`.
- **Owner:** worker-impl-a. **Verifier:** reviewer. **Depends on:** S0.
- **Verification (worker + reviewer, in worktree):**
  `npm test`; `npm run check:package`; `npm run check`; `npm run test:e2e`; `npm pack --dry-run`;
  `V doctor` → `READY_TO_LAUNCH`; `V run print`, `V run json`, `V run rpc`, `V run non-splash`
  (payload hash must equal no-extension baseline).
- **Evidence:** `.verification-evidence/<run-id>/result.json` + `http.jsonl` + baseline diff.
- **Gate:** all above green on the exact worker revision; reviewer PASS.

### S2 — Identity-verified first Splash request with prefill
- **Outcome:** first chat request to a verified Splash endpoint shows the cache-aware prefill
  line (bar/%/rate/ETA) as Pi's working message; non-Splash endpoints remain byte-identical.
- **Scope:** `src/identity.ts` (URL normalization, candidate rule, identity response validation
  incl. exact `owned_by: "splash"` + id match); `src/discovery.ts` (bounded 2 s discovery,
  dedupe, 60 s positive / 5 s negative caches, non-secret auth-context key, no redirects,
  1 MiB bound); `src/transport.ts` (eligibility: endpoint+method+model+session ownership;
  enrichment `return_progress: true`, `stream_options.include_usage: true` preserving nested
  options; non-mutating; malformed-body passthrough); `src/progress.ts` (spec §7.2/7.3 pure
  math: validation, cache-aware %, ≤20 rate samples, ETA, suppression rules); `src/format.ts`
  (§8.2 compact line, 20-cell bar, narrow adaptation); `src/ui.ts` (working-message ownership
  only for chat prefill); `src/index.ts` wiring (`session_start`/`model_select` discovery,
  TUI-mode gate via `ctx.mode`). Offline tests per §12.1 items 1–6, 9, 10.
- **Non-goals:** generation widget (S3), summary transport (S5), reload hardening (S4).
- **Depends on:** S1. **Owner:** worker-impl-a. **Verifier:** reviewer.
- **Verification:** `npm test`; `V run chat` (50% · 20.0 tok/s prefill assertions, generation
  snapshot has no prefill, idle empty); `V run non-splash` (silent + baseline payload hash);
  `V run switch` (clear on switch away, resume on return); `V run abort-prefill`.
- **Gate:** reviewer PASS on exact revision; AC-03/04/07/08/09/10/15 (fixture scope) evidenced.

### S3 — Generation feedback, final counts, per-request resets
- **Outcome:** live `≈` estimated generation count in the `pi-splash-stats` widget during chat
  generation (after prefill line is restored to default), replaced by exact
  `usage.completion_tokens` > `timings.predicted_n`, authoritative final rates shown only when
  valid; counters reset per request.
- **Scope:** progress.ts generation reducer (chunk/char estimate, role-only/keepalive exclusion,
  tool-fragment counting without retention); final-count/rate precedence and zero-rate
  suppression; ui.ts widget ownership (only namespaced widget; 10 Hz coalescing; dedupe);
  transport.ts phase handoff prefill→generation; offline tests §12.1 items 7, 8 and wiring
  tests for reset/finalize-once.
- **Depends on:** S2. **Owner:** worker-impl-a. **Verifier:** reviewer.
- **Verification:** `npm test`; `V run chat` (≈ generation, no stale prefill); `V run cached`
  (fresh counters on second prompt); `V run abort-generation`; reducer wiring tests for
  usage-vs-timings precedence (fixture cannot assert final frame — documented).
- **Gate:** reviewer PASS; AC-05/06 (chat scope) evidenced.

### S4 — Lifecycle, ownership, non-TUI modes, reload
- **Outcome:** abort/error/session-replacement/shutdown/reload leave no stale UI, handles, or
  rejections; print/JSON/RPC fully silent with zero discovery/enrichment; other extensions'
  widgets and fetch wrappers preserved.
- **Scope:** full §9 state machine (selection generation, phase, finalize-once,
  `turn_end`/`agent_settled` safety net, `session_shutdown` disposal, `/reload` single
  runtime); fetch-observer disposal rules per §10.2 (inert wrappers, restore-only-if-ours) if
  introduced by S5a/S5; non-TUI gate (`ctx.mode === "tui"`); wiring tests: reload no-stacking,
  retained old wrapper callable, concurrent/late streams, coexistence.
- **Depends on:** S2 (+ S3 for UI paths); consumes S5a spike findings.
- **Owner:** worker-impl-a. **Verifier:** reviewer.
- **Verification:** `npm test`; `V run reload` (reload completes + working next chat);
  `V run print/json/rpc` (no stats, zero discovery, baseline payload equality);
  `V run abort-prefill/abort-generation`; wiring suite.
- **Gate:** reviewer PASS; AC-11/13 evidenced (fixture scope).

### S5a — Summary-transport spike (early, parallel)
- **Outcome:** evidence-based answer: do `before_provider_request` / `provider_stream_event`
  fire for real compaction and `/tree` summary requests in Pi 1.5.2? If not, which scoped
  fetch-observer design satisfies §10.2, with foreground-attribution and reload semantics.
- **Scope:** read Pi 1.5.2 sources (summarization path), run isolated real-Pi probes with a
  throwaway probe extension in an **own worktree**; no changes to `main`; write ADR draft
  `docs/adr/0002-transport-coverage.md` (input to S4/S5).
- **Depends on:** S0. **Owner:** worker-impl-b. **Verifier:** reviewer (evidence review).
- **Gate:** ADR input accepted; no code on `main`.

### S5 — Compaction and branch-summary paths (incl. harness extension)
- **Outcome:** compaction (manual/auto/recovery) and `/tree` summary show widget
  prefill/generation counts with Pi's spinner intact; summary requests attributed to their
  actual backend; failures/Escape/model-switch clean up.
- **Scope:** extend `verify.py` fixture/driver to seed multi-turn conversation, `/compact`,
  `/tree` + summary selection (per `features/summaries.md`); implement summary phase in
  extension (widget placement, per-phase identity verification of the summary model);
  fetch observer (if required) per §10.2 constraints; update feature map + skill record.
- **Depends on:** S4, S5a. **Owner:** worker-impl-b (harness+impl) — serialized with
  worker-impl-a (no concurrent `main` edits); **Verifier:** reviewer.
- **Verification:** `npm test`; new `V run compact`, `V run tree` journeys (once added);
  regression: `V run chat/cached/switch/abort-*/reload/print/json/rpc/non-splash`.
- **Gate:** reviewer PASS; AC-05/11 summary scope evidenced.

### S6 — Packed package, docs, final gates, qualification record
- **Outcome:** packed archive loads through its manifest (no checkout fallback); full
  §14 deliverables; AC matrix complete; release gates honest.
- **Scope:** packed-package journey per `features/lifecycle-and-modes.md`
  (`npm --offline pack` → extract → `V run chat/non-splash --package`); README/ARCHITECTURE/
  TESTING/TROUBLESHOOTING/SECURITY/CHANGELOG; ADR 0001 (identity/discovery, why timing fields
  are unsafe) + ADR 0002 (transport); qualification-status.md + feature map updates
  (`/maintain-verification-skill`); full gate sweep.
- **Depends on:** S4 (+ S5). **Owner:** worker-impl-a. **Verifier:** reviewer.
- **Verification:** all `npm` gates; packed journey; full `V run` sweep on the integrated tree.
- **Gate:** reviewer PASS; AC-01/14 evidenced; AC-12 re-audited (source + side-effect evidence).

## 4. Risks / blockers

| Risk | Mitigation |
| --- | --- |
| **Summary transport**: chat hooks may not fire for compaction/tree summaries (spec §10.2). | S5a spike early, before S3/S4 harden transport; fetch-observer design decided by evidence, recorded in ADR. If public API cannot cover it → explicit blocker, not silent omission. |
| **Actual request attribution** for a fetch observer (endpoint match alone insufficient). | Observer keyed on foreground-operation identity (session generation + phase + endpoint + model); wiring tests for concurrent/late streams; suppression on ambiguity. |
| **Observer disposal / reload** (stacked wrappers, inert capture). | §10.2 disposal rules + S4 wiring tests (reload no-stacking, old wrapper callable, restore-only-if-ours). |
| **Harness gaps** (no tool follow-ups, no summary seeding, no final-frame gate, no narrow terminals). | Offline reducer/wiring tests carry those AC parts now; harness extended in S5 (summaries) and S6 as needed; gaps recorded as BLOCKED, never substituted by chat. |
| **Real Splash qualification** (needs real Splash 1.7.0 + model + Apple Silicon inference). | §12.4 manual qualification recorded separately; if hardware/model unavailable → left explicitly unverified; not a release gate for fixture-scoped slices. |
| **Local model (Swift 27B GGUF) as implementer**: possible long-context instability. | Small isolated briefs; persistent sessions; reviewer re-runs everything; leader integrates only reviewed commits. |

## 5. Parallelism rules

- Main line (S1→S2→S3→S4→S6) is serialized: same core files (`src/index.ts`, `ui.ts`,
  `transport.ts`).
- S5a runs in parallel (own worktree, read-real-Pi probes, no `main` writes).
- S5 may start its harness extension (skill files) in parallel with S4 since the skill tree
  is owned separately — but extension-code changes serialize after S4.
- At most 3 active subagents; reviewer never assigned to code it implemented.

## 6. Standing constraints (all slices)

- Same model on every delegation: `ukisai/Swift-1.5-Qwen3.8-27B-GGUF:Q4_K_M`.
- No new runtime dependencies; host packages stay peers; `private: true`; no publish/tag.
- No persisted statistics, no prompt/secret exposure in diagnostics, no unrelated inference changes.
- Offline `npm test` never launches Pi or network; real-Pi runs only via `verify.py` (isolated
  loopback fixture, teardown verified).
- Never modify user's normal Pi/Splash config; never `pkill`; evidence preserved after teardown.
