# Handoff prompt: lead development of Pi Splash Stats

You are the **Team Leader and integration owner** for implementing the Pi Splash Stats extension in this repository. Deliver the behavior defined by `SPECIFICATION.md`; do not merely produce a plan or delegate disconnected components.

Organize the work into independently demonstrable **vertical slices**, coordinate implementation and independent verification, and integrate a slice only after its required verification passes.

## 1. Inspect before planning

Read:
- `SPECIFICATION.md` in full, including the acceptance criteria, template provenance, integration constraints, and release restrictions.
- `.cursor/skills/verify-pi-splash-stats/SKILL.md`.
- Its `features/README.md`, all five feature journeys, and `references/qualification-status.md`.
- Existing repository instructions, implementation, tests, and working-tree changes, if present.

The original checkout was specification-only. A runnable verification harness now exists, but a harness-only pass is **not extension proof**. Recheck the current repository rather than assuming implementation is still absent.

Inspect the available delegation tools and installed Pi documentation before depending on their capabilities. Read the applicable Pi API documentation/examples before implementing integration. Resolve observed uncertainties yourself; ask the user only for decisions or resources you cannot establish safely.

## 2. Team and model constraints — mandatory

- Use **at most three named subagents total**, reused across assignments. Never exceed three active subagents, including reviewers and verifiers.
- Every subagent must use the **exact same provider and model as the coordinating main agent**. Determine the main agent's effective runtime identity and explicitly set that model on every delegation call. Do not rely on agent defaults or silently choose a cheaper/fallback model.
- Do not let subagents spawn additional subagents. All delegation belongs to you.
- Suggested team: two implementation workers and one independent reviewer/verifier. Reassign roles when useful, but a slice's implementer must not be its only verifier.
- Respect actual agent capabilities. A read-only exploration agent is not an implementation worker. If suitable writable subagents or same-model execution are unavailable, report the limitation and obtain agreement on an alternative; do not pretend team execution occurred.
- Pass focused task briefs, not the entire parent conversation by default. Reuse persistent sessions where the tool supports them.

You remain responsible for scope, architecture, scheduling, conflict resolution, acceptance, and the final integrated result.

## 3. Prepare and maintain the execution plan

Create `DEVELOPMENT_PLAN.md` before starting implementation. Include:
- The observed baseline, tool/model availability, prerequisites, and template source/commit.
- A dependency graph and ordered vertical slices, each mapped to specification sections and acceptance criteria.
- For each slice: user-visible outcome, scope/non-goals, affected contracts/files, owner, independent verifier, dependencies, exact verification commands, required evidence, and integration gate.
- Explicit risks/blockers, especially actual request attribution, summary transport coverage, and safe observer disposal/reload.
- Which slices may proceed in parallel without sharing files or relying on unverified contracts.

Create and maintain `DEVELOPMENT_STATUS.md` with slice states:
`planned → implementing → awaiting verification → verified → integrated`.
Use `blocked` or `rework` when appropriate. Record commits/patches, evidence paths, verifier findings, and uncovered acceptance criteria. Keep progress reports concise.

Plan real vertical behavior, not just horizontal layers such as “all parsing,” “all UI,” then “all tests.” A reasonable starting sequence is:
1. Adapt the approved template and establish a real package-load/silent-mode walking skeleton.
2. Deliver the first identity-verified Splash chat request with observable prefill and a genuine non-Splash negative path.
3. Add cache-aware progress/ETA, generation feedback, final-count/rate rules, and per-request resets.
4. Cover model changes, abort/error/session lifecycle, reload, and resource/UI ownership.
5. Deliver compaction and branch-summary paths, including their real transport attribution.
6. Complete packed-package behavior, remaining acceptance coverage, documentation, and qualification.

Adjust or split this sequence based on evidence. Investigate summary transport feasibility early: do not discover at the end that the chosen chat-only integration cannot satisfy the specification. A technical spike can inform a slice but is not a completed user feature.

## 4. Delegate precise, isolated assignments

Before each assignment, give the worker:
- Slice ID, required user outcome, and acceptance criteria.
- Current verified baseline and dependencies.
- Relevant source/docs and allowed file ownership.
- Contracts it must preserve and changes outside scope.
- Required tests, real-Pi journeys, artifact locations, and completion report format.

Prefer isolated Git worktrees/branches for writable workers, created from a known baseline. Do not have multiple workers edit the same files concurrently. If the checkout is not a Git repository, establish and document an appropriate local isolation strategy before parallel edits; isolated copies with reviewed patches are acceptable, but do not describe patch application as a Git merge.

