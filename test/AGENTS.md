<!-- FOR AI AGENTS - Human readability is a side effect, not a goal -->
<!-- Managed by agent: keep sections and order; edit content, not structure -->

# AGENTS.md — test

## Overview

Offline `node:test` suites for the pure formatter, the Pi adapter, and tooling helpers used by packaging, e2e, and release. Tests run on Node's TypeScript stripping and must not launch Pi, run `npm pack`, or use the network.

Temporary filesystem fixtures and isolated local Node child processes are allowed where the release tooling needs them. The e2e suite is separate and lives in `e2e/`; it is the only layer that launches Pi. `npm test` must stay fast and offline.

## Setup and environment

- Node.js 22.18+.
- `node:test` and `node:assert/strict` only; no test framework install.
- No dependencies, network, Pi process, or `npm pack`.
- Temporary fixtures and local Node subprocesses are allowed for release CLI coverage; clean them up.
- TypeScript is stripped, not typechecked. Syntax must be strip-compatible.

## Commands

| Task | Command |
| --- | --- |
| All unit, wiring, and tooling tests | `npm test` |
| One file | `node --test test/greeting.test.ts` |
| Package contents | `npm run check:package` |
| Full local check | `npm run check` |

## What to test

| Layer | Target |
| --- | --- |
| Unit | The pure formatter: empty input, whitespace-only input, trimming, normal names, punctuation and spaces inside a name. |
| Wiring | Command registration, handler argument forwarding, `ctx.hasUI` true/false branches, notification level, custom message shape and options. |
| Tooling | Pure helpers used by packaging, e2e, and release: allowlist decisions, child environment allowlists, archive parsing, manifest validation, result sanitization, and release metadata. Release CLI tests may run the local Node binary in a temporary fixture with a child process. Do not spawn `npm pack` or Pi here. |
| Contract | `/hello` behavior stays aligned with `README.md`, `src/AGENTS.md`, and the e2e smoke assertions. |

Wiring tests use small fakes:

- A fake `ExtensionAPI` that records `registerCommand(name, options)` and captures `sendMessage(message, options)`.
- A fake context with `hasUI` and `ui.notify` for the UI branch.
- Invoke the captured handler directly with an argument string and the fake context.

Assert the observable contract, not private helper calls: exact greeting text, `"info"` level, `customType: "template-greeting"`, `display: true`, and `triggerTurn: false`.

## Conventions

- Name tests by behavior, not by function or implementation detail.
- Use `node:test` subtests or a flat `test()` structure consistently within a file.
- Keep fixtures inline. Reuse a fake only when the sharing is real.
- Do not use snapshots, wall-clock timing, random data, or platform-specific paths.
- A bug fix includes a test that fails without the fix.
- When the example changes, update the tests and the e2e assertions in the same change. Do not delete assertions to make a change pass.
- Do not put e2e integration tests in `test/`. Importing pure helpers from `e2e/harness.ts` is allowed.

## Cleanup and isolation

- Temporary fixtures belong under `os.tmpdir()` using `fs.mkdtemp`, and are removed in `finally` or a test teardown hook. Never use `~/.pi` or the repository root.
- Child processes must be the local Node runtime for release CLI fixtures, spawned with an explicit environment and a timeout. They must not be Pi or `npm pack`.
- Close handles and timers. `npm test` hanging usually means a live timer, socket, or child process.

## Security

- Never read or write real Pi configuration, session files, credentials, or provider keys.
- Never make a network request.
- Do not print environment dumps or user content in failure messages.
- Do not weaken offline behavior to test an online feature; isolate that feature in e2e instead.

## Pull request checklist

- [ ] `npm test` passes; output is pasted.
- [ ] New behavior has a test; bug fixes have a regression test.
- [ ] Both UI and headless branches are covered when wiring changes.
- [ ] No network, real home directory, Pi process, or `npm pack` is used.
- [ ] Temporary fixtures and child processes are cleaned up.
- [ ] E2E smoke assertions are updated when the command contract changes.

## Troubleshooting

- `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`: replace enums, parameter properties, or namespaces with strip-compatible syntax.
- `Cannot find package '@earendil-works/pi-coding-agent'`: the test process does not install the host. Use type-only imports and fakes, or stub any legitimate host runtime helper. Do not add the host to `dependencies`.
- Tests hang: look for an unclosed timer, child process, socket, or unresolved promise.
- Temporary files remain: remove fixtures in `finally`; do not leave cleanup to process exit.
