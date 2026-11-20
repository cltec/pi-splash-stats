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
- **Packed manifest.** After the approved implementation setup, run:
  ```sh
  bash <<'SH'
  set -euo pipefail
  V=.cursor/skills/verify-pi-splash-stats/scripts/verify.py
  PACK_RUN=$(mktemp -d)
  PACK_EVIDENCE="$(pwd)/.verification-evidence/package-$(date +%Y%m%dT%H%M%S)-$$"
  mkdir -p "$PACK_RUN/npm-cache" "$PACK_EVIDENCE"
  trap 'code=$?; printf "%s\n" "$code" > "$PACK_EVIDENCE/exit-code.txt"; rm -rf "$PACK_RUN"; exit "$code"' EXIT
  npm --offline --cache "$PACK_RUN/npm-cache" --ignore-scripts pack --json --pack-destination "$PACK_RUN" > "$PACK_EVIDENCE/pack.json" 2> "$PACK_EVIDENCE/npm-stderr.txt"
  ARCHIVE=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))[0]["filename"])' "$PACK_EVIDENCE/pack.json")
  tar -tzf "$PACK_RUN/$ARCHIVE" > "$PACK_EVIDENCE/archive-files.txt"
  tar -xzf "$PACK_RUN/$ARCHIVE" -C "$PACK_RUN"
  PACKED_PACKAGE="$PACK_RUN/package"
  "$V" run chat --package "$PACKED_PACKAGE" | tee "$PACK_EVIDENCE/chat.txt"
  "$V" run non-splash --package "$PACKED_PACKAGE" | tee "$PACK_EVIDENCE/non-splash.txt"
  SH
  ```
  Preserve pack output/listing and exits in the package evidence directory, inspect the required
  runtime allowlist and unchanged Apache license. The EXIT trap removes only `"$PACK_RUN"` on
  success or failure. This recipe disables npm lifecycle scripts explicitly; inspect observed files.
  Never use a checkout source path to excuse missing packed modules.
- **Missing lifecycle journeys.** Disconnect/error, mid-flight switching/probes, `/new`, retained
  old fetch wrappers, and another extension's widget coexistence are currently BLOCKED in the PTY
  seed. Add external faults/user actions plus wiring tests, not synthetic extension callbacks.

## Gotchas

- Forced process termination is evidence of a shutdown problem, not a clean lifecycle pass.
- Package recipe is initially BLOCKED: no package/lockfile/license/runtime source exists.
  It has not been executed against the future archive. No publication/tag/dependency authorization implied.
- Run npm package/unit/E2E checks from the specification separately and record their exits;
  PTY smoke cannot replace them. No extra build/lint/typecheck scripts are specified.
- Local fake-server CI is an explicit expansion of the template's no-provider-call boundary.
  Keep its isolated real-Pi tests separate from `npm test`; never use public inference or user auth.
