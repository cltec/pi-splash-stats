# Testing

The project uses layered checks: fast offline tests for the adapter and tooling helpers; a package-content check; and real-Pi checks. Each layer catches a different class of mistake.

## Environment

| Requirement | Detail |
| --- | --- |
| Node.js | 22.18 or newer. CI runs Node 22 and 24 on Linux with the same commands; local verification here uses Node 22. |
| Platform | Linux. Other operating systems are not currently verified. |
| Pi | 1.6.0 baseline for e2e, pinned in `scripts/quality.json`. |
| Dependencies | None. Do not run `npm install`. E2E also needs a Pi binary and a system `tar` (the packed listing uses portable `tar -tf`, GNU- and BSD-compatible). |
| Network | `npm test` and `npm run check` are offline. E2E execution is offline. CI's initial pinned Pi install requires network. |

Node strips TypeScript types for the tests; it does not typecheck. There is no lint, typecheck, or build step.

## Commands

| Task | Command | Runs Pi? | Network? |
| --- | --- | --- | --- |
| Unit, wiring, and tooling | `npm test` | No | No |
| Package contents | `npm run check:package` | No | No |
| Full local check | `npm run check` | No | No |
| End-to-end | `npm run test:e2e` | Yes | No |
| One test file | `node --test test/extension.test.ts` | No | No |

`npm run check` is `npm test && npm run check:package`. It does not run e2e. Run e2e when changing extension wiring, the extension contract, package contents, or the Pi baseline.

## Adapter wiring

The offline `npm test` suite includes pure-module tests for each behavior module (below),
a wiring suite, and tooling-helper tests. The behavior lives in pure modules, each tested directly
without Pi:

| Test file | Module under test |
| --- | --- |
| `test/identity.test.ts` | `src/identity.ts` — endpoint normalization, discovery URL, candidate test, identity validation. |
| `test/discovery.test.ts` | `src/discovery.ts` — bounded/deduplicated/cached discovery, deadline, auth-context key. |
| `test/transport.test.ts` | `src/transport.ts` — eligibility, enrichment, stream attribution. |
| `test/progress.test.ts` | `src/progress.ts` — prefill/generation math and validation bounds. |
| `test/format.test.ts` | `src/format.ts` — compact-line rendering and width fallbacks. |
| `test/ui.test.ts` | `src/ui.ts` — ownership, coalescing, throw-safe display. |
| `test/fetch-observer.test.ts` | `src/fetch-observer.ts` — SSE parsing and scoped observer bounds. |

The same `npm test` run contains wiring tests (`test/extension.test.ts`). They import the extension
entry point with a type-only host dependency and inject a deliberately partial fake `ExtensionAPI`
that records the lifecycle hooks (`session_start`, `model_select`, `session_shutdown`), the provider
request/stream hooks, and the TUI working-message/widget registration. They drive fake provider
requests and stream events through the real adapter and assert:

- Rendering is gated on `ctx.mode === "tui"`; RPC, print, and JSON fakes produce no stats output.
- Ownership is enforced: late, out-of-order, or stale chunks are rejected and concurrent streams do
  not mix counts; `armedRequest` prevents a stale boundary from clearing a newer request.
- Lifecycle: `session_start` creates a fresh discovery cache and bumps `runtimeGeneration`;
  `model_select` bumps `selectionGeneration`; `session_shutdown` disposes the cache and goes inert.
- Failure paths: a throwing UI API disables the affected display without throwing; an abrupt stream
  clears the display without an unhandled rejection; a failed discovery leaves the request unenriched.

Wiring tests must not launch Pi. That is the e2e and verification-harness layers' job.

## Live generation rate coverage

`test/generation-rate.test.ts` uses explicit timestamps to cover the 500 ms floor, first-batch exclusion, pauses, reasoning/tool fragments, invalid clocks, independent approximation markers and width fallback. Wiring tests inject a monotonic clock and verify live rendering and request reset. Final authoritative throughput remains covered separately from the estimate.

The real-Pi fixture spaces output batches 650 ms apart; chat and summary journeys require a parenthesized one-decimal approximate rate in the generation snapshot. Non-TUI journeys still require complete statistics silence. This is bounded local-fixture evidence, not measured real-Splash throughput; final transient timing frames may be cleaned up before a snapshot.

## Tooling helpers