Preserve pre-existing work. Do not overwrite the specification, delete unrelated files, reset history, or push remote changes. Coordinate shared interface changes explicitly. Workers return focused commits/patches, tests, evidence, limitations, and any contract changes.

Run only genuinely independent assignments concurrently. Serialize prerequisite slices and integration. A busy team is not more important than a correct dependency order.

## 5. Require independent verification before integration

For each slice:
1. The implementation worker runs its focused tests and relevant real-Pi journeys in its isolated workspace.
2. A different subagent reviews the actual diff and independently runs the required verification against that exact source revision.
3. The verifier checks behavior, regression risk, isolation, cleanup, source/package identity, and evidence—not just the implementer's summary.
4. Any missing requirement, unexpected failure, or missing prerequisite is reported as FAIL/BLOCKED, with the attempted command and reason. Return the slice for rework when necessary.
5. Only after verification passes may you integrate the slice into the main working line.
6. After integration, rerun affected checks against the integrated tree. A result from a worker branch alone does not prove the merged result.

A slice can legitimately exclude later planned behavior, but its own acceptance gate must be explicit and satisfied. Do not integrate unfinished behavior as “verified” by silently reducing its promised scope. A dependency or environment blocker is not a pass.

If integration causes a regression, fix and reverify before advancing dependent work. Prefer small, reviewable changes over large speculative rewrites.

## 6. Use the verification skill honestly

Run the bundled helper from each worker's checkout as applicable:

```sh
V=.cursor/skills/verify-pi-splash-stats/scripts/verify.py
"$V" doctor
"$V" run chat
"$V" run cached
"$V" run non-splash
"$V" run switch
"$V" run abort-prefill
"$V" run abort-generation
"$V" run reload
"$V" run print
"$V" run json
"$V" run rpc
```

Use only the journeys relevant to a slice, then broaden regression coverage as features land. Read `.verification-evidence/<run-id>/result.json` and the actual phase/request/cleanup artifacts. Preserve evidence after teardown and identify the exact source revision it tests.

The helper uses real Pi with a local fake HTTP backend. It is not real Splash qualification. `self-test` and `test_verify.py` prove verifier infrastructure, not product behavior.

Current harness gaps include tool follow-ups, compaction/tree summaries, some faults/races, exact final transient count/rate assertions, and narrow-terminal layouts. Extend the feature map and harness with the corresponding implementation slices. Do not replace these journeys with convenient chat tests. Drive actual Pi user actions and production-boundary responses, not internal extension setters or synthetic lifecycle events.

Preserve the specified project gates once the template is adapted:

```sh
npm test
npm run check:package
npm run check
npm run test:e2e
npm pack --dry-run
```

Keep offline unit/wiring tests separate from local-network real-Pi tests. Do not weaken expectations to accommodate a bug. Demonstrate that tests fail for missing/broken behavior when practical.

Packed-package verification must load the extracted package through its manifest, not fall back to checkout modules. Manual qualification with actual Splash must follow the specification and record exact versions/scenarios. If required hardware, a model, or a remote endpoint is unavailable, state that clearly and leave the corresponding qualification unverified.

## 7. Preserve design, security, and delivery boundaries

- Derive from the template commit named in the specification, or deliberately record an approved newer baseline. Preserve its Apache-2.0 license and thin-adapter/pure-logic structure.
- Use backend identity and actual request ownership, never provider names, launch ancestry, credentials, or timing fields alone.
- Do not alter unrelated inference, hijack another extension's UI/fetch wrapper, persist statistics, or expose prompts/secrets in diagnostics.
- Keep host packages as peers, runtime dependencies minimal, and the specified package allowlist/manifest intact.
- Do not silently change the Pi/Node baseline or add dependencies. Resolve any necessary deviation explicitly before proceeding.
- Keep `private: true` and release publishing disabled. Do not publish, tag, start paid/public inference, or touch the user's normal Pi/Splash configuration.
- Isolate all verification instances and tear down only processes/scratch state the run created. Preserve proof artifacts.

## 8. Finish with an evidence-backed handoff

Provide:
- Integrated vertical slices and their user-visible outcomes.
- A matrix mapping AC-01 through AC-15 to implementation, verification commands, source revision, evidence, and status.
- Final integrated test results and packed-package checks.
- Remaining bugs, blocked environments, unsupported/unverified journeys, and release gates.
- Updated README/architecture/testing/troubleshooting/security/changelog/ADR deliverables required by the specification.
- Updated verification feature map and qualification record; use `/maintain-verification-skill` if available.

Do not describe the extension as complete or release-qualified while mandatory criteria remain unverified. Start now by inspecting the repository, confirming team/model capability, and preparing the execution plan; then coordinate implementation through verification and integration.
