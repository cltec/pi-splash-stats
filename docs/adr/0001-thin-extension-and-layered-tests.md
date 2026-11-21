# ADR 0001: Thin extension and layered tests

- Status: Accepted
- Supersedes: the walking-skeleton version of this ADR (which described a greeting command and a
  single `src/greeting.ts` module). This revision records the architecture once the statistics
  feature is implemented.

## Context

A Pi extension runs inside the Pi process and can observe prompts, files, and credentials. That
makes the boundary between Pi-specific wiring and ordinary logic important: code that mixes event
registration, formatting, I/O, and request state is hard to test and harder to review for trust.
The statistics feature has real state (active request, discovery cache, UI ownership) and two
transports (provider hooks and a scoped fetch observer), so keeping the Pi surface small is the main
defense against accidental leakage of prompts, chunks, or credentials.

The project also has no lint, typecheck, or build step. Pi loads TypeScript directly, and the tests
use Node's strip-only TypeScript support, which removes types without checking them. Correctness
therefore depends on runtime tests, small units, and review. At the same time, a unit test that
mocks Pi cannot prove that a package installs, loads through the manifest, and stays silent in
non-interactive modes.

The alternatives considered were:

- Put everything in one extension file and test only through a real Pi process.
- Add a build, lint, and typecheck pipeline to a project that otherwise needs no dependencies.
- Test only pure logic and skip packaging and real-Pi checks.

A single-file extension makes the Pi boundary invisible. A mocked-only suite can pass while the
package is unloadable or leaks into RPC mode. A build pipeline adds tooling and generated output to
a project whose main value is a small readable surface. Pure-only tests leave manifest, entry-point,
and mode-silence errors for users to find.

## Decision

Keep the Pi adapter thin and test the system in layers.

1. **Thin adapter.** `src/index.ts` only wires Pi lifecycle events (`session_start`,
   `model_select`, `session_shutdown`), the provider request/stream hooks, and the TUI
   working-message/widget registration. It gates all rendering on `ctx.mode === "tui"` and delegates
   everything else to pure modules. It does not format text, do statistics math, own the discovery
   cache, or touch the network.
2. **Pure logic.** The behavior lives in modules with no Pi imports, each tested directly:
   - `src/identity.ts` — endpoint normalization, discovery URL, and identity-response validation.
   - `src/discovery.ts` — the bounded, deduplicated, cached Splash discovery (2s deadline; 60s
     success / 5s failure cache) and auth-context key.
   - `src/transport.ts` — request eligibility, payload enrichment, and stream attribution.
   - `src/progress.ts` — the statistics math (prefill state/snapshot, generation state, request
     state) and validation bounds.
   - `src/format.ts` — compact-line rendering (bar, percent, count, rate, ETA) with width fallbacks.
   - `src/ui.ts` — working-message and widget ownership, update coalescing, and throw-safe display.
3. **Scoped observer.** `src/fetch-observer.ts` installs a scoped global `fetch` observer used only
   for compaction and branch summaries, whose requests do not fire the provider hooks. See
   [ADR 0002](0002-transport-coverage.md) for why this second transport exists and how it is bounded.
4. **Type-only host dependency.** The adapter imports the host package for types, so its tests do not
   need Pi installed. A runtime import from the host peer is legitimate when Pi supplies it; it is not
   an npm dependency.
5. **No build pipeline.** Node strips types for tests; Pi loads source directly. Syntax is restricted
   to strip-compatible TypeScript (no parameter properties, enums, or namespaces). The absence of
   typechecking is explicit, not an oversight.
6. **Layered tests.**
   - Unit tests cover each pure module's behavior and edge cases.
   - Wiring tests (`test/extension.test.ts`) cover event registration, mode gating, ownership,
     lifecycle, and failure paths with fakes.
   - A package check asserts the release allowlist.
   - E2E tests launch real Pi for checkout RPC, checkout headless JSON, and the packed archive.
7. **E2E isolation.** Temporary home, config, and working directory; an environment allowlist rather
   than inherited process state; offline operation; no provider call; bounded shutdown; cleanup on
   failure; sanitized result artifacts instead of raw logs. The packed path lists and extracts the
   tarball with a portable system `tar` (`tar -tf`, no GNU-only flags), loads the extracted directory
   through a temporary Pi `settings.json` `packages` entry, and discovers the extension from the
   manifest. It does not run `pi install` or contact a registry.
8. **Identity-gated activation, not timing-field-gated.** The extension activates only after the
   Splash discovery protocol verifies the backend: a `GET <base>/models` response whose `data` array
   contains an object whose `id` exactly matches the request's model and whose `owned_by` is exactly
   `"splash"` (SPECIFICATION.md §5.2). Timing fields are deliberately **not** an activation signal.
   OpenAI-compatible and llama.cpp endpoints can emit `prompt_progress`-compatible and
   `timings`-compatible fields (SPECIFICATION.md §5.5, AC-08), so detecting those fields alone would
   activate the extension on a non-Splash backend and misattribute its traffic. Provider names,
   ports, model names, and HTTP server headers are equally insufficient. The scoped `fetch` observer
   in [ADR 0002](0002-transport-coverage.md) reuses this same identity gate for summary requests, so
   summary activation is identity-gated too, not timing-gated.

## Consequences

- Most behavior is testable in milliseconds without Pi, credentials, or the network.
- The Pi-specific surface is small enough to review directly: `src/index.ts` is the only file that
  knows about Pi events and the TUI.
- Package, manifest, and mode-silence mistakes are caught by running the extracted packed archive
  through a real Pi, not inferred from a mock. The `pi install` command and registry resolution
  remain outside this check.
- The project deliberately has no static typecheck and no lint. Contributors keep syntax
  strip-compatible and rely on tests plus review.
- E2E is slower and needs a compatible Pi binary. It is a separate command, not part of
  `npm run check`, and must be run when wiring, packaging, or compatibility changes.
- The isolation rules are part of the project's contract. Weakening them, or inheriting credentials
  to make a test pass, is a regression.
- If the extension grows to include subprocesses, servers, long-lived timers, or persistent files,
  that is a consequential change: add cancellation and cleanup tests, and write a new ADR if the
  decision changes this structure.

## Alternatives rejected

- **All-in-one extension file:** fewer files, but no direct unit tests and an unclear trust boundary.
- **Build, lint, and typecheck:** useful for larger projects, but adds dependencies and generated
  output to a project meant to run from source. A fork can add it with its own ADR.
- **Mocked Pi only:** fast, but cannot prove that the package installs, loads, and stays silent in
  RPC/print/JSON modes.
- **Real Pi only:** authoritative but slow and unsuitable for edge-case coverage and quick iteration.
