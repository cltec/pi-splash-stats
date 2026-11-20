# Template setup

This starter works as-is, but it is still a template. Work through this checklist before treating the repository as a real extension.

The placeholders to replace are `OWNER`, `REPOSITORY`, and `PACKAGE_NAME`. The example command, its custom message type, and its smoke assertions are also template material.

## 1. Decide the feature and its boundaries

Write down what the extension does, what it reads, and what it changes. The starter deliberately has no network access, configuration, background process, or persistent state. Adding any of those expands the trust and testing surface; plan for cancellation, cleanup, and failure tests before writing code. If the decision is consequential, record it as an ADR. Routine naming and formatting do not need one.

Keep the Apache-2.0 [`LICENSE`](../LICENSE) file unchanged.

## 2. Rename the project metadata

- `package.json`: `name`, `version`, `description`, `keywords`, `repository`, `homepage`, `bugs`, `author`, and any funding or gallery fields.
- `PACKAGE_NAME` in installation examples; use the real npm name or remove the npm examples if the project will not be published.
- `OWNER/REPOSITORY` in clone, install, badge, and security-advisory URLs.
- `README.md` title, tagline, feature description, requirements, and documentation table.
- `SECURITY.md` advisory URL and supported-version table.
- `.github/` workflow names, badges, and repository references.
- `CHANGELOG.md`: replace the template 0.1.0 entry with the first real release entry, keeping an `Unreleased` section.
- Remove the placeholder note from the README once the placeholders are gone.

Do not leave a CI or npm badge pointing at a project that does not exist.

## 3. Replace the example

The greeting example exists to show a complete vertical slice, not to constrain the feature.

- Keep `src/index.ts` as a thin adapter: register the command or tool, call pure logic, choose the output channel.
- Move decisions and formatting into a pure module. It should not import Pi or perform I/O.
- Preserve the adapter's mode handling if the feature produces user-facing text: UI modes can notify; headless modes need a custom message or another non-interactive output.
- Replace `template-greeting` with a stable custom message type. Apply `display` and `triggerTurn` deliberately; the starter sets `display: true` and `triggerTurn: false` so the message is visible without starting a model turn.
- Remove the `/hello` command and greeting module if the new feature does not need them. Do not keep dead examples.

If the feature introduces a tool, configuration, a subprocess, a server, or files, add explicit cancellation and cleanup paths and test them. Do not silently inherit credentials or user configuration.

## 4. Replace the tests and smoke assertions

- Replace greeting unit tests with tests for the new pure logic, including empty, invalid, and boundary inputs.
- Replace wiring tests with assertions for the new registration, argument handling, and output-channel branches. Use fakes; do not launch Pi from `test/`.
- Update e2e smoke assertions in `e2e/` for the new command or tool, including checkout RPC, headless JSON, and the packed archive.
- Keep at least one test that fails if the feature is reverted.
- Keep tests offline and deterministic. Use temporary directories for any new filesystem work.
- If the change is user-visible, add a changelog entry.

See [`TESTING.md`](TESTING.md) and [`../e2e/AGENTS.md`](../e2e/AGENTS.md).

## 5. Adjust packaging when adding resources

The starter package allowlist is `package.json`, `README.md`, `LICENSE`, `CHANGELOG.md`, and non-hidden `src/**/*.ts` files, excluding `*.test.ts`, `*.spec.ts`, and `AGENTS.md`/`CLAUDE.md`/`GEMINI.md`. The package check fails on unexpected files, including agent instructions, tests, e2e files, docs, environment files, credentials, and tarballs.

When the extension needs skills, prompts, themes, or other resources:

1. Put them in a clear resource directory.
2. Add the directory or files to `package.json#files`.
3. Declare the paths in `package.json#pi` if they are not in conventional locations.
4. Update `npm run check:package` so the allowlist and the check agree.
5. Run `npm pack --dry-run` and inspect the file list before merging.

Do not solve a packaging failure by broadening the allowlist until it includes development material. Keep the minimum release surface.

## 6. Choose dependency policy

The starter has no dependencies and needs no install step. Keep it that way unless the feature genuinely benefits from a dependency.

- Pi host packages are peer dependencies only. Never put them in `dependencies`.
- Use optional dependencies for features that are genuinely optional at runtime, and handle a missing optional package gracefully.
- Do not add a library for a few lines of logic.
- Review install scripts and transitive dependency risk before merging.
- If the package becomes non-trivial, reconsider adding a typecheck or build step; the starter has neither, and Node's type stripping does not check types.

