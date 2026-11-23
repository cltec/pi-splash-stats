# Troubleshooting

## Nothing runs, or the test runner rejects TypeScript

**Symptom:** `npm test` fails with a syntax or unknown-file-extension error, or exits before running tests.

- Check `node --version`. Development, tests, and e2e require Node.js 22.18 or newer.
- Use `import type` for host types when you only need types; runtime imports from a host peer are legitimate because Pi supplies it. Avoid parameter properties, enums, and namespaces, which Node's strip-only TypeScript mode does not support.
- There is no build, lint, or typecheck step. If you expected an error from a type mismatch, it will not appear; tests and review are the checks.
- `npm install` is not required. Running it should not be necessary to execute the tests.

**Symptom:** `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`.

Rewrite the offending syntax with plain fields, string unions, and regular functions. See [`../test/AGENTS.md`](../test/AGENTS.md).

## A test cannot find the Pi host package

**Symptom:** `Cannot find package '@earendil-works/pi-coding-agent'` while running `npm test`.

The test process does not install the host package. Runtime imports from a host peer are legitimate in an extension because Pi supplies the package, but unit tests must either avoid that path or provide a stub. The extension imports only types and injects a fake `ExtensionAPI`. Do not add the host to `dependencies` to silence this.

## Package check fails

**Symptom:** `npm run check:package` reports unexpected files or a missing entry.

- Run `npm pack --dry-run` and inspect the list.
- The allowlist is `package.json`, `README.md`, `LICENSE`, `CHANGELOG.md`, and non-hidden `src/**/*.ts` files, excluding `*.test.ts`, `*.spec.ts`, and `AGENTS.md`/`CLAUDE.md`/`GEMINI.md`.
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

Check the version against `scripts/quality.json` (1.6.0 for this project). An absolute `PI_BIN` selects the binary, and its version must equal the baseline; `PI_VERSION` can set the exact stable version only for a temporary experiment. CI installs that version into a temporary prefix outside the checkout; a random global Pi may not match.

**Symptom:** the extension entry point is discovered from the checkout but not from the packed archive.

- Check `package.json#pi` for the extension entry point.
- Check that `files` includes the entry point and any resource the manifest references.
- Confirm the e2e runner packed the current tree. If `PACKAGE_ARCHIVE` is set, it deliberately reuses that exact archive instead of repacking; make sure it is the archive you meant to test.
- The runner extracts the tarball with system GNU-compatible `tar` and loads the extracted directory through temporary Pi settings. It does not run `pi install`; check the manifest and extracted file list rather than npm install state.
- Run `npm run check:package` first; the packed path should not be the first place a packaging mistake appears.

**Symptom:** RPC startup or command invocation times out.

- Bounded shutdown means the runner kills the child after the timeout; the sanitized artifact records only the category.
- Reproduce with a small temporary home and the same Pi binary. Do not reuse your real configuration.
- Check the adapter for unresolved promises, timers, or work that waits on a model. The extension starts no turn.
- Do not increase the timeout before checking for a hang or a leaked child process.

**Symptom:** the packed path fails while listing or extracting the archive.

The runner lists the archive with portable `tar -tf` (no GNU-only flags), so it works with GNU and
BSD `tar`; it accepts only regular files and directories. Check `tar --version` and inspect the
archive listing. Symlinks, devices, and other special entries are outside the checked path.

**Symptom:** provider authentication errors during e2e.

The runner is supposed to be offline and to pass only an allowlisted environment. Confirm it does not spread `process.env` and does not send a model prompt. Do not add credentials to make the test pass.

**Symptom:** temporary directories, session files, or Pi processes remain.

Cleanup must run in `finally` or test teardown on success and failure. Fix the harness; do not delete leftovers manually and move on. A leaked process is a failure.

**Symptom:** the artifact contains raw logs, environment values, or home paths.

Only sanitized schema-1 summaries belong in the result file (default `artifacts/e2e-result.json`, or `E2E_RESULT_PATH`). `scripts/summarize-e2e.mjs` renders only known fields. Remove raw output from the artifact and keep it in the temporary directory that is deleted. Do not commit artifacts.

