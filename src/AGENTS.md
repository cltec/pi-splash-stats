<!-- FOR AI AGENTS - Human readability is a side effect, not a goal -->
<!-- Managed by agent: keep sections and order; edit content, not structure -->

# AGENTS.md — src

## Overview

Extension source. There is no build step: Pi loads these TypeScript files directly. `src/index.ts` is the thin Pi adapter; it is a silent walking skeleton. Later slices add pure modules (identity, discovery, progress, formatting, transport, UI) that the adapter wires up.

### Key files

| File | Purpose |
| --- | --- |
| `src/index.ts` | Exports the extension function. Currently registers nothing and emits nothing in any mode; later slices add event registration and wiring here. |

Keep the adapter thin: it reads Pi inputs, calls pure modules, and chooses an output sink. Pure modules never import Pi.

## Setup and environment

- Node.js 22.18+ for development and tests.
- Pi 1.6.0 is the e2e baseline; the extension itself targets current Pi 1.5+ APIs.
- No dependency installation is required.
- Pi supplies the host package at runtime. Do not install it in this repository.
- There is no lint, typecheck, or build. Node strips types; it does not check them.

## Behavior contract

The walking skeleton registers no commands, tools, event listeners, messages, or startup notifications, and produces no output in TUI, RPC, print, or JSON modes.

Later slices (per SPECIFICATION.md) must keep RPC, print, and JSON modes completely silent and must not add slash commands, tools, or model-visible instructions. TUI statistics render only when `ctx.mode === "tui"`, using `ctx.mode` together with `ctx.hasUI`, never `hasUI` alone.

Do not write to stdout; Pi owns the protocol streams.

## Conventions

- The starter imports host types only: `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"`. Runtime imports from a host peer are legitimate because Pi supplies the package; use `import type` when only types are needed so unit tests stay fake-friendly. Adding a separate npm dependency is a reviewed decision.
- Export a default function that accepts `pi: ExtensionAPI`. Register commands inside it when a slice adds them; do not use top-level side effects.
- Keep formatting and other decision logic pure and in a separate module. The adapter should only read Pi inputs, call pure code, and choose an output sink.
- Do not add global state, timers, subprocesses, file access, configuration, or network calls for the skeleton.
- If a later slice adds a resource, implement cancellation and cleanup, including on errors and shutdown, and add tests for the cleanup path.
- Avoid parameter properties, enums, and namespaces. Use plain fields and string unions.
- Do not log prompt content, secrets, or environment values. Statistics are transient UI content; never write prompts, model text, or credentials to logs or files.

## Patterns to follow

| For | Reference | Pattern |
| --- | --- | --- |
| Pi wiring | `src/index.ts` | register once (or register nothing); narrow adapter; no top-level side effects |
| Pure logic (later slices) | new `src/*.ts` modules | deterministic input to output; no host import |

## Tests and checks

| Task | Command |
| --- | --- |
| Unit, wiring, and tooling tests | `npm test` |
| Single relevant file | `node --test test/extension.test.ts` |
| Full local check | `npm run check` |
| Real Pi load and command | `npm run test:e2e` |

Wiring tests use a fake `ExtensionAPI` and a fake context. Do not launch Pi from `test/`. See [`../test/AGENTS.md`](../test/AGENTS.md).

## Pull request checklist

- [ ] `npm run check` passes; output is pasted.
- [ ] New behavior has offline tests, including the no-provider-call paths.
- [ ] `npm run test:e2e` passes if wiring, behavior, or package loading changed.
- [ ] Docs and `CHANGELOG.md` are updated for user-visible behavior.
- [ ] No new runtime dependency and no top-level side effect.

## Troubleshooting

- `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`: remove parameter properties, enums, or namespaces.
- `Cannot find package '@earendil-works/pi-coding-agent'` during tests: the test process does not install the host. Use `import type` and inject fakes, or provide a stub if the extension legitimately uses host runtime helpers. Do not put the host in `dependencies`.
- Extension appears to do nothing: that is correct for the walking skeleton. Confirm it is loaded (`pi -e ./src/index.ts` from the checkout, or the manifest path is correct in the packed package); user-visible behavior arrives in later slices.
