# Contributing

Thanks for improving this Pi extension template. The example is intentionally small; keep changes small too.

## Before you start

- Read [`AGENTS.md`](AGENTS.md) and the nearest scoped `AGENTS.md` (`src/`, `test/`, or `e2e/`) for the files you will touch.
- Read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and [`docs/TESTING.md`](docs/TESTING.md).
- For a large change, open an issue first so the approach can be agreed before implementation.
- Do not paste credentials, prompts, or private session content into issues, logs, or test artifacts.

## Requirements

- Node.js 22.18 or newer for development and the tests. CI runs Node 22 and 24 on Linux with the same commands; local verification here uses Node 22.
- Pi 1.5.2 for the e2e checks, matching `scripts/quality.json`. The e2e runner uses `pi` from `PATH` by default; set `PI_BIN` to an absolute path to select another binary. Its version must equal the baseline unless `PI_VERSION` sets the exact stable version. Both variables are for temporary compatibility experiments; update `scripts/quality.json` to adopt a new baseline.
- Linux is the tested platform. Other operating systems are unverified.
- No dependency installation is required for the starter. Pi loads the TypeScript itself. CI installs the pinned Pi version first, which requires network; the checks themselves are offline.

There is no lint, typecheck, or build step. Node strips TypeScript types; it does not verify them.

## Setup

```bash
git clone https://github.com/OWNER/REPOSITORY.git
cd REPOSITORY
npm test
```

To try the checkout in Pi:

```bash
pi -e ./src/index.ts
```

Then run `/hello` and `/hello Ada`.

## Commands

| Task | Command |
| --- | --- |
| Unit, wiring, and tooling tests | `npm test` |
| Single test file | `node --test test/greeting.test.ts` |
| Package contents | `npm run check:package` |
| Full local check | `npm run check` |
| End-to-end tests | `npm run test:e2e` |

Run the smallest relevant check while iterating, then `npm run check` before opening a pull request. Run `npm run test:e2e` when the change affects extension loading, command behavior, package contents, or Pi compatibility.

## Workflow

1. Create a branch from `main`.
2. Make the smallest change that solves the problem.
3. Add or update tests in `test/`. A bug fix should include a regression test that fails without the fix.
4. Run `npm run check` and paste the output in the pull request.
5. If wiring or packaging changed, run `npm run test:e2e` and paste its summary.
6. Update `README.md`, the relevant `docs/` page, and `CHANGELOG.md` for user-visible changes.
7. Commit with a conventional message, for example `fix(hello): trim the fallback argument`.
8. Add an ADR under [`docs/adr/`](docs/adr/) only for a consequential decision, not for routine edits.
9. Open a pull request using the template.

## Quality expectations

- **Evidence, not claims.** Paste command output. "Tests pass" without output is not evidence.
- **Small, reviewable changes.** Do not mix a rename, a behavior change, and a test refactor in one pull request.
- **Regression tests.** A fixed bug gets a test that demonstrates the bug.
- **Documentation follows behavior.** User-visible changes update the README and changelog.
- **Decisions are recorded selectively.** Use an ADR for a public contract, test strategy, package boundary, compatibility policy, or release policy change. Skip ADRs for naming, formatting, and other reversible details.
- **Resources are cleaned up.** If a change introduces a subprocess, temporary directory, timer, server, or open handle, implement cancellation and cleanup and test them.
- **Do not change data you did not intend to change.** Preserve files, messages, and user configuration outside the feature. Tests must use temporary locations, never a real home directory.
- **No hidden network.** Tests and the example are offline. If a feature requires the network, isolate and document it.

## Coding standards

- Keep `src/index.ts` as thin Pi wiring. Put logic that can be pure in its own module.
- The starter imports host packages with `import type`. A runtime import from a host peer is legitimate because Pi supplies it; use `import type` when only types are needed so unit tests can use fakes. Host packages stay peer dependencies, and adding any npm dependency is a reviewed decision.
- Do not add a dependency for logic that a few lines can express. If a dependency is justified, keep host packages as peer dependencies and use optional dependencies only for genuinely optional features.
- Avoid TypeScript parameter properties, enums, and namespaces; Node's strip-only mode does not support them.
- Do not log secrets, prompts, message content, or environment dumps.
- Keep packaging an allowlist. Add new publishable files to `package.json#files` and update `npm run check:package` in the same change.

## Tests

- Use `node:test` and `node:assert/strict`; do not add a test framework.
- Unit and wiring tests are offline. Tooling tests may use temporary filesystem fixtures and isolated local Node child processes for the release CLI; they must not launch Pi, run `npm pack`, or use the network.
- Wiring tests use a fake `ExtensionAPI` and a fake context; they do not launch Pi. Importing pure helpers from `e2e/harness.ts` is allowed.
- E2E tests are the only tests that launch Pi. They must use a temporary home, config, and working directory, pass an allowlisted environment, stay offline, and clean up processes and files. The packed path extracts the tarball with system `tar` and loads the extracted directory; it does not run `pi install`.
- E2E artifacts are sanitized schema-1 summaries. Do not commit raw logs or `e2e-result.json`.

See [`test/AGENTS.md`](test/AGENTS.md) and [`e2e/AGENTS.md`](e2e/AGENTS.md).

## Pull request checklist

- [ ] `npm run check` passes; output is pasted in the pull request.
- [ ] `npm run test:e2e` passes when wiring, packaging, or compatibility changed.
- [ ] New behavior has a test; bug fixes have a regression test.
- [ ] `README.md`, relevant `docs/`, and `CHANGELOG.md` are updated for user-visible changes.
- [ ] No new dependency without justification; no runtime host dependency in `dependencies`.
- [ ] Package contents still match the allowlist; no agent docs, tests, e2e files, secrets, or tarballs are packed.
- [ ] Cancellation and cleanup exist for any new resource.
- [ ] No credentials, prompts, or private session content are included.
- [ ] AI assistance is disclosed if required by your employer or the project.

## Releases

Do not tag or publish from a feature pull request. Version bumps and changelog entries land through a reviewed pull request. A maintainer creates a canonical stable `vX.Y.Z` tag manually after that merge; merging does not create a tag automatically. Publishing is disabled by `"private": true` and by the missing `ENABLE_NPM_PUBLISH` repository variable until a maintainer explicitly configures both. Concrete, non-placeholder repository metadata is required. See [`docs/RELEASING.md`](docs/RELEASING.md).

## AI-assisted contributions

AI assistance is welcome under the same bar as any other contribution: understand the change, keep it focused, add tests, provide command evidence, and respond to review. Do not submit unreviewed generated pull requests.

## Security and license

Report vulnerabilities privately as described in [`SECURITY.md`](SECURITY.md), not in a public issue.

By contributing, you agree that your contributions are licensed under Apache-2.0, the same as this project. Do not edit `LICENSE`.
