# Pi Splash Stats verification map

This is the maintained user-journey source for `SPECIFICATION.md`, not a list of implemented features.
Read [the skill](../SKILL.md) first. No extension exists in the initial checkout: every product
journey is initially **BLOCKED**. A harness-only pass does not change that status.

## Baseline preconditions

- Run from repo root; `V=.cursor/skills/verify-pi-splash-stats/scripts/verify.py`.
- Approved Pi 1.5.2, Node ≥22.18.0, Python ≥3.10, `fd` and `rg`; no registry/runtime downloads.
- Actual `pi-splash-stats` package with `pi.extensions: ["./src/index.ts"]`.
- `"$V" doctor` must return `READY_TO_LAUNCH` before product drives.
- Each recipe creates a fresh isolated instance. Never connect to the developer's current TUI.
- Fake identity: arbitrary `verify-local` is Splash; misleading `splash` is llama.cpp;
  both advertise `verify-model` on different prefixed paths on one fresh loopback port.

## Driving conventions

Use stable commands and rendered text, not coordinates or arbitrary tab counts. Automated recipes
send real Pi editor actions and capture `/debug` while the stream is gated. Automatic gates are
verification scaffolding at the external protocol boundary only.

Where the map names a journey beyond the helper's capabilities, record **BLOCKED** with the missing
precondition/harness capability and extend the fixture/driver before claiming coverage. Do not replace
a summary with chat, a tool follow-up with a second user prompt, or a launcher run with direct Pi.

## Proof and skip reporting

Record sub-feature ID, entry point, package/source hashes, versions, action, phase snapshots,
HTTP/side-effect observations and teardown results. Distinguish PASS, FAIL, BLOCKED and NOT RUN.
One convenient entry point never covers the others. A missing seed/precondition is a blocked
journey, not a weaker test that passes. Do not claim an entire AC from one partial assertion.

## Features

| Feature | Main automated recipes | Acceptance scope |
| --- | --- | --- |
| [Activation and switching](activation.md) | `chat`, `non-splash`, `switch` | AC-02/03/07/08/09/10/15 |
| [Cache-aware prefill](prefill.md) | `chat`, `cached` | AC-03/04/10 |
| [Generation feedback](generation.md) | `chat`, `cached` | AC-05/06 |
| [Compaction and branch summaries](summaries.md) | Not yet seeded/driven | AC-05/11 |
| [Cancellation, modes and delivery](lifecycle-and-modes.md) | aborts, `reload`, print/JSON/RPC | AC-01/11/12/13/14 |

The listed ACs are required scope, not passing claims. Real Splash and offline/transport/package gates
remain required even when every available PTY recipe passes.
