# ADR 0002: Transport coverage for summary requests (provider hooks vs scoped fetch observer)

- Status: Accepted (S5; implemented via `src/fetch-observer.ts`, phase-gated in `src/index.ts`)

## Context

SPECIFICATION.md §10.2 requires statistics for ordinary chat, compaction summaries, and `/tree` branch summaries, and asks whether the supported Pi provider hooks (`before_provider_request`, `provider_stream_event`) cover all three request kinds in the pinned Pi 1.5.2 baseline. If not, a scoped `fetch` observer is required, and it must still satisfy foreground attribution and reload semantics.

The question to answer: in installed Pi 1.5.2, do `before_provider_request` and `provider_stream_event` fire for (a) compaction summary requests and (b) `/tree` branch-summary requests, or only for ordinary agent chat calls?

## Evidence

### Static source trace (installed Pi 1.5.2)

Paths under `/Users/cirolucio.tecce/.pi/agent/install/releases/1.5.2/node_modules/@earendil-works/`.

1. The extension provider hooks are wired as per-request options, not as global wrappers. `pi-coding-agent/dist/core/sdk.js:225-248` defines `transformProviderPayload` (`before_provider_request`), `handleProviderResponse` (`after_provider_response`), and `handleProviderStreamEvent` (`provider_stream_event`), and passes them to the `Agent` constructor as `onPayload` / `onResponse` / `onProviderStreamEvent` (sdk.js:275-280).
2. `pi-agent-core/dist/agent.js:130-134` stores those options on the `Agent`; `agent.js:305-330` (`createLoopConfig`) puts them into the agent-loop config.
3. `pi-agent-core/dist/agent-loop.js:275-280` (`streamAssistantResponse`) is the only path that forwards them: it calls `streamFunction(config.model, llmContext, { ...config, ... })`, so the hook options reach the pi-ai transport (e.g. `pi-ai/dist/api/openai-completions.js:340`) **only for agent-loop chat requests**.
4. The SDK stream function's `buildRequestOptions` (`pi-coding-agent/dist/core/sdk.js:186-211`) spreads the caller's options and unconditionally injects `transformHeaders` (`before_provider_headers`) — but does **not** inject `onPayload` / `onResponse` / `onProviderStreamEvent`.
5. Summarization builds its own options. `pi-coding-agent/dist/core/compaction/compaction.js:463-469` (`createSummarizationOptions`) produces only `{ signal, apiKey, headers, env, sessionId, reasoning? }`. `compaction.js:477-489` (`completeSummarization`) calls the same `streamFn` with `{ ...options, cacheRetention: "none", sessionId: options.sessionId ?? uuidv7() }` — no hook options.
6. Both summary mechanisms go through that choke point: manual/auto compaction passes `this.agent.streamFunction` (`pi-coding-agent/dist/core/agent-session.js:2305`), and `/tree` navigation with summarization passes `streamFn: this.agent.streamFunction` into `generateBranchSummary` (`agent-session.js:3443`; `dist/core/compaction/branch-summarization.js:230-237` builds `{ apiKey, headers, env, signal }` and calls `completeSummarization`).

Static conclusion: summary requests use the same underlying provider transport (`modelRuntime.streamSimple`) but arrive **without** the hook options, so `before_provider_request`, `after_provider_response`, and `provider_stream_event` cannot fire for them. `before_provider_headers` is injected unconditionally by `buildRequestOptions`, so it does.

### Live probe (isolated real Pi 1.5.2)

Throwaway probe extension (`probe/probe-ext.ts`) registered handlers for `before_provider_headers`, `before_provider_request`, `after_provider_response`, and `provider_stream_event`, logging transport metadata only (hook name, model id, message count, status, stream-event shape — never prompt/payload/credential content) to `PROBE_LOG`. A stdlib loopback OpenAI-compatible server (`probe/fake-server.py`, 127.0.0.1, `/v1/chat/completions` SSE) recorded each request's method/path/model. Runs used a temporary `PI_CODING_AGENT_DIR`/`HOME`, an environment allowlist, and Pi `--no-*` flags disabling tools/skills/MCP/extensions (as recorded in the probe `command.json` argv), with no user config and no network path beyond the loopback fixture; every process and scratch directory was torn down.

