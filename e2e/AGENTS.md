<!-- FOR AI AGENTS - Human readability is a side effect, not a goal -->
<!-- Managed by agent: keep sections and order; edit content, not structure -->

# AGENTS.md — e2e

## Overview

Real-Pi end-to-end checks. These are the only tests allowed to launch Pi. The smoke runner verifies three paths:

1. **Checkout RPC:** Pi loads `src/index.ts` with `-e` in RPC mode; the test discovers `hello`, invokes it, and checks the notification.
2. **Headless JSON:** Pi runs `--mode json -p`, loads the checkout with `-e`, invokes `/hello Ada`, and the test asserts the visible `template-greeting` custom message and a clean exit.
3. **Packed archive:** the runner packs the current tree, or reuses an exact archive via `PACKAGE_ARCHIVE`. It lists and extracts the tarball with a system GNU-compatible `tar` (regular files and directories only), verifies the package allowlist, writes a temporary Pi `settings.json` whose `packages` entry points at the extracted directory, and starts Pi in RPC mode. Pi discovers the command from the manifest.

The packed path proves the release-shape allowlist and manifest; it does **not** run `pi install` or install from an npm registry. Those paths are a known coverage limit. Say so when reporting e2e evidence.

Run with `npm run test:e2e`. By default the runner packs the current tree; do not pre-pack or commit a tarball. `PACKAGE_ARCHIVE=/absolute/file.tgz` deliberately reuses an exact checked release archive instead of repacking.

## Environment

- Node.js 22.18+. CI runs Node 22 and 24 on Linux with the same commands; local verification here uses Node 22.
- Pi 1.5.2 baseline from `scripts/quality.json`.
- `PI_BIN` must be an absolute path when set; otherwise the runner uses `pi` from `PATH`. The selected binary's reported version must equal the baseline unless `PI_VERSION` sets the exact stable version.
- `PI_BIN` and `PI_VERSION` are for temporary compatibility experiments. Adopting a version means updating `scripts/quality.json` and the docs, not relying on the environment variables.
- CI's initial pinned Pi install requires network. E2E test execution is offline.
- A system GNU-compatible `tar` is required for archive listing and extraction.
- Linux is the tested platform. Do not claim other operating systems.
- No provider credentials and no network calls during test execution.

## Isolation rules

Every e2e run must use a temporary root containing its own home, Pi config directory, cache, agent directory, and working directory. Pass those paths explicitly:

- `HOME`, `USERPROFILE`, `TMPDIR`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, and `PI_CODING_AGENT_DIR` point inside the temporary root.
- The child working directory is a separate temporary directory, not the repository.
- Pass the explicit environment allowlist: `PATH`, `HOME`, `USERPROFILE`, `TMPDIR`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, `PI_CODING_AGENT_DIR`, `PI_OFFLINE=1`, `PI_SKIP_VERSION_CHECK=1`, `PI_TELEMETRY=0`, `LANG=C.UTF-8`, and `CI=1`.
- Never spread `process.env` into the child. Provider keys, proxy variables, shell state, and user configuration must not leak in.
- Load the packed path from the extracted local directory through temporary Pi settings. Do not run `pi install` or contact a registry.
- Do not send a model prompt (a normal user message). Exercise command discovery and `/hello`; extension commands are handled without a provider call.

## Bounded shutdown and cleanup

- Close stdin, request termination, wait a bounded time, then escalate to a kill. Await the child exit and reap it.
- Use `finally` or test teardown so a failed assertion still closes the child and removes the temporary root.
- Clean the temporary home, config, cwd, extraction directory, pack output, and any installed package on both success and failure.
- Do not leave a Pi process, temporary tarball, session file, or socket behind. A leaked process is a test failure, not a warning.
- Failure output must be bounded. Do not dump entire protocol streams.

## Result artifacts

The default path is `artifacts/e2e-result.json`; `E2E_RESULT_PATH` overrides it (an absolute path, or a path resolved from the current working directory). Schema 1 has these fields:

- Top level: `schemaVersion`, `outcome`, `nodeVersion`, `piVersion`, `piBaseline`, `piExpected`, `durationMs`, `cleanup`, `errorCategory`, `checks`.
- Each check: `name`, `status`, `durationMs`, `commands`, `cleanup`, `errorCategory`.

`scripts/summarize-e2e.mjs` renders only known fields: outcome, Node and Pi versions, overall cleanup, and each check's name, status, failure category, and cleanup. It reads the same environment variable and default path. Do not add raw logs, protocol transcripts, environment values, home paths, prompts, or session content to the artifact. Raw logs stay in the temporary directory and are removed with it. Do not commit artifacts.

## Assertions to maintain

The starter smoke checks must verify:

- The selected Pi binary reports exactly the expected version (baseline or explicit temporary override).
- The checkout RPC path starts Pi, lists `hello`, invokes it without starting a model turn, and produces `Hello, Ada!` and `Hello, world!` for a blank argument through the notification channel.
- The headless JSON path exits cleanly and emits exactly one visible `template-greeting` custom message with the expected content and `display: true`.
- The packed archive path lists/extracts only regular files and directories, contains only approved files (no agent docs, tests, e2e files, docs, secrets, or tarballs), and discovers the command with the package origin.
- Both RPC paths end idle with no unexpected messages.

When you replace the example, replace these assertions with the new command contract. Do not weaken them to make a failure pass.

## Security

- Do not add credentials, network fixtures, or provider mocks to make e2e "more realistic".
- Do not write into the real `~/.pi`, the repository, or a user's home.
- Treat Pi output as untrusted; parse protocol records rather than matching incidental text.
- Never interpolate temporary paths or command output into a shell string; pass arguments to `spawn`/`execFile`.
- If an assertion needs sensitive data to diagnose, report the category, not the value.

## Pull request checklist

- [ ] `npm run test:e2e` passes; summary is pasted.
- [ ] Checkout RPC, headless JSON, and packed-archive paths all ran.
- [ ] Temporary home, config, and cwd were used; environment was allowlisted.
- [ ] No provider call, no inherited credentials, and no `pi install` or registry dependency.
- [ ] Bounded shutdown and cleanup completed; no processes or files remain.
- [ ] Only sanitized schema-1 artifacts were produced; none were committed.
- [ ] Smoke assertions match the current example.

## Troubleshooting

- `pi: not found`: set `PI_BIN` to an absolute path.
- `version-mismatch` or `version-unreadable`: check the binary with `pi --version` against `scripts/quality.json`; use `PI_VERSION` only for a temporary experiment.
- `archive-invalid` while listing or extracting: verify system GNU-compatible `tar`, and that the archive contains only regular files and directories.
- RPC timeout: check the handler for unresolved promises or work that waits on a model.
- Command missing from the packed path: verify `package.json#pi` points at the packed entry point and that `files` includes it. If `PACKAGE_ARCHIVE` is set, confirm it is the archive you intended.
- Leftover temporary directory: cleanup did not run in `finally`; fix the harness rather than deleting by hand and moving on.
- Missing or unexpected artifact: check `E2E_RESULT_PATH` and `scripts/summarize-e2e.mjs`.
