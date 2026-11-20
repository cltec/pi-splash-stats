# Changelog

Notable changes to this project. Entries are grouped by release; the latest unreleased work is listed first.

## [Unreleased]

No unreleased changes.

## [0.1.0]

- Added the initial Pi extension template.
- Added the `/hello [name]` command, which replies `Hello, NAME!` and falls back to `Hello, world!` for a blank argument after trimming.
- Split Pi wiring in `src/index.ts` from the pure formatter in `src/greeting.ts`; UI-capable modes show an info notification and headless modes send a custom `template-greeting` message without triggering a model turn.
- Added offline unit, wiring, and tooling tests with `node:test`, a package-content allowlist check, and real-Pi end-to-end checks for checkout RPC, headless JSON, and the packed archive.
- Added template setup, architecture, testing, troubleshooting, security, and contribution documentation.
- Disabled publishing by default with `"private": true` and the `ENABLE_NPM_PUBLISH` repository-variable gate; releases require a reviewed version/changelog pull request and a manually authorized stable tag.
