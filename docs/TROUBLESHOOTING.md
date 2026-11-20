# Troubleshooting

## Nothing runs, or the test runner rejects TypeScript

**Symptom:** `npm test` fails with a syntax or unknown-file-extension error, or exits before running tests.

- Check `node --version`. Development, tests, and e2e require Node.js 22.18 or newer.
- Use `import type` for host types when you only need types; runtime imports from a host peer are legitimate because Pi supplies it. Avoid parameter properties, enums, and namespaces, which Node's strip-only TypeScript mode does not support.
- There is no build, lint, or typecheck step. If you expected an error from a type mismatch, it will not appear; tests and review are the checks.
- `npm install` is not required. Running it should not be necessary to execute the starter tests.

**Symptom:** `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`.

Rewrite the offending syntax with plain fields, string unions, and regular functions. See [`../test/AGENTS.md`](../test/AGENTS.md).

## A test cannot find the Pi host package

**Symptom:** `Cannot find package '@earendil-works/pi-coding-agent'` while running `npm test`.

The test process does not install the host package. Runtime imports from a host peer are legitimate in an extension because Pi supplies the package, but unit tests must either avoid that path or provide a stub. The starter imports only types and injects a fake `ExtensionAPI`. Do not add the host to `dependencies` to silence this.

## Package check fails

**Symptom:** `npm run check:package` reports unexpected files or a missing entry.

- Run `npm pack --dry-run` and inspect the list.
- The starter allowlist is `package.json`, `README.md`, `LICENSE`, `CHANGELOG.md`, and non-hidden `src/**/*.ts` files, excluding `*.test.ts`, `*.spec.ts`, and `AGENTS.md`/`CLAUDE.md`/`GEMINI.md`.
- Agent instructions, tests, e2e files, docs, environment files, credentials, logs, and tarballs must not be packed.
- `.gitignore` does not control package contents. Use `package.json#files` and the package check.
- When adding a resource, update `package.json#files` and the check together. Do not broaden the allowlist to hide an accidental file.
- Remember that npm always includes the manifest and some root files; the check should reflect actual behavior, not an idealized list.

## End-to-end tests fail

**Symptom:** `pi: not found`.

Set an absolute binary:

```bash
PI_BIN=/absolute/path/to/pi npm run test:e2e
```

**Symptom:** the binary exists but the extension API is missing or behaves differently.

Check the version against `scripts/quality.json` (1.5.2 for this template). An absolute `PI_BIN` selects the binary, and its version must equal the baseline; `PI_VERSION` can set the exact stable version only for a temporary experiment. CI installs that version into a temporary prefix outside the checkout; a random global Pi may not match.

**Symptom:** `/hello` is discovered from the checkout but not from the packed archive.

- Check `package.json#pi` for the extension entry point.
- Check that `files` includes the entry point and any resource the manifest references.
- Confirm the e2e runner packed the current tree. If `PACKAGE_ARCHIVE` is set, it deliberately reuses that exact archive instead of repacking; make sure it is the archive you meant to test.
- The runner extracts the tarball with system GNU-compatible `tar` and loads the extracted directory through temporary Pi settings. It does not run `pi install`; check the manifest and extracted file list rather than npm install state.
- Run `npm run check:package` first; the packed path should not be the first place a packaging mistake appears.

**Symptom:** RPC startup or command invocation times out.

- Bounded shutdown means the runner kills the child after the timeout; the sanitized artifact records only the category.
- Reproduce with a small temporary home and the same Pi binary. Do not reuse your real configuration.
- Check the handler for unresolved promises, timers, or work that waits on a model. The example starts no turn.
- Do not increase the timeout before checking for a hang or a leaked child process.

**Symptom:** the packed path fails while listing or extracting the archive.

The runner needs a system GNU-compatible `tar` and a package containing only regular files and directories. Check `tar --version` and inspect the archive listing. Symlinks, devices, or non-GNU tar behavior are outside the checked path.

**Symptom:** provider authentication errors during e2e.

The runner is supposed to be offline and to pass only an allowlisted environment. Confirm it does not spread `process.env` and does not send a model prompt. Do not add credentials to make the test pass.

**Symptom:** temporary directories, session files, or Pi processes remain.

Cleanup must run in `finally` or test teardown on success and failure. Fix the harness; do not delete leftovers manually and move on. A leaked process is a failure.

**Symptom:** the artifact contains raw logs, environment values, or home paths.

Only sanitized schema-1 summaries belong in the result file (default `artifacts/e2e-result.json`, or `E2E_RESULT_PATH`). `scripts/summarize-e2e.mjs` renders only known fields. Remove raw output from the artifact and keep it in the temporary directory that is deleted. Do not commit artifacts.

## `/hello` does not appear in Pi

- From a checkout, load it explicitly: `pi -e ./src/index.ts`.
- From a package, confirm it is installed and enabled in the current scope, and that the manifest path is correct.
- Extension commands are not built-in slash commands; check that the extension loaded without a warning.
- After changing a locally installed package, reload or reinstall as appropriate. A checkout loaded with `-e` is read at startup.
- If multiple extensions register `hello`, Pi may expose suffixed invocations such as `/hello:1`. Remove or rename the duplicate.

## The reply is missing in print or JSON mode

`ctx.ui.notify` is for UI modes. Print and JSON modes have `ctx.hasUI === false`, and the starter sends a custom message with `display: true` instead. If the output is still missing:

- Confirm the handler reaches the headless branch.
- Confirm `triggerTurn: false` is intentional; the example must not start a model turn.
- Do not write directly to stdout in RPC or JSON mode; Pi owns those protocol streams.

In TUI and RPC modes, `ctx.hasUI` is true and the greeting is an info notification rather than a transcript message. That difference is expected.

## A change works locally but CI fails

- CI runs Linux on Node 22 and 24 with the same commands used locally. Other operating systems are not verified; do not claim they work without running the same checks there.
- CI installs the Pi version from `scripts/quality.json` into a temporary external prefix, which requires network; the checks themselves are offline. A local `pi` on `PATH` may be a different version.
- Use the same commands: `npm run check` and `npm run test:e2e`.
- If dependency installation is needed, the project is no longer the dependency-free starter; update the workflow, lockfile policy, and documentation deliberately.

## Publishing does not work

That is the default. The template sets `"private": true` and the release workflow additionally requires the `ENABLE_NPM_PUBLISH` repository variable. Merging a version bump does not create a tag; stable tags are created manually after review and explicit authorization.

Do not remove the guards or add an automatic tag to work around this. See [`RELEASING.md`](RELEASING.md).

## Additional resources leak into the package

They are treated as shipping files. Move development material outside the allowlist, or add only intentional runtime resources with a matching manifest entry and package-check update. Agent instructions, tests, e2e files, docs, secrets, and environment files must stay out.

## Where to look next

- [`TESTING.md`](TESTING.md) for layer boundaries and e2e isolation.
- [`ARCHITECTURE.md`](ARCHITECTURE.md) for command flow and failure behavior.
- [`TEMPLATE-SETUP.md`](TEMPLATE-SETUP.md) for renaming and replacement work.
- [`../CONTRIBUTING.md`](../CONTRIBUTING.md) for the expected checks.
