# Testing

The template uses layered checks: fast offline tests for logic, adapter, and tooling helpers; a package-content check; and real-Pi checks. Each layer catches a different class of mistake.

## Environment

| Requirement | Detail |
| --- | --- |
| Node.js | 22.18 or newer. CI runs Node 22 and 24 on Linux with the same commands; local verification here uses Node 22. |
| Platform | Linux. Other operating systems are not currently verified. |
| Pi | 1.5.2 baseline for e2e, pinned in `scripts/quality.json`. |
| Dependencies | None for the starter. Do not run `npm install` for the starter. E2E also needs a Pi binary and a system GNU-compatible `tar`. |
| Network | `npm test` and `npm run check` are offline. E2E execution is offline. CI's initial pinned Pi install requires network. |

Node strips TypeScript types for the tests; it does not typecheck. There is no lint, typecheck, or build step.

## Commands

| Task | Command | Runs Pi? | Network? |
| --- | --- | --- | --- |
| Unit, wiring, and tooling | `npm test` | No | No |
| Package contents | `npm run check:package` | No | No |
| Full local check | `npm run check` | No | No |
| End-to-end | `npm run test:e2e` | Yes | No |
| One test file | `node --test test/greeting.test.ts` | No | No |

`npm run check` is `npm test && npm run check:package`. It does not run e2e. Run e2e when changing extension wiring, the command contract, package contents, or the Pi baseline.

## Pure logic

`test/` imports the pure formatter directly. No Pi process or host package is involved.

Cover:

- Empty input.
- Whitespace-only input.
- Leading and trailing whitespace.
- Ordinary names.
- Names with internal spaces or punctuation.

Assert the returned text. Do not assert implementation details such as the number of `trim` calls.

## Extension wiring

The same `npm test` run contains wiring tests. They import the extension entry point with a type-only host dependency and inject fakes:

- A fake `ExtensionAPI` records `registerCommand(name, options)` and `sendMessage(message, options)`.
- A fake command context has `hasUI` and `ui.notify`.
- The test invokes the captured handler with an argument and the fake context.

Assert:

- The command is registered with the expected name.
- The formatter output reaches the output channel unchanged.
- The UI branch calls `notify` with the greeting and `"info"`.
- The headless branch calls `sendMessage` with `customType: "template-greeting"`, `display: true`, `content` equal to the greeting, and `triggerTurn: false`.
- The blank-argument fallback and trimming behave the same through the handler as through the pure function.

Wiring tests must not launch Pi. That is the e2e layer's job.

## Tooling helpers

The same `npm test` run contains tests for helpers used by packaging, e2e, and release. Examples include allowlist decisions, child-environment allowlists, archive parsing, package-manifest validation, result-summary sanitization, and release metadata.

- Import pure helpers from `scripts/*.mjs` and `e2e/harness.ts` directly.
- Release CLI tests may create a temporary fixture under `os.tmpdir()`, spawn the local Node runtime as a child process, and remove the fixture in `finally`. They must not run `npm pack`, launch Pi, or use the network.
- Do not duplicate the real package check or the real Pi run in a unit test. Tooling tests are fast feedback for the logic around those commands, not a substitute for them.

## Package contents

`npm run check:package` inspects what `npm pack` would include and compares it with an explicit allowlist. The starter allowlist is:

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

1. **Checkout RPC:** Pi loads `src/index.ts` with `-e` and serves the command over RPC.
2. **Headless JSON:** Pi runs with `--mode json -p`, loads the checkout with `-e`, and invokes `/hello Ada`. The test asserts the visible `template-greeting` custom message and a clean exit.
3. **Packed archive RPC:** the runner packs the current tree, or reuses an exact checked archive via `PACKAGE_ARCHIVE=/absolute/file.tgz`. It lists and extracts the tarball with a system GNU-compatible `tar` (regular files and directories only), writes a temporary Pi `settings.json` whose `packages` entry points at the extracted directory, and starts Pi in RPC mode. Pi discovers the command from the package manifest.

For the RPC paths, the checks establish that Pi starts, the `hello` command is discoverable, invoking it is handled without a model turn, and the greeting appears through the notification channel. The packed path also proves that the release allowlist contains the entry point and manifest.

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
- Send no model prompt; command discovery and extension-command invocation need no provider.
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

## What is not covered

- Provider transports, authentication, model output, and streaming.
- TUI rendering and terminal behavior.
- Operating systems other than Linux.
- TypeScript type errors, since the project does not typecheck.
- Performance or concurrency. The starter has no such behavior.
- The `pi install` command, npm registry resolution/installation, and the published-package install path.
- Tar formats or archive entries beyond GNU-compatible `tar` with regular files and directories.

If a fork adds resources or network access, add tests for cancellation, cleanup, timeout, and failure before claiming support.

## Writing tests

- Use `node:test` and `node:assert/strict` only.
- Name tests by observable behavior.
- Keep unit and wiring tests fast and offline. Tooling tests may use temporary fixtures and isolated local Node subprocesses; always remove fixtures in `finally`.
- Do not run `npm pack`, launch Pi, or use the network inside `npm test`.
- A bug fix includes a regression test that fails without the fix.
- Update e2e smoke assertions with the example. Do not delete assertions to make a change pass.
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
