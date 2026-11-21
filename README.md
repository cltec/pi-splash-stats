# Pi Splash Stats

A Pi extension that shows live inference statistics for OpenAI-compatible [**Splash**](https://github.com/incoai/splash) servers in the
interactive terminal UI: a **cache-aware prefill progress bar** while the prompt is being processed,
and a **live generation token count** while the model streams its answer.

It is a passive observer. It enriches and watches the inference traffic Pi already sends to a
verified Splash backend, then renders two transient status lines in the TUI. It changes no prompts,
no tools, and no responses, and it stays completely silent in every non-interactive mode.

This extension is inspired by [pi-llama-cpp-stats](https://www.npmjs.com/package/pi-llama-cpp-stats).

```
 ── ⠸ Prefilling... ██████████░░░░░░░░░░  50% · 2s · 20.0 tok/s ─────────────────────
  Generating... ≈5 tok
```

## What you get

- **Cache-aware prefill progress.** A 20-cell bar with percentage, elapsed time, and uncached
  throughput (`Prefilling... ████░░░░ NN% · 2s · 20.0 tok/s`). Cached tokens are not re-counted, so
  the bar reflects the work actually being done.
- **Live generation count.** An approximate token count that grows while the answer streams
  (`Generating... ≈123 tok`), marked with `≈` because it is an estimate, not a final total.
- **TUI only.** The statistics appear only in the interactive terminal UI. RPC, print, and JSON
  modes produce no statistics messages, no terminal output, no notifications, and no transcript
  entries (SPECIFICATION.md §8.4, AC-13).
- **Identity-verified.** It only observes and enriches requests to a Splash backend it has verified
  through the Splash discovery protocol. Requests to any other provider pass through untouched.
- **Bounded and safe.** Updates are coalesced to at most 10 per second (phase changes and cleanup
  render immediately). If the UI API throws, the display is disabled without failing the request.
  If a stream is cut off abruptly, the display is cleared without an unhandled rejection. If
  discovery fails, the original request is sent unchanged.

## Requirements and compatibility

| Requirement | Detail |
| --- | --- |
| Node.js | 22.18 or newer. CI runs Node 22 and 24 on Linux with the same commands; local verification here uses Node 22. |
| Pi | 1.5.2 baseline for the e2e checks, pinned in `scripts/quality.json`. |
| Platform | Linux is tested in CI. Other operating systems are not currently verified. |
| Dependencies | None. `npm install` is not required. E2E additionally needs a Pi binary and a system `tar`. |
| Network | `npm test` and `npm run check` are offline. At runtime the extension makes a single bounded, cached discovery request to the Splash backend to verify provider identity; it makes no other network calls. |

Nothing is built. Pi loads the TypeScript directly, and the tests rely on Node's TypeScript
stripping. There is no lint, typecheck, or build step; stripping does not typecheck.

## Install

```bash
# From a local checkout
pi install /absolute/path/to/pi-splash-stats

# From Git
pi install git:github.com/cltec/pi-splash-stats

# From npm (only after publishing is explicitly enabled)
pi install npm:@cltec/pi-splash-stats
```

For one run without changing Pi settings, use `pi -e /path/to/pi-splash-stats`.

The package is currently `private` and not published to npm; the `npm:` form works only after
publishing is explicitly enabled (see [docs/RELEASING.md](docs/RELEASING.md)).

## Usage

Install the extension and use Pi as usual. The statistics appear automatically while a chat to a
**verified Splash backend** is in flight — no configuration, flags, commands, or launcher handshake.
Activation depends only on the backend serving the current request, never on how Pi was launched
(SPECIFICATION.md §2, Decision D1, AC-02/AC-15). The statistics are transient: they clear when the
response completes or is aborted.

Two launch workflows both work and produce equivalent statistics for the same Splash-served model:

- **`splash pi ...`** — the [Splash](https://github.com/incoai/splash) launcher starts Pi already pointed at a running Splash model. The
  extension observes that model's requests exactly as it would for a directly launched Pi; it does not
  inspect the launcher, parent process, or a particular provider name. If you switch to a non-Splash
  (e.g. cloud) model, the stats clear immediately and subsequent requests are left untouched.
- **Pi launched directly** — configure Pi with a Splash-served OpenAI-compatible model (including a
  server on a non-default port) and run Pi normally. The extension verifies the backend through the
  Splash discovery protocol and shows stats while that model streams. Arbitrary configured provider
  names do not prevent activation; a non-Splash provider simply shows no stats.

The extension reads no configuration, environment variables, or files, keeps no state between
invocations, and starts no background work.

## Remove

Use `pi remove` with the same source string you installed from. Pi matches sources exactly, so
`/absolute/path`, `git:...`, and `npm:...` forms are distinct:

```bash
pi remove /absolute/path/to/pi-splash-stats
pi remove git:github.com/cltec/pi-splash-stats
pi remove npm:@cltec/pi-splash-stats
```

The extension keeps no configuration or state of its own. If you loaded it with `pi -e`, there is
nothing to remove.

## Development commands

| Task | Command | Notes |
| --- | --- | --- |
| Unit, wiring, and tooling tests | `npm test` | Offline; no Pi process, no `npm pack`, no network. |
| Package check | `npm run check:package` | Asserts the `npm pack` contents. |
| Full local check | `npm run check` | `npm test && npm run check:package`. |
| End-to-end | `npm run test:e2e` | Real Pi: checkout RPC, headless JSON, packed archive. |
| One test file | `node --test test/extension.test.ts` | Replace with the file you are changing. |

`npm run check` does not run e2e. Run e2e when changing extension wiring, the command contract,
package contents, or the Pi baseline. No dependency installation is needed for any command, but
e2e needs a compatible Pi binary.

The e2e runner creates a temporary home, config directory, and working directory and passes only an
allowlisted environment. It runs Pi offline, makes no provider calls, bounds shutdown, cleans up,
and writes a sanitized schema-1 result instead of raw logs.

- **Checkout:** Pi loads `src/index.ts` with `-e`.
- **Headless JSON:** Pi runs `--mode json` and the test asserts the extension emits no custom
  messages and exits cleanly.
- **Packed archive:** the runner packs the current tree, or reuses an exact checked archive via
  `PACKAGE_ARCHIVE=/absolute/file.tgz`. It lists and extracts the tarball with a system `tar`, then
  loads the extracted directory through a temporary Pi `settings.json` `packages` entry and discovers
  the extension from the manifest. It does not run `pi install` or contact a registry; that install
  path is a known coverage limit.

Set `E2E_RESULT_PATH` to change the result file. `scripts/summarize-e2e.mjs` renders only known
fields from it. See [docs/TESTING.md](docs/TESTING.md).

A separate real-Pi verification harness drives the terminal UI and non-TUI modes end to end,
including a **packed-package** journey that installs the `npm pack` artifact through the manifest.
See [`.cursor/skills/verify-pi-splash-stats/SKILL.md`](.cursor/skills/verify-pi-splash-stats/SKILL.md).

## Packaging

`npm run check:package` treats packaging as an allowlist, not a denylist. The package ships
`package.json`, `README.md`, `LICENSE`, `CHANGELOG.md`, and non-hidden `src/**/*.ts` files, excluding
`*.test.ts`, `*.spec.ts`, and `AGENTS.md`/`CLAUDE.md`/`GEMINI.md`. Agent instructions, tests, e2e
files, docs, environment files, credentials, and tarballs must not be packed. When you add a resource
directory that users need, add it to the `files` allowlist and update the check deliberately.

## Releases

This package is not a publishing project. It ships with `"private": true`, and the release workflow
additionally requires the `ENABLE_NPM_PUBLISH` repository variable. Releases are manual and
explicitly authorized: a reviewed pull request changes the version and `CHANGELOG.md`, then a
maintainer creates a canonical stable `vX.Y.Z` tag. There is no automatic tag on merge. Concrete,
non-placeholder repository metadata is required; `private` must also be set to `false` intentionally
before publishing.

When enabled, the workflow runs source smoke, packs the final `release/package.tgz`, re-runs e2e with
`PACKAGE_ARCHIVE` pointed at that archive, uploads the checked artifact, and publishes those same
bytes. E2E and offline steps may create temporary packs; only the final release tarball is preserved
and published. Setup, OIDC trusted publishing, and the maintainer procedure live in
[docs/RELEASING.md](docs/RELEASING.md).

## Troubleshooting

Common local, e2e, packaging, and release-gate symptoms are listed in
[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md). Start with the failing command's own output and
the sanitized e2e artifact; do not paste credentials, prompts, or real home-directory paths into an
issue.

## Support

- Open an issue at https://github.com/cltec/pi-splash-stats/issues for reproducible bugs and
  documentation gaps.
- Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md), not in a public issue.

## Documentation

| Document | Contents |
| --- | --- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Modules, request flow, transports, modes, and failure behavior. |
| [docs/TESTING.md](docs/TESTING.md) | Test layers, e2e isolation, the real-Pi verification harness, and what is not covered. |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Common local, e2e, packaging, and release-gate symptoms. |
| [docs/adr/0001-thin-extension-and-layered-tests.md](docs/adr/0001-thin-extension-and-layered-tests.md) | Why the adapter is thin and the tests are layered. |
| [docs/adr/0002-transport-coverage.md](docs/adr/0002-transport-coverage.md) | Why summaries use a scoped fetch observer. |
| [docs/RELEASING.md](docs/RELEASING.md) | Release setup and maintainer procedure. |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Workflow, standards, and pull request checklist. |
| [AGENTS.md](AGENTS.md) | Agent instructions: verified commands, invariants, boundaries. |
| [SECURITY.md](SECURITY.md) | Reporting and security scope. |
| [CHANGELOG.md](CHANGELOG.md) | Notable changes. |

## Security

The extension runs no external commands and reads no configuration. At runtime it makes a single
bounded, cached discovery request to the Splash backend and otherwise only observes the inference
traffic Pi already sends. Extensions run inside the Pi process with the same operating-system
permissions as Pi, so review any extension before installing it. Report vulnerabilities privately;
see [SECURITY.md](SECURITY.md).

## License

Apache-2.0. See [LICENSE](LICENSE).
