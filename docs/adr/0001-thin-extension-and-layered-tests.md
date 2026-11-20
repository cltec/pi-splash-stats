# ADR 0001: Thin extension and layered tests

- Status: Accepted

## Context

A Pi extension runs inside the Pi process and can observe prompts, files, and credentials. That makes the boundary between Pi-specific code and ordinary logic important: code that mixes registration, formatting, I/O, and state is hard to test and harder to review for trust.

The starter also has no lint, typecheck, or build step. Pi loads TypeScript directly, and the tests use Node's strip-only TypeScript support, which removes types without checking them. Correctness therefore depends on runtime tests, small units, and review. At the same time, a unit test that mocks Pi cannot prove that a package installs and exposes its command.

The alternatives considered were:

- Put everything in one extension file and test only through a real Pi process.
- Add a build, lint, and typecheck pipeline to a starter that otherwise needs no dependencies.
- Test only pure logic and skip packaging and real-Pi checks.

A single-file extension makes the Pi boundary invisible. A mocked-only suite can pass while the package is unloadable. A build pipeline adds tooling and generated output to a template whose main value is a small readable surface. Pure-only tests leave manifest and entry-point errors for users to find.

## Decision

Keep the Pi adapter thin and test the system in layers.

1. **Thin adapter.** `src/index.ts` only registers the command, invokes pure logic, and chooses the output channel. It does not format text, read files, keep state, or start resources.
2. **Pure logic.** `src/greeting.ts` is deterministic and has no Pi imports. It can be tested directly and replaced with a fake in wiring tests.
3. **Type-only host dependency.** The starter adapter imports the host package for types, so its tests do not need Pi installed. A runtime import from the host peer is legitimate when Pi supplies it; it is not an npm dependency.
4. **No build pipeline in the starter.** Node strips types for tests; Pi loads source directly. Syntax is restricted to strip-compatible TypeScript. The absence of typechecking is explicit, not an oversight.
5. **Layered tests.**
   - Unit tests cover pure behavior.
   - Wiring tests cover registration, argument handling, and both output branches with fakes.
   - A package check asserts the release allowlist.
   - E2E tests launch real Pi for checkout RPC, checkout headless JSON, and RPC from the packed archive.
6. **E2E isolation.** Temporary home, config, and working directory; an environment allowlist rather than inherited process state; offline operation; no provider call; bounded shutdown; cleanup on failure; sanitized result artifacts instead of raw logs. The packed path uses system GNU-compatible `tar` and loads the extracted directory through temporary Pi settings; it does not run `pi install` or a registry install.

## Consequences

- Most behavior is testable in milliseconds without Pi, credentials, or the network.
- The Pi-specific surface is small enough to review directly.
- Package and manifest mistakes are caught by running the extracted packed archive through a real Pi, not inferred from a mock. The `pi install` command and registry resolution remain outside this check.
- The project deliberately has no static typecheck and no lint. Contributors must keep syntax strip-compatible and rely on tests plus review.
- E2E is slower and needs a compatible Pi binary. It is a separate command, not part of `npm run check`, and must be run when wiring, packaging, or compatibility changes.
- The isolation rules are part of the template's contract. Weakening them, or inheriting credentials to make a test pass, is a regression.
- If the extension grows to include subprocesses, servers, timers, or persistent files, that is a consequential change: add cancellation and cleanup tests, and write a new ADR if the decision changes this structure.

## Alternatives rejected

- **All-in-one extension file:** fewer files, but no direct unit tests and an unclear trust boundary.
- **Build, lint, and typecheck:** useful for larger projects, but adds dependencies and generated output to a starter that is meant to run from source. A fork can add it with its own ADR.
- **Mocked Pi only:** fast, but cannot prove that the package installs, loads, or exposes the command.
- **Real Pi only:** authoritative but slow and unsuitable for edge-case coverage and quick iteration.