- RPC run (`probe/run-rpc.py`): 3 chat prompts + manual `{"type":"compact"}` (session padded past `compaction.keepRecentTokens`; default 20k makes small sessions report "Nothing to compact (session too small)"). Evidence: `probe/evidence-rpc/` (`probe-hooks.jsonl`, `server.jsonl`, `rpc-transcript.jsonl`, `compact-response.json`), 4 server POSTs.
- TUI run (`probe/run-tui.py`, PTY): 2 chat prompts, then `/tree` → select first user entry → "Summarize branch?" → "Summarize". Terminal capture shows `[branch] Branch summary (ctrl+o to expand)` and `Navigated to selected point`. Evidence: `probe/evidence-tui/` (`probe-hooks.jsonl`, `server.jsonl`, `terminal.ansi`, `actions.jsonl`), 3 server POSTs. 1.5.2 exposes no RPC command for tree navigation (full command list in `docs/rpc-commands.md` of the Pi package: `compact` yes, tree navigation no), so the TUI is the only trigger.

Observed hook fire matrix:

| Request kind | `before_provider_headers` | `before_provider_request` | `after_provider_response` | `provider_stream_event` |
| --- | --- | --- | --- | --- |
| Chat (RPC ×3, TUI ×2) | yes | yes | yes (200) | yes (per SSE chunk) |
| `/compact` summary (RPC ×1) | yes | **no** | **no** | **no** |
| `/tree` branch summary (TUI ×1) | yes | **no** | **no** | **no** |

The live result matches the static trace exactly.

## Decision (final)

**Hooks alone are insufficient. Use provider hooks for chat plus a scoped `fetch` observer for summary streams.**

- `before_provider_request` / `provider_stream_event` / `after_provider_response` cover ordinary agent chat only. Compaction and branch-summary requests are internal model calls that bypass the hook options; this is demonstrated for Pi 1.5.2, not inferred.
- The fetch observer is the only mechanism that sees the summary requests, since they flow through the same global `fetch`-based pi-ai transport.
- **Foreground attribution is satisfiable** without hooks on the summary path: the observer does not match on endpoint alone; it attributes a request to the foreground operation active at send time. Pi 1.5.2 surfaces that operation through session lifecycle events (see Resolution). Summary requests are distinguishable at the transport level (`cacheRetention: "none"`, one-shot routing `sessionId`, single summarization user message), which supports — but per §10.2 must not replace — foreground-operation matching.
- **Reload semantics are satisfiable**: `/reload` and session replacement run `session_shutdown` and load a replacement extension runtime, so the observer's disposal path (mark wrappers inert, restore global fetch only if still this extension's, keep delegation callable) runs exactly as the §10.2 requirements list demands; at most one active observer per runtime.
- **Deduplication**: chat requests will hit both the parsed-stream hooks and the fetch observer; the observer must yield to the hooks for foreground chat (or the extension must count each owned request exactly once) per the §10.2 double-counting requirement.

## Resolution (S5 implementation)

The S5 slice implements the decision above. Concretely:

- **Chat (hooks are the source of truth).** `before_provider_request` + `provider_stream_event` own all ordinary chat statistics, exactly as in the S4 baseline.
- **Summary (scoped fetch observer).** A single `installFetchObserver` (in `src/fetch-observer.ts`) wraps `globalThis.fetch` once per runtime (installed on `session_start` in TUI mode). For an eligible summary request it enriches the body (adds `stream_options.include_usage`; never injects `return_progress` — summary bodies must not gain provider-specific prefill fields, SPEC 6.3/12.2) and observes the SSE response in a single pass, forwarding bytes, status, headers, streaming, backpressure, errors, and cancellation unchanged.
- **Foreground attribution by phase.** `src/index.ts` tracks a `phase` (`"chat" | "compaction" | "branch"`) driven by Pi lifecycle events:
  - `session_before_compact` → `compaction`;
  - `session_before_tree` with `preparation.userWantsSummary` → `branch` (tree navigation **without** a summary request stays `chat` and shows nothing);
  - `session_compact`, `session_compact_failed`, `session_tree`, and `before_provider_request` → back to `chat` (settlement and chat-start), finalizing/clearing any summary UI.
  The observer's `classify` returns an attribution only when `phase` is `compaction` or `branch`, the request is a POST to `/chat/completions`, the body has a model string, and the request's **actual** backend (endpoint + model) is a verified owned openai-completions candidate via the identity/discovery modules — chat's eligibility proof is not reused. Because chat runs with `phase = "chat"`, the observer passes every chat request through untouched: **no double-counting**.
