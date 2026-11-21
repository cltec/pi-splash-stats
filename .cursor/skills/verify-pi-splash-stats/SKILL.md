---
name: verify-pi-splash-stats
description: Verify pi-splash-stats in the real Pi terminal UI and non-TUI modes while implementing SPECIFICATION.md. Use for changes to backend detection, progress, generation widgets, lifecycle, summaries, or packaging; capture isolated PTY/HTTP evidence and report missing implementation honestly.
---

# Verify Pi Splash Stats during development

Read [the feature map](features/README.md), then the relevant journey. Acceptance authority is
`SPECIFICATION.md` at the repository root. This is a how-to for an agent, not an implementation plan.

**Current boundary:** the extension is implemented and covered by the bundled harness (unit/wiring
tests, the real-Pi PTY journeys, and the packed-package journey). A green harness run is bounded
integration evidence against a local protocol fixture; it does **not** qualify real Splash, the
launcher, auto/recovery compaction, remote/IPv6/auth failure, exact transient counts, narrow
layout, or other-extension coexistence. See [qualification status](references/qualification-status.md).

## Launch

Run from the repository root on macOS/Linux with Python 3.10+, the approved Pi **1.5.2**, Node
at or above the specification's **22.18.0** minimum, and preinstalled `fd`/`rg` on PATH.
Record the actual Node version; Pi's installed distribution may impose a stricter requirement.
Do not silently upgrade versions, install dependencies, copy the template, or implement the
extension just to turn a verification check green.

```sh
V=.cursor/skills/verify-pi-splash-stats/scripts/verify.py
"$V" doctor
"$V" run chat
```

There is no build step: TypeScript is loaded through the package directory and its
`pi.extensions: ["./src/index.ts"]` manifest (or a direct source-file `-e` entry in the harness),
not compiled or fetched. Verification never installs or fetches packages.

Every `run` launches its own loopback server on an OS-assigned port, temporary HOME/config/work
directories, and a **real Pi PTY** at 120×40 in regular terminal mode (or a pipe for non-TUI modes).
It creates two authenticated fixture providers, both serving `verify-model`:

| Provider | Base path | /models ownership |
| --- | --- | --- |
| `verify-local` | `/splash/v1` | `splash` |
| `splash` | `/other/v1` | `llama.cpp` |

The literal dummy key `verification-only` is the only credential. Both endpoints use a non-default
port and a path prefix. The deliberately misleading provider name tests identity, not ancestry.
The fixture is a production HTTP boundary replacement, not a replacement Pi/extension/UI.

Readiness means the initialized provider/model footer **and a successful `/debug` snapshot**,
then an actual streamed completion—not merely an open socket. No migrations or external seed
data are needed for these chat journeys. Each drive is short-lived; teardown is built into the
same command, including on assertion failure. Do not start or attach to the user's active Pi.

## Doctor

```sh
"$V" doctor
```

This read-only product preflight checks installed versions, package identity, manifest entry,
and runtime source hashes. It only writes its own scratch/evidence; it does not start inference
or change project/user configuration. It returns `READY_TO_LAUNCH`, not "running" or feature proof.
Use it first when something looks wrong. Before each PTY drive, an additional in-process doctor
checks the owned child is live and captures the usable footer in `doctor.json`/`ready.screen.txt`.
The real request must subsequently authenticate to this run's fixture with the right model/path.

Exit/status meanings:
- **0 / PASS:** only the named scenario and recorded assertions passed.
- **0 / HARNESS_ONLY_PASS:** infrastructure check **without the extension**; no product coverage.
- **2 / BLOCKED:** missing prerequisites/source/version qualification; do not substitute a no-op.
- **1 / FAIL:** a drive/assertion failed; inspect artifacts before retrying.

## Drive

```sh
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
"$V" run packed
```

`packed` runs `npm pack`, extracts the tarball, and loads the artifact through the Pi manifest
(settings `packages` entry) instead of `-e`, then drives the same `chat` assertions—covering the
exact bytes a user would install. See [the package journey](features/lifecycle-and-modes.md).

The PTY sends actual editor text + Enter, `Escape`, `/model splash/verify-model`,
`/model verify-local/verify-model`, `/reload`, and `/debug`. It never calls extension setters
or synthesizes Pi lifecycle events. The fixture gates prefill and generation so transient
screens can be captured; gates do not delay a real backend or excuse an implementation delay.

`chat` expects cache-aware 50%/20.0 tok/s prefill, then an approximate generation count and an
unmodified completed assistant response, then no idle stats. `cached` repeats with a real
conversation follow-up; both fixture responses explicitly report a 20-token cache baseline.
It does **not** model real cache residency. Abort must produce Pi's actual aborted stop reason.
Reload must finish and allow another request; switching must clear and resume stats.