## The statistics don't appear in the TUI

The extension is a passive observer: it shows stats only while a request to a **verified Splash
backend** is in flight, and only in the **interactive terminal UI**. If the prefill bar or
generation count doesn't appear:

- **Confirm you are in the TUI.** Statistics are rendered only when `ctx.mode === "tui"`. RPC, print,
  and JSON modes are silent by design (SPECIFICATION §8.4). Run an interactive `pi` session.
- **Confirm the backend is verified Splash.** The extension verifies the provider through the Splash
  discovery protocol. A request to any other provider is not enriched and shows no stats. (The
  harness's misleadingly `splash`-named provider is a llama.cpp backend, not Splash.)
- **Check that the request is streaming.** Stats appear only while a chat is being prefilled or
  generating; a completed or aborted turn clears them.
- **Check discovery.** A failed or timed-out (2s) discovery leaves the request unchanged and shows
  no stats; the failure is cached for 5s. If the backend's discovery endpoint is unreachable, stats
  won't appear until it recovers.
- **Reload after a local change.** A checkout loaded with `-e` is read at startup; reload (`/reload`)
  or restart Pi after editing source.
- **From a package**, confirm it is installed and enabled in the current scope and that the manifest
  path (`pi.extensions: ["./src/index.ts"]`) is correct.

## A change works locally but CI fails

- CI runs Linux on Node 22 and 24 with the same commands used locally. Other operating systems are not verified; do not claim they work without running the same checks there.
- CI installs the Pi version from `scripts/quality.json` into a temporary external prefix, which requires network; the checks themselves are offline. A local `pi` on `PATH` may be a different version.
- Use the same commands: `npm run check` and `npm run test:e2e`.
- If dependency installation is needed, the project is no longer dependency-free; update the workflow, lockfile policy, and documentation deliberately.

## Publishing does not work

That is the default. The project ships `"private": true` and the release workflow additionally requires the `ENABLE_NPM_PUBLISH` repository variable. Merging a version bump does not create a tag; stable tags are created manually after review and explicit authorization.

Do not remove the guards or add an automatic tag to work around this. See [`RELEASING.md`](RELEASING.md).

## Additional resources leak into the package

They are treated as shipping files. Move development material outside the allowlist, or add only intentional runtime resources with a matching manifest entry and package-check update. Agent instructions, tests, e2e files, docs, secrets, and environment files must stay out.

## Security

- **The extension makes no model call of its own.** It only observes and enriches the inference
  traffic Pi already sends, plus a single bounded (2s) cached discovery request to verify the provider
  identity. It reads no configuration, environment variables, or files, and keeps no persistent state.
- **Silence is a feature, not a failure.** RPC, print, and JSON modes produce no statistics messages,
  terminal output, notifications, transcript entries, or protocol additions. If you see stats outside
  the TUI, that is a regression — report it.
- **Discovery is the only outbound request.** It is scoped to the Splash backend, deduplicated, and
  cached (60s success / 5s failure). A non-Splash provider is never enriched or observed for stats.
- **Extensions run with Pi's permissions.** They can see prompts, files, and credentials in the Pi
  process. Review an extension before installing it; this one is packaged as an allowlist with no
  runtime dependencies and no install scripts.
- **No credentials in artifacts.** The e2e result and the verification harness write only sanitized,
  schema-versioned evidence. Never paste credentials, prompts, or real home-directory paths into an
  issue. Report vulnerabilities privately per [`../SECURITY.md`](../SECURITY.md).
- **No automatic publishing.** The package is `private`; publishing is manual and requires a reviewed
  version/changelog pull request, an explicit `ENABLE_NPM_PUBLISH` setting, and a maintainer-created
  stable tag. There is no automatic tag on merge.

## Where to look next

- [`TESTING.md`](TESTING.md) for layer boundaries and e2e isolation.
- [`ARCHITECTURE.md`](ARCHITECTURE.md) for request flow and failure behavior.
- [`../CONTRIBUTING.md`](../CONTRIBUTING.md) for the expected checks.