## 7. Update the Pi and Node baseline

- `scripts/quality.json` holds the `piVersion` used by e2e and CI. The starter baseline is 1.5.2.
- CI installs that pinned Pi version into a temporary prefix outside the checkout instead of relying on a globally installed Pi.
- `PI_BIN` selects a specific absolute Pi binary locally; its version must equal the pinned baseline. `PI_VERSION` can set the exact stable version for a temporary compatibility experiment. Neither changes CI's baseline: update `scripts/quality.json` and the docs to adopt a new version.
- CI installs the pinned Pi version first, which requires network. Test execution is offline.
- The starter requires Node.js 22.18+. CI runs Node 22 and 24 on Linux; local verification here uses Node 22. Do not claim additional operating-system or local Node coverage without running the checks there.
- There is no lint, typecheck, or build step. Do not document one unless you add it.

## 8. Configure CI, permissions, and releases

- Keep the CI matrix aligned with the tested Node versions and Linux.
- Make sure the workflow installs Pi from `scripts/quality.json`, runs `npm run check`, and runs `npm run test:e2e` on the same commands used locally.
- Keep the release sequence: source smoke, then a final `release/package.tgz`, then an extra e2e run with `PACKAGE_ARCHIVE` pointed at that archive, then publish those checked bytes. E2E and offline steps may create temporary packs; only the final release tarball is preserved and published.
- Extensions run with Pi's operating-system permissions. Document any new permissions, trust assumptions, or data access in the README and `SECURITY.md`.
- Publishing stays disabled by `"private": true` and the `ENABLE_NPM_PUBLISH` repository variable until a maintainer deliberately enables it, including setting `private` to `false`.
- Releases are manual: a reviewed pull request changes the version and `CHANGELOG.md`, then a maintainer creates a canonical stable `vX.Y.Z` tag. Merging does not create a tag automatically.
- Follow [`RELEASING.md`](RELEASING.md) for the trusted-publishing setup. Do not add an automatic tag or publish step as part of template customization.

## 9. Rewrite the documentation

- Update `ARCHITECTURE.md` with the new modules, data flow, failure behavior, and any resource lifecycle.
- Update `TESTING.md` with the new layers and isolation rules.
- Update `TROUBLESHOOTING.md` with symptoms users and contributors will actually hit.
- Revisit the ADR. The thin-adapter and layered-test decision may still hold; if the feature contradicts it, write a new ADR rather than silently editing history.
- Delete documentation for removed features. Do not keep template instructions in a shipped README.

### README author checklist

A renamed template is not automatically a good README. Before publishing, make the README answer:

- **Problem and value:** what user problem the extension solves and why it is useful.
- **Installation:** one clear install path, plus the exact form for a local checkout, Git, or npm source.
- **Usage:** a minimal invocation and what the user sees.
- **Output:** which modes get notifications, messages, files, or other side effects.
- **Configuration:** settings, environment variables, or the explicit statement that there are none.
- **Permissions:** what the extension can read, write, execute, or send, and the trust decision for users.
- **Troubleshooting:** the common failure symptoms and where to look next.
- **Removal:** `pi remove <same-source>`, noting that the source string must match the installed source exactly.
- **Support:** where to file bugs and how to report security issues privately.
- **Compatibility:** supported Node and Pi versions, tested platforms, and known limits.
- **Development:** the local check and e2e commands, with a link to the detailed docs.

Keep this section short; it is a checklist, not a second README.

## 10. Verify before publishing

Run and paste the output:

```bash
npm test
npm run check:package
npm run check
npm run test:e2e
npm pack --dry-run
```

Confirm:

- The package contains only approved release files.
- No agent docs, tests, e2e files, docs, secrets, environment files, or tarballs are packed.
- No `OWNER`, `REPOSITORY`, `PACKAGE_NAME`, `/hello`, or `template-greeting` placeholders remain in shipped files.
- The e2e paths exercise the real Pi binary and leave no processes or temporary directories behind.
- For a release, the final `release/package.tgz` is exercised separately with `PACKAGE_ARCHIVE` before those exact bytes are published.
- The README, changelog, security policy, and release documentation match the code.
- `LICENSE` is unchanged.

## 11. If you keep the template public

Keep the example and its checks working so forks can start from a green baseline. Treat changes to the example as changes to the template contract: update `README.md`, `src/AGENTS.md`, `test/AGENTS.md`, `e2e/AGENTS.md`, and the smoke assertions together.
