# Cancellation, silent modes and package delivery

Users can abort, reload and change sessions without stale stats. Non-terminal modes retain ordinary
Pi behavior without extension protocol output, and installed/packed packages behave like the checkout.

## Sub-features

- `lifecycle-abort`: Escape cancels prefill/generation and clears owned UI (AC-11).
- `lifecycle-reload`: reload creates one active observer; next request works (AC-11).
- `lifecycle-errors`: disconnect, new session, shutdown and late chunks clean up safely (AC-11).
- `mode-silence`: print, JSON and RPC have no stats/discovery/enrichment (AC-13).
- `privacy`: no extension-persisted conversation, credentials or configuration changes (AC-12).
- `delivery-package`: manifest/allowlist/license/private status and packed source load (AC-01/14).

## How to get to it (user POV)

- Press Escape while Pi processes a prompt or generates output.
- Enter `/reload`, `/new`, or exit Pi; disconnect the serving backend.
- Launch Pi with `--print`, `--mode json`, or `--mode rpc`.
- Load a checkout or installed package through Pi's normal manifest.

## Driving it with verify.py

Preconditions: skill baseline; actual packaged source for delivery journey; seeded lifecycle variants for gaps.

- **Abort both phases.** Run `"$V" run abort-prefill` and `"$V" run abort-generation`.
  The PTY sends Escape at the named observed phase. Require a real aborted assistant stop reason,
  cleared UI, one completion attempt, and successful owned-process cleanup.
- **Reload.** Run `"$V" run reload`. Require Pi's actual reload-completion status and a working
  next chat with one inference. This detects obvious stacking, not every retained-wrapper disposal
  case; those still need wiring tests.
- **Non-TUI.** Run `"$V" run print`, `"$V" run json`, `"$V" run rpc`. Require an actual
  completed response, no stats/stderr, valid JSONL where applicable, zero discovery, and payload
  equality to the no-extension baseline. RPC is not terminal-layout proof.
- **Privacy/side effects.** Inspect HTTP metadata, scratch file inventories and config hashes.
  Work/session files must not be created by these no-tools/no-session drives. Provider configuration
  must remain unchanged. Negative-path config hashes must match the baseline.
  This is not proof of every privacy property: review source/wiring for prompt/chunk retention.
- **Packed manifest.** Run `"$V" run packed`. It runs `npm pack`, extracts the tarball, and loads
  the artifact through the Pi manifest (a settings `packages` entry, not `-e`), then drives the same
  `chat` assertions—so it covers the exact bytes a user would install. Preserve the run's evidence
  (prefill/generation screens, `result.json`). For a deeper content inspection, also run
  `npm pack --json`, list with `tar -tzf`, and confirm the 12-file allowlist plus the unchanged
  Apache `LICENSE`. Never use a checkout source path to excuse a missing packed module.
  The journey does not run `pi install`, contact a registry, or authorize publication/tagging.
- **Missing lifecycle journeys.** Disconnect/error, mid-flight switching/probes, `/new`, retained
  old fetch wrappers, and another extension's widget coexistence are currently BLOCKED in the PTY
  seed. Add external faults/user actions plus wiring tests, not synthetic extension callbacks.

## Gotchas

- Forced process termination is evidence of a shutdown problem, not a clean lifecycle pass.
- The `packed` journey exercises the npm artifact end to end (pack, extract, manifest load,
  chat assertions). It does not authorize publication, tagging, or adding dependencies, and it does
  not run `pi install` or contact a registry.
- Run npm package/unit/E2E checks from the specification separately and record their exits;
  PTY smoke cannot replace them. No extra build/lint/typecheck scripts are specified.
- Local fake-server CI is an explicit expansion of the template's no-provider-call boundary.
  Keep its isolated real-Pi tests separate from `npm test`; never use public inference or user auth.