The same `npm test` run contains tests for helpers used by packaging, e2e, and release. Examples include allowlist decisions, child-environment allowlists, archive parsing, package-manifest validation, result-summary sanitization, and release metadata.

- Import pure helpers from `scripts/*.mjs` and `e2e/harness.ts` directly.
- Release CLI tests may create a temporary fixture under `os.tmpdir()`, spawn the local Node runtime as a child process, and remove the fixture in `finally`. They must not run `npm pack`, launch Pi, or use the network.
- Do not duplicate the real package check or the real Pi run in a unit test. Tooling tests are fast feedback for the logic around those commands, not a substitute for them.

## Package contents

`npm run check:package` inspects what `npm pack` would include and compares it with an explicit allowlist. The allowlist is:

- `package.json`, `README.md`, `LICENSE`, and `CHANGELOG.md`.
- Non-hidden `src/**/*.ts` files, excluding `*.test.ts`, `*.spec.ts`, and `AGENTS.md`/`CLAUDE.md`/`GEMINI.md`.

The check must fail if the package includes:

- Agent instructions such as `AGENTS.md` or scoped agent docs.
- Tests, e2e fixtures, or docs.
- Environment files, credentials, logs, or generated tarballs.
- Source or resource files that are not intentionally published.

When adding a publishable resource, update `package.json#files` and the check together. Do not weaken the check to make an accidental file pass. Inspect the list with `npm pack --dry-run` while developing.

## Real Pi checks

`npm run test:e2e` launches a real Pi child process and verifies three paths:

1. **Checkout RPC:** Pi loads `src/index.ts` with `-e`; the test asserts the silent extension registers no commands and produces no notifications.
2. **Headless JSON:** Pi runs with `--mode json`, loads the checkout with `-e`, and the test asserts the silent extension emits no custom messages and exits cleanly.
3. **Packed archive RPC:** the runner packs the current tree, or reuses an exact checked archive via `PACKAGE_ARCHIVE=/absolute/file.tgz`. It lists the tarball with portable `tar -tf` (GNU- and BSD-compatible) and extracts it with `tar -xzf` (regular files and directories only), writes a temporary Pi `settings.json` whose `packages` entry points at the extracted directory, and starts Pi in RPC mode. Pi loads the extension from the package manifest.

For the RPC paths, the checks establish that Pi starts, no extension command is discoverable, the session stays idle, and no notifications are produced. The packed path also proves that the release allowlist contains the entry point and manifest.

Limits: this does **not** run `pi install` and does **not** resolve or install from an npm registry. The extracted local-directory load is the checked path; install-command and registry behavior need separate verification if a fork depends on them.

### Selecting Pi and the version

The runner uses `pi` from `PATH` by default. Set `PI_BIN` to an absolute path to use another binary:

```bash
PI_BIN=/absolute/path/to/pi npm run test:e2e
```

The selected binary's reported version must equal the `scripts/quality.json` baseline. `PI_VERSION` can set the exact stable expected version for a temporary compatibility experiment. Neither variable changes CI's pinned baseline: to adopt a new version, update `scripts/quality.json` and the documentation, then run the checks again.

### Isolation

E2E is the only layer allowed to touch a Pi process, and it must isolate it:

- Create a temporary root with its own `HOME`, `PI_CODING_AGENT_DIR`, working directory, and pack output.
- Pass an explicit environment allowlist. Do not spread `process.env`; provider keys, proxies, and user configuration must not leak in.
- Keep Pi offline (`PI_OFFLINE`, version-check and telemetry disabled).
- Load the extracted package directory through temporary Pi settings; do not call `pi install` or a registry.
- Send no model prompt; command discovery and the silence assertions need no provider.
- Never write to a real `~/.pi` or the repository root.

### Shutdown and cleanup

- Close stdin, request termination, wait a bounded interval, then escalate to a kill.
- Await the child exit and reap it.
- Remove the temporary home, config, cwd, extracted package, and tarball in `finally` or test teardown, on success and failure.
- Treat a leaked process or directory as a test failure.
- Bound failure output; do not dump whole protocol streams.

### Artifacts

The runner writes a sanitized schema-1 result to `artifacts/e2e-result.json`, or to `E2E_RESULT_PATH` when set. Actual fields are:

