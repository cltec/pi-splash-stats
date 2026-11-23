# Changelog

Notable changes to this project. Entries are grouped by release; the latest is listed first.
This repository follows [Keep a Changelog](https://keepachangelog.com/) for entry style.

## [Unreleased]

### Added

- Approximate live generation speed alongside the token count in chat, tool follow-ups, compaction, and branch summaries. The cumulative estimate excludes first-output latency and the first batch, requires at least 500 ms, and falls back to count-only before sufficient observations or on narrow terminals. Final Splash throughput remains authoritative.

## [0.1.1]

### Changed

- README: credit `pi-llama-cpp-stats` as the inspiration for this extension.
- README: link the [Splash](https://github.com/incoai/splash) server repository where Splash is mentioned.

## [0.1.0]

Initial release of the `pi-splash-stats` Pi extension.

### Added

- **Cache-aware prefill progress.** A 20-cell progress bar with percentage, elapsed time, and
  uncached throughput (`Prefilling... ████░░ NN% · 2s · 20.0 tok/s`) while a verified Splash request
  is being processed. Cached tokens are not re-counted.
- **Live generation count.** An approximate token count that grows while the answer streams
  (`Generating... ≈123 tok`), marked with `≈` because it is an estimate.
- **Identity-verified Splash detection.** The extension verifies a provider through the bounded,
  deduplicated, cached Splash discovery protocol (2s deadline; 60s success / 5s failure cache) and
  only enriches and observes requests to a verified Splash backend. Any other provider passes through
  unchanged.
- **Two transports.** Chat is observed through Pi's provider request/stream hooks; compaction and
  branch summaries are observed through a scoped global `fetch` observer, because those requests do
  not fire the provider hooks (see ADR 0002).
- **TUI-only rendering.** Statistics appear only in the interactive terminal UI. RPC, print, and JSON
  modes produce no statistics messages, terminal output, notifications, transcript entries, or
  protocol additions.
- **Bounded, coalesced updates.** Display updates are coalesced to at most 10 per second; phase
  changes and cleanup render immediately.
- **Request ownership.** Per-request generation and model-selection tracking rejects late,
  out-of-order, or stale chunks so concurrent streams cannot mix counts; an armed-request guard
  prevents a stale boundary event from clearing a newer active request.
- **Graceful failure.** A throwing UI API disables the affected display without failing the request;
  an abrupt stream clears the display without an unhandled rejection; a failed discovery leaves the
  original request unchanged.
- **Lifecycle handling.** A fresh discovery cache on `session_start`, disposal on `session_shutdown`,
  and a `runtimeGeneration` bump on each new runtime.
- **Tests and verification.** Offline `node:test` unit and wiring suites, a package-content allowlist
  check, and real-Pi end-to-end checks (checkout RPC, headless JSON, packed archive). A separate
  real-Pi verification harness drives the terminal UI and non-TUI modes end to end, including a
  packed-package journey that installs the `npm pack` artifact through the Pi manifest.
- **Documentation.** Architecture, testing, troubleshooting (with a security section), ADRs
  (thin extension and layered tests; transport coverage), and release guidance.

### Packaging

- Ships `package.json`, `README.md`, `LICENSE`, `CHANGELOG.md`, and non-hidden `src/**/*.ts` files,
  excluding `*.test.ts`, `*.spec.ts`, and `AGENTS.md`/`CLAUDE.md`/`GEMINI.md`. Tests, e2e files, docs,
  agent instructions, and secrets are not packed.
- The packed e2e path lists the tarball with portable `tar -tf` (GNU- and BSD-tar compatible).

### Publishing

- Disabled by default with `"private": true` and the `ENABLE_NPM_PUBLISH` repository-variable gate.
  Releases require a reviewed version/changelog pull request and a manually authorized stable
  `vX.Y.Z` tag; there is no automatic tag on merge.