- **Reload/disposal.** `session_shutdown` disposes the observer (restore the global fetch only if it still points at this extension's wrapper; the wrapper stays inert and callable afterward), disposes the UI and discovery, and marks the state inert. `session_start` (TUI) re-arms with fresh state and a new observer — at most one active observer per runtime, no stacked wrappers across reloads.
- **UI (SPEC 8.1).** Chat prefill stays in the working message; summary prefill renders in an above-editor widget (key `pi-splash-stats`) because Pi's own compaction/branch status occupies the working message. Generation lines render in the widget for both chat and summary. The extension never touches Pi's own spinner text.
- **Evidence.** The S5h verification harness journeys `compact` and `tree` (plus `tree-negative`) and the chat regression journey exercise this end to end against a real, isolated Pi 1.5.2 against a loopback fake backend.

Applicable §10.2 observer requirements (all of them, since the observer is required):

- Pass unrelated requests directly to the previous fetch function, without consuming or replacing their bodies/responses.
- Support the input forms used by the supported Pi provider; test `string`, `URL`, and `Request` forms or pass unsupported forms through unchanged.
- Associate eligible requests with the current foreground operation; endpoint matching alone is not ownership.
- Preserve bytes, ordering, status, headers, streaming, backpressure, errors, and cancellation for observed responses.
- Observe a single pass without an unbounded cloned/teed response backlog.
- Parse SSE safely across byte boundaries, split UTF-8, LF/CRLF, comments, multiple data lines, and a final frame without trailing newline; ignore `[DONE]`, unknown events, and malformed statistics without losing data.
- Bound parser buffering (initially 1 MiB per pending SSE event); on overflow disable statistics for that request and keep forwarding.
- Propagate transport errors unchanged while releasing extension state; handle consumer cancellation without unhandled rejections or duplicate finalization.
- Install at most one active observer per runtime; avoid double-counting when parsed-stream hooks also fire.
- On disposal, mark captured wrappers inert; restore global fetch only if it still points at this extension's wrapper; keep delegation callable after disposal.

## Consequences

- Summary statistics come from the fetch observer; chat statistics may come from either source, with a single ownership rule per request.
- The observer is the largest attack/surface area in the extension; it must be covered by the offline unit and fake-transport tests in `test/` and by isolated real-Pi e2e evidence for chat, `/compact`, and `/tree`.
- If a future Pi baseline forwards hook options to summarization (removing the gap), the ADR should be revisited and the observer retired if hooks then provide sufficient coverage and request identity.

## Limitations

- Probed on the installed Pi 1.5.2 at the pinned path, with the `openai-completions` API (the Splash-relevant transport). Other provider transports (e.g. Codex WebSocket) were not probed; the static trace shows the hook-option gap is in the summarization path, common to all transports, but only `openai-completions` was demonstrated live.
- The `/tree` branch summary was triggered only in the TUI (no RPC tree-navigation command exists in 1.5.2); the PTY interaction (up-arrow selection, "Summarize" choice) is captured in `probe/evidence-tui/terminal.ansi` and `actions.jsonl`.
- `provider_stream_event` data for `openai-completions` is the raw chunk object (no `type` field); the probe logged its shape, not its content, by design.
- Manual `/compact` on a session smaller than `compaction.keepRecentTokens` (default 20k tokens) produces no provider request at all ("Nothing to compact (session too small)"); the RPC probe padded the session and set `keepRecentTokens: 200`.
