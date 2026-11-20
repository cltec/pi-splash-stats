# Pi Extension Template

A small, test-first starter for a [Pi](https://pi.dev) extension: one slash command, a thin Pi adapter, pure logic, and layered checks that need no credentials.

The example registers `/hello [name]`:

| Invocation | Result |
| --- | --- |
| `/hello` | `Hello, world!` |
| `/hello Ada` | `Hello, Ada!` |
| `/hello   Ada   ` | `Hello, Ada!` |

The example contains no network calls, configuration, background resources, or npm runtime dependencies. Replace the example with your feature; the structure and checks stay useful.

## Why this template

Use it when you want a working Pi extension rather than an empty package. It provides:

- A thin, reviewable boundary between Pi-specific wiring and ordinary code.
- Offline tests for pure logic, wiring, and release tooling.
- Package-allowlist and real-Pi smoke checks that catch manifest and loading mistakes.
- Explicit release gates with publishing off by default.

It is not a framework, a build pipeline, or a full product scaffold.

## What is included

- A working Pi extension in `src/index.ts` that registers the command with `pi.registerCommand`.
- Pure formatting in `src/greeting.ts`, so the interesting logic is tested without Pi.
- A UI-aware response: `ctx.ui.notify(..., "info")` when `ctx.hasUI`, otherwise a custom `pi.sendMessage` message.
- Offline unit, wiring, and tooling tests with `node:test`. Tooling tests may use temporary fixtures and isolated local Node processes; they do not launch Pi, run `npm pack`, or use the network.
- A packaging check that asserts exactly what `npm pack` would publish.
- End-to-end checks that drive a real Pi process over RPC from the checkout and from a packed archive, plus a headless JSON check of the custom-message path.

## Requirements and compatibility

| Requirement | Detail |
| --- | --- |
| Node.js | 22.18 or newer. CI runs Node 22 and 24 on Linux with the same commands; local verification here uses Node 22. |
| Pi | 1.5.2 baseline for the e2e checks, pinned in `scripts/quality.json`. |
| Platform | Linux is tested. Other operating systems are not currently verified. |
| Dependencies | None for the starter. `npm install` is not required. E2E additionally needs a Pi binary and a system GNU-compatible `tar`. |
| Network | `npm test` and `npm run check` are offline. E2E test execution is offline, but CI installs the pinned Pi version first, which needs network. |

Nothing is built. Pi loads the TypeScript directly, and the tests rely on Node's TypeScript stripping. There is no lint, typecheck, or build step; stripping does not typecheck.

## Quick start

```bash
git clone https://github.com/OWNER/REPOSITORY.git
cd REPOSITORY
npm test
pi -e ./src/index.ts
```

Then run `/hello` or `/hello Ada` in Pi. Set `PI_BIN=/absolute/path/to/pi` to select an e2e binary; its version must match `scripts/quality.json` unless `PI_VERSION` sets the exact stable version. Both are temporary compatibility switches; update `scripts/quality.json` to adopt a new baseline.

`OWNER`, `REPOSITORY`, and `PACKAGE_NAME` are placeholders. Rename them, the package metadata, and the example before calling the project yours; see [docs/TEMPLATE-SETUP.md](docs/TEMPLATE-SETUP.md).

## Install

After the package has been renamed and, if desired, published:

```bash
# From a local checkout
pi install /absolute/path/to/REPOSITORY

# From Git
pi install git:github.com/OWNER/REPOSITORY

# From npm (only after publishing is explicitly enabled)
pi install npm:PACKAGE_NAME
```

For one run without changing Pi settings, use `pi -e /path/to/REPOSITORY`, `pi -e git:github.com/OWNER/REPOSITORY`, or `pi -e npm:PACKAGE_NAME`.

## Remove

Use `pi remove` with the same source string you installed from. Pi matches sources exactly, so `/absolute/path`, `git:...`, and `npm:...` forms are distinct:

```bash
pi remove /absolute/path/to/REPOSITORY
pi remove git:github.com/OWNER/REPOSITORY
pi remove npm:PACKAGE_NAME
```

The example keeps no configuration or state of its own. If you loaded it with `pi -e`, there is nothing to remove.

## Usage and output

Run `/hello [name]`; the argument is trimmed and an empty argument falls back to `world`.

| Mode | `ctx.hasUI` | Output |
| --- | --- | --- |
| TUI, RPC | `true` | An `info` notification via `ctx.ui.notify`. |
| Print, JSON | `false` | A visible custom message with `customType: "template-greeting"` and `triggerTurn: false`. No model turn starts. |

## Configuration and permissions

- The example reads no configuration, environment variables, or files and makes no network request.
- It keeps no state between invocations and starts no background work.
- Extensions run inside the Pi process with Pi's operating-system permissions, so installing one is a trust decision. The packaged example is small enough to review directly.
- Packaging excludes agent instructions, tests, e2e files, docs, environment files, and credentials.

## Development commands

| Task | Command | Notes |
| --- | --- | --- |
| Unit, wiring, and tooling tests | `npm test` | Offline; no Pi process, no `npm pack`, no network. |
| Package check | `npm run check:package` | Asserts the `npm pack` contents. |
| Full local check | `npm run check` | `npm test && npm run check:package`. |
| End-to-end | `npm run test:e2e` | Real Pi: checkout RPC, headless JSON, packed archive. |
| One test file | `node --test test/greeting.test.ts` | Replace with the file you are changing. |

`npm run check` does not run e2e. Run e2e when changing extension wiring, the command contract, package contents, or the Pi baseline. No dependency installation is needed for any command, but e2e needs a compatible Pi binary.

The e2e runner creates a temporary home, config directory, and working directory and passes only an allowlisted environment. It runs Pi offline, makes no provider calls, bounds shutdown, cleans up, and writes a sanitized schema-1 result instead of raw logs.

- **Checkout:** Pi loads `src/index.ts` with `-e`.
- **Headless JSON:** Pi runs `--mode json -p` and the test asserts the visible custom message.
- **Packed archive:** the runner packs the current tree, or reuses an exact checked archive via `PACKAGE_ARCHIVE=/absolute/file.tgz`. It lists and extracts the tarball with a system GNU-compatible `tar` (regular files and directories only), then loads the extracted directory through a temporary Pi `settings.json` `packages` entry and discovers the command from the manifest. It does not run `pi install` or contact a registry; that install path is a known coverage limit.

Set `E2E_RESULT_PATH` to change the result file. `scripts/summarize-e2e.mjs` renders only known fields from it. See [docs/TESTING.md](docs/TESTING.md).

## Packaging

`npm run check:package` treats packaging as an allowlist, not a denylist. The starter ships `package.json`, `README.md`, `LICENSE`, `CHANGELOG.md`, and non-hidden `src/**/*.ts` files, excluding `*.test.ts`, `*.spec.ts`, and `AGENTS.md`/`CLAUDE.md`/`GEMINI.md`. Agent instructions, tests, e2e files, docs, environment files, credentials, and tarballs must not be packed. When you add a resource directory that users need, add it to the `files` allowlist and update the check deliberately.

## Releases

This template is not a publishing project. It ships with `"private": true`, and the release workflow additionally requires the `ENABLE_NPM_PUBLISH` repository variable. Releases are manual and explicitly authorized: a reviewed pull request changes the version and `CHANGELOG.md`, then a maintainer creates a canonical stable `vX.Y.Z` tag. There is no automatic tag on merge. Concrete, non-placeholder repository metadata is required; `private` must also be set to `false` intentionally before publishing.

When enabled, the workflow runs source smoke, packs the final `release/package.tgz`, re-runs e2e with `PACKAGE_ARCHIVE` pointed at that archive, uploads the checked artifact, and publishes those same bytes. E2E and offline steps may create temporary packs; only the final release tarball is preserved and published. Setup, OIDC trusted publishing, and the maintainer procedure live in [docs/RELEASING.md](docs/RELEASING.md).

## Troubleshooting

Common local, e2e, packaging, and release-gate symptoms are listed in [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md). Start with the failing command's own output and the sanitized e2e artifact; do not paste credentials, prompts, or real home-directory paths into an issue.

## Support

- Open an issue at https://github.com/OWNER/REPOSITORY/issues for reproducible bugs and documentation gaps.
- Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md), not in a public issue.
- Replace the placeholder repository URLs before publishing or soliciting support.

