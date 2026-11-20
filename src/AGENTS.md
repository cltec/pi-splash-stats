<!-- FOR AI AGENTS - Human readability is a side effect, not a goal -->
<!-- Managed by agent: keep sections and order; edit content, not structure -->

# AGENTS.md — src

## Overview

Extension source. There is no build step: Pi loads these TypeScript files directly. `src/index.ts` is the Pi adapter; `src/greeting.ts` is pure and has no Pi imports.

### Key files

| File | Purpose |
| --- | --- |
| `src/index.ts` | Exports the extension function, registers `/hello`, formats the reply, and chooses the UI or message path. |
| `src/greeting.ts` | Pure greeting formatting: trim, fallback to `world`, return `Hello, NAME!`. No I/O, state, or host imports. |

The exact formatter export is an implementation detail. Its behavior is not: trim the argument, use `world` when the result is empty, and return the text in the `Hello, NAME!` shape.

## Setup and environment

- Node.js 22.18+ for development and tests.
- Pi 1.5.2 is the e2e baseline; the extension itself targets current Pi 1.5+ APIs.
- No dependency installation is required.
- Pi supplies the host package at runtime. Do not install it in this repository.
- There is no lint, typecheck, or build. Node strips types; it does not check them.

## Command contract

`/hello [name]`:

| Input | Text |
| --- | --- |
| `/hello` | `Hello, world!` |
| `/hello Ada` | `Hello, Ada!` |
| `/hello   Ada   ` | `Hello, Ada!` |

The handler receives the raw argument string.

- `ctx.hasUI === true` (TUI and RPC): `ctx.ui.notify(text, "info")`.
- `ctx.hasUI === false` (print and JSON): `pi.sendMessage({ customType: "template-greeting", content: text, display: true }, { triggerTurn: false })`.

Do not trigger a model turn. Do not write the message to stdout; Pi owns the protocol streams.

## Conventions

- The starter imports host types only: `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"`. Runtime imports from a host peer are legitimate because Pi supplies the package; use `import type` when only types are needed so unit tests stay fake-friendly. Adding a separate npm dependency is a reviewed decision.
- Export a default function that accepts `pi: ExtensionAPI`. Register commands inside it; do not use top-level side effects.
- Keep formatting and other decision logic pure and in a separate module. The adapter should only read Pi inputs, call pure code, and choose an output sink.
- Do not add global state, timers, subprocesses, file access, configuration, or network calls for the example.
- If you add a resource later, implement cancellation and cleanup, including on errors and shutdown, and add tests for the cleanup path.
- Avoid parameter properties, enums, and namespaces. Use plain fields and string unions.
- Do not log argument content, prompts, secrets, or environment values. The greeting text is user-provided input; do not treat it as a command or HTML.
- The custom message type is `template-greeting`. Rename it only together with the example, tests, e2e assertions, and docs.

## Patterns to follow

| For | Reference | Pattern |
| --- | --- | --- |
| Pure logic | `src/greeting.ts` | deterministic input to output; no host import |
| Pi wiring | `src/index.ts` | register once; narrow adapter; explicit UI branch |
| Headless output | `src/index.ts` | custom message with `display: true`, `triggerTurn: false` |

## Tests and checks

| Task | Command |
| --- | --- |
| Unit, wiring, and tooling tests | `npm test` |
| Single relevant file | `node --test test/greeting.test.ts` |
| Full local check | `npm run check` |
| Real Pi load and command | `npm run test:e2e` |

Wiring tests use a fake `ExtensionAPI` and a fake context. Do not launch Pi from `test/`. See [`../test/AGENTS.md`](../test/AGENTS.md).

## Pull request checklist

- [ ] `npm run check` passes; output is pasted.
- [ ] The pure behavior and both UI/headless branches have tests.
- [ ] `npm run test:e2e` passes if wiring, command behavior, or package loading changed.
- [ ] Docs and `CHANGELOG.md` are updated for user-visible behavior.
- [ ] No new runtime dependency and no top-level side effect.

## Troubleshooting

- `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`: remove parameter properties, enums, or namespaces.
- `Cannot find package '@earendil-works/pi-coding-agent'` during tests: the test process does not install the host. Use `import type` and inject fakes, or provide a stub if the extension legitimately uses host runtime helpers. Do not put the host in `dependencies`.
- `/hello` is missing in Pi: confirm the extension is loaded (`pi -e ./src/index.ts` from the checkout, or the manifest path is correct in the packed package).
- Nothing appears in print or JSON mode: check that the `ctx.hasUI === false` branch calls `pi.sendMessage`; `ctx.ui.notify` is for UI modes.