- Top level: `schemaVersion`, `outcome`, `nodeVersion`, `piVersion`, `piBaseline`, `piExpected`, `durationMs`, `cleanup`, `errorCategory`, `checks`.
- Each check: `name`, `status`, `durationMs`, `commands`, `cleanup`, `errorCategory`.

`scripts/summarize-e2e.mjs` renders only known fields: outcome, Node and Pi versions, overall cleanup, and each check's name, status, failure category, and cleanup. It reads the same environment variable and default path. It does not render raw messages, protocol data, environment values, home paths, prompts, or session content. Artifacts are not committed.

## Real-Pi verification harness

Beyond the offline `node:test` suite and the e2e smoke, the repository ships a real-Pi verification
harness at [`.cursor/skills/verify-pi-splash-stats`](../.cursor/skills/verify-pi-splash-stats/SKILL.md)
(`scripts/verify.py`, Python 3.10+ stdlib only). It runs **14 journeys** against a **real Pi PTY**
(120×40, regular mode) and the non-TUI modes against a local loopback protocol fixture, and it is
the layer that proves the user-visible behavior end to end: the prefill bar, the generation count,
cache-awareness, mode silence, cancellation, reload, model switching, compaction/branch summaries, and
the **packed package** (it runs `npm pack`, extracts the tarball, and loads the artifact through the
Pi manifest).

It is a how-to for an agent, not a CI job: run `"$V" doctor` first, then `"$V" run <scenario>` for
the scenario you touched. It never installs, fetches, or calls a real provider; it writes only
sanitized evidence under `.verification-evidence/`. Its self-tests (`scripts/test_verify.py`) are
infrastructure-only and never release evidence. A green harness run is bounded integration evidence
against a local fixture; it does not qualify real Splash, the launcher, auto/recovery compaction,
remote/IPv6/auth failure, exact transient counts, narrow layout, or other-extension coexistence. See
the skill's [qualification status](../.cursor/skills/verify-pi-splash-stats/references/qualification-status.md).

The harness is separate from `npm test` and `npm run test:e2e`: those are the fast, offline, CI
checks; the harness is the manual, real-Pi, PTY-level proof.

## What is not covered

- Provider transports, authentication, model output, and streaming, against a real backend.
- Real Splash, the launcher, auto/recovery compaction, remote/IPv6/auth-failure paths, exact final
  transient counts/rates, narrow terminal layout, and other-extension coexistence (recorded as
  unverified in the skill's qualification status).
- Operating systems other than Linux.
- TypeScript type errors, since the project does not typecheck.
- The `pi install` command, npm registry resolution/installation, and the published-package install path.
- Tarball formats other than a regular-files-and-directories tar, and archive entries beyond that.

If a fork adds resources or network access, add tests for cancellation, cleanup, timeout, and failure before claiming support.

## Writing tests

- Use `node:test` and `node:assert/strict` only.
- Name tests by observable behavior.
- Keep unit and wiring tests fast and offline. Tooling tests may use temporary fixtures and isolated local Node subprocesses; always remove fixtures in `finally`.
- Do not run `npm pack`, launch Pi, or use the network inside `npm test`.
- A bug fix includes a regression test that fails without the fix.
- Update e2e smoke assertions with the extension contract. Do not delete assertions to make a change pass.
- If a test needs a temporary directory, create it under `os.tmpdir()` and remove it in teardown. Never use a real home.

## CI

CI runs on Linux with Node 22 and 24. It installs the Pi version from `scripts/quality.json` into a temporary prefix outside the checkout, then runs the same local commands: `npm run check` and `npm run test:e2e`. The pinned install needs network; the test execution itself is offline. The pinned prefix keeps CI independent of a globally installed Pi and keeps the checkout clean.

No other operating system is claimed. Adding one requires running the checks there and updating the documentation and matrix together.

## Debugging

- Run one test file directly to reduce noise.
- For e2e, set `PI_BIN` to the exact absolute binary and confirm its version against `scripts/quality.json`, or set `PI_VERSION` only for a temporary experiment.
- Set `PACKAGE_ARCHIVE=/absolute/file.tgz` to exercise an exact checked archive instead of a fresh pack.
- Inspect the sanitized result at `E2E_RESULT_PATH` or `artifacts/e2e-result.json` for the scenario and error category; reproduce manually with a small temporary home if needed.
- If a process or temporary directory remains, fix the cleanup path before merging.
- See [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) for common symptoms.