## Documentation

| Document | Contents |
| --- | --- |
| [docs/TEMPLATE-SETUP.md](docs/TEMPLATE-SETUP.md) | Rename, replace the example, keep a user-facing README, adjust packaging, and verify. |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Modules, command flow, modes, packaging, and failure behavior. |
| [docs/TESTING.md](docs/TESTING.md) | Test layers, e2e isolation, CI, and what is not covered. |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Common local, e2e, packaging, and release-gate symptoms. |
| [docs/adr/0001-thin-extension-and-layered-tests.md](docs/adr/0001-thin-extension-and-layered-tests.md) | Why the adapter is thin and the tests are layered. |
| [docs/RELEASING.md](docs/RELEASING.md) | Release setup and maintainer procedure. |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Workflow, standards, and pull request checklist. |
| [AGENTS.md](AGENTS.md) | Agent instructions: verified commands, invariants, boundaries. |
| [SECURITY.md](SECURITY.md) | Reporting and security scope. |
| [CHANGELOG.md](CHANGELOG.md) | Notable changes. |

## Security

The example runs no external commands and makes no network requests. Extensions run inside the Pi process with the same operating-system permissions as Pi, so review any extension before installing it. Report vulnerabilities privately; see [SECURITY.md](SECURITY.md).

## License

Apache-2.0. See [LICENSE](LICENSE).