Ineligible scenarios run a second, no-extension Pi in the **same scratch configuration/workdir**:
the entire inference JSON body hash must match. The baseline is evidence, not a second user session.
Non-TUI scenarios require valid ordinary output, no stats, no discovery, and no enrichment.
They cannot prove layout or complete equality of all protocol records/headers.

For the project's own offline checks, preserve the specification's commands:
```sh
npm test
npm run check:package
npm run check
npm run test:e2e
npm pack --dry-run
```
Capture stdout/stderr and exit codes. `npm test` must stay offline and must not invoke this
real-Pi/network harness. Do not use `npx`, publish, tag, or add runtime dependencies during
verification.

## Evidence

Each invocation prints a unique directory under **`.verification-evidence/` at repo root**.
The directory survives cleanup, including failed/blocked attempts. It contains:
- `environment.json`: exact Pi/Node/OS, package path, runtime source/manifest hashes.
- `command.json`, `actions.jsonl`, `terminal.ansi`: actual launch and timed actions/terminal output.
- `*.debug.txt`, `*.screen.txt`: Pi-rendered snapshots, not grep of historical terminal bytes.
- `http.jsonl`: endpoint/model/auth-success, enrichment fields and full payload hashes;
  never request text, output, tools, authorization values, or raw chunks.
- `files-before.json`/`files-after.json`: scratch file inventory and configuration hashes.
- `stdout.txt`/`stderr.txt` for protocol modes, and `baseline/` for differential drives.
- `doctor.json`, `process-cleanup.json`, `result.json`: readiness, teardown, precise coverage/reason.

Proof must capture **action and resulting state**, not just a final screen. Verify actual
request count/fields, response preservation, cleanup, and filesystem side effects alongside UI.
The harness rejects duplicate inference, provider-config mutation, and work/session writes;
configuration and payload hashes are compared on negative paths. Fixture prompts/output are
synthetic: `/debug` and terminal artifacts legitimately contain them. Never use real secrets or
private prompts here. The extension itself must not persist them.

A passing fixture run is bounded integration evidence, not real Splash/macOS, launcher,
remote auth, all transports, or summary qualification. Unit/wiring tests must separately prove
byte preservation, numeric edge cases, identity deadlines/cache/auth isolation, UI ownership,
render limits, and parser bounds (`SPECIFICATION.md` §12). Do not infer untested criteria.

Mocks are allowed only at production external boundaries (this local HTTP server); not inside
Pi/extension logic. Neither `--offline` nor `npm pack --dry-run` is a sandbox. Observe HTTP and
file evidence: this harness intentionally makes local HTTP calls and writes scratch/debug data.
The child has an explicit environment allowlist, no user auth, no tools/MCP/resources, and
offline catalog/update settings, but malicious extension code is not OS-network-sandboxed.

## Cleanup

Every command cleans up in `finally`, even on failure: quit the owned Pi, bounded shutdown of
its recorded process group, release fixture gates, close/join the owned HTTP server, then remove
only that run's scratch directory. Check `group_gone`, exit/forced-shutdown flags,
`scratch_removed`, `fixture_closed`, and `evidence_survives`. Forced termination is not a
clean-shutdown proof. Never use `pkill`, kill by process name, or touch the user's running Splash.

No background instance is intentionally left for a later command to find. Parallel runs have
different ports, PTYs, homes and evidence IDs. For an interrupted agent, allow the foreground
helper to finish or send **SIGINT to that helper**, which takes its normal cleanup path. SIGKILL,
a host crash, or an external hard timeout cannot guarantee cleanup; inspect recorded command/PID
ownership before recovering anything. Do not double-drive shared real-Splash inference/cache state.

After any run, read its `result.json` and confirm the proof files still exist at the printed path.
Never delete `.verification-evidence/` as part of teardown. Redact before sharing artifacts.

## Helpers

All shipped scripts are executable. Run from repo root:
```sh
# Bootstrap proof that real Pi, the PTY, fixture, snapshots and teardown work; NO extension loaded.
"$V" self-test

# Harness regression suite: real Pi + disposable no-op package, positive silence and negative chat assertions.
python3 -B .cursor/skills/verify-pi-splash-stats/scripts/test_verify.py

# Exercise the packed npm artifact (npm pack + extract + load via the Pi manifest).
"$V" run packed
```

Both harness self-tests are infrastructure-only, never release evidence. The regression suite
also records a summary under `.verification-evidence/harness-tests-*.json`.

Pi discovery is provided by the project-local `.agents/skills/verify-pi-splash-stats` symlink;
Cursor uses this directory. Reload resources to discover it. Explicit Pi loading is also supported:
`pi --skill .cursor/skills/verify-pi-splash-stats`.

Keep the map honest with **`/maintain-verification-skill`** as features and entry points change.
