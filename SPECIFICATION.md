# Pi Splash Stats — feature specification

**Status:** Proposed; no implementation is included.  
**Package name:** `pi-splash-stats` (proposed; npm availability not checked).  
**Audience:** Implementers and reviewers of the Pi extension.  
**Purpose:** Define observable behavior, integration boundaries, and acceptance criteria.

“MUST”, “SHOULD”, and “MAY” describe requirements for the proposed extension, not claims about existing functionality.

## 1. Objective

Create a Pi extension, starting from `git@github.com:cltec/pi-extension-template.git`, that displays live prompt-processing and token-generation statistics when Pi invokes a model served by [Splash](https://github.com/incoai/splash).

The interaction follows [pi-llama-cpp-stats](https://www.npmjs.com/package/pi-llama-cpp-stats): transient prefill progress, throughput, and ETA; an above-editor widget when Pi owns the working spinner; and live generated-token counts. It is automatic and requires no per-session enable command.

For requests to any other model backend, the extension MUST remain invisible and MUST NOT modify inference requests.

Supported workflows include both `splash pi ...` and Pi launched directly with a configured Splash-served model, including servers on non-default ports. Activation depends on the backend serving the current request, never on how Pi was launched.

## 2. Verified upstream baseline

This proposal is grounded in the following inspected sources:

| Component | Inspected baseline | Relevant facts |
| --- | --- | --- |
| Template | Commit `affec8daf662ecd815a87639ab55545acdc38089` | TypeScript, thin Pi adapter, pure logic modules, offline tests, isolated real-Pi smoke tests, package allowlist, Apache-2.0 license. |
| Reference extension | npm `pi-llama-cpp-stats@0.1.11` | Prefill replaces the working message in chat; compaction and branch summaries use a widget; summary generation shows a live estimated token count. |
| Splash | Version reported by checkout: `1.7.0`; commit `61f6d51643a2cf8b3ed868dcb4bcda176ae578ec` | The launcher configures an OpenAI-compatible Pi provider; streaming requests support `return_progress`; streamed responses contain final `timings`. |
| Pi | `1.5.2`, the template baseline | Provides lifecycle events, working messages, widgets, provider request hooks, and raw parsed provider stream events. |
| Node.js | Template minimum `22.18.0` | Runtime TypeScript stripping for development tests; template CI targets Node 22 and 24. |

Source inspection establishes protocol feasibility, not runtime compatibility testing. An oldest supported Splash version has not been established; initially qualify the inspected version and use capability-based failure behavior for others.

### 2.1 Existing Splash launcher behavior

Splash's `install/clients.py` currently:

- Writes its provider to Pi's `models.json`, preserving other providers.
- Names the provider `splash` on its default port and `splash-<port>` on other ports.
- Configures `api: "openai-completions"` and a base URL ending in `/v1`.
- Launches Pi with `--provider <provider> --model <served-model-id>`, followed by forwarded user arguments.
- Uses Pi's normal agent directory, or `PI_CODING_AGENT_DIR` when set.
- Does **not** set a dedicated variable saying “this Pi process was launched through Splash.”

`SPLASH_API_KEY` is an optional credential, not a launch marker. Neither its presence nor absence proves which backend the current request uses.

### 2.2 Existing reference behavior versus this proposal

The reference extension does not display a normal-chat generation-speed dashboard. It restores Pi's working message after chat prefill and displays generated-token counts specifically during summarization.

This specification preserves its prefill layout and summary-widget behavior, and explicitly extends generation feedback to normal Splash chat. Estimated generation counts are visibly marked as approximate. These are intentional adaptations to the request for both prompt-processing and generation statistics, not claims of exact feature parity.

## 3. Activation contract

### 3.1 Confirmed requirement: current backend, not process ancestry

The authoritative rule is:

> A request is eligible only when its actual destination and requested model have been identified as Splash. Launching through Splash is the normal way to establish that configuration, not a permanent session-wide activation switch.

Consequences:

| Situation | Required behavior |
| --- | --- |
| `splash pi ...` selects its running Splash model | Display stats for that model's requests. |
| `splash pi ...`, then user switches to a cloud model | Clear stats immediately; subsequent cloud requests remain untouched. |
| User switches back to Splash | Revalidate as necessary and resume stats. |
| Ordinary `pi` uses a non-Splash model | Nothing from this extension is displayed. |
| Ordinary `pi` selects a previously configured, verified Splash model | Display stats, exactly as when launched through Splash. |
| Pi uses a manually configured Splash endpoint under an arbitrary provider name | Identify the endpoint and display stats for verified Splash requests. |
| Provider is named `splash`, but points to another backend | Do not activate solely because of its name. |
| Another backend serves the same model ID | Do not activate solely because of the model ID. |
| llama.cpp returns compatible `prompt_progress` or `timings` | Those fields alone MUST NOT activate this extension. |

**Decision D1 — confirmed by the requester:** Support any launch method that uses a Splash-served model within the supported protocol scope. Both `splash pi ...` and directly launched Pi MUST work. No launcher handshake, launch marker, parent-process inspection, or particular provider name is required. Optional credentials and persisted provider names MUST NOT determine activation.

### 3.2 Eligibility versus visibility

“Eligible” means the extension may request and consume statistics for a verified Splash request. It does not mean an idle badge is shown.

- No active request: no extension UI.
- Eligible request with no valid statistics yet: Pi's default UI remains unchanged.
- Eligible request with valid prefill or generation evidence: render the applicable transient display.
- Ineligible, unverified, unsupported, or failed discovery: no extension display.

## 4. Scope

### Included

1. OpenAI-compatible streaming chat completions to Splash, whether configured by Splash's launcher or manually in Pi.
2. Live prefill progress, percentage, estimated remaining time, and prompt throughput.
3. Live generated-token count, followed by exact count and authoritative rates when supplied.
4. Ordinary chat, tool-follow-up turns, manual/automatic compaction, overflow-recovery compaction, and `/tree` branch summarization.
5. Dynamic model changes, multiple Splash ports, cancellation, failures, session replacement, and `/reload`.
6. Checkout and packed-package loading through Pi's package manifest.
7. Silent behavior outside the interactive terminal UI.

### Excluded

- Starting, stopping, installing, or configuring Splash or Pi providers.
- Reimplementing Splash's model/provider integration.
- GPU utilization, temperatures, memory dashboards, server-wide metrics, billing, or historical charts.
- Persisting statistics in the conversation or session files.
- New tools, slash commands, shortcuts, or model-visible instructions.
- Responses API, Anthropic Messages, text completions, non-streaming inference, and UNIX-socket transport in the initial release.
- Arbitrary virtual-provider routing or concurrent extension-owned model calls unless the actual endpoint and request ownership can be established.
- Exact live tokenization of partial text; no tokenizer dependency or extra inference calls.

## 5. Splash identification

### 5.1 Discovery candidates

Automatic discovery MUST consider the currently selected configured `openai-completions` model when it has a valid HTTP(S) base URL, regardless of provider name, hostname, port, or Pi launch method. Apply the same rule to an attributable foreground summarization request that uses another configured model.

Manually configured local or remote Splash endpoints MUST NOT require a provider name such as `splash` or `splash-<port>`. Those names are launcher conventions, not eligibility requirements or identity evidence.

Discovery is limited to the configured endpoint about to be used. Do not scan hosts or ports, enumerate/probe every configured provider, or probe unselected models speculatively. A selected non-Splash OpenAI-compatible endpoint may receive the bounded identity request, but its inference request and UI MUST remain unchanged.

Do not treat loopback addresses, hostnames containing “splash”, or a default port as proof of backend identity.

### 5.2 Positive identification

For a candidate base URL, request `GET <configured-base>/models`, normally `/v1/models`, using the authentication Pi resolves for that same provider.

A model is verified only if the response is successful JSON with an OpenAI-style `data` array containing an object whose:

- `id` exactly matches the model ID sent in the inference payload; and
- `owned_by` is exactly `"splash"`.

Splash currently emits this ownership marker for its advertised model names and aliases. A similarly shaped list without that marker is not sufficient. Provider names, ports, model names, timing fields, and HTTP server headers alone are not sufficient.

This is capability identification within the user's trusted provider configuration, not cryptographic server attestation. A server that deliberately impersonates Splash can copy its public protocol.

### 5.3 Discovery lifecycle and bounds

- Start discovery at `session_start` and `model_select`, never as background work in the extension factory.
- Deduplicate in-flight discovery for the same endpoint and authentication context.
- Use a total deadline of 2 seconds per discovery attempt, including credential resolution where cancellation is available.
- If an eligible inference request arrives while initial discovery is pending, it MAY wait for the remainder of that deadline. An already verified request MUST NOT incur a new discovery wait.
- On discovery failure, send the original inference request unchanged. Do not retry the inference request to obtain statistics.
- Successful identity results expire after 60 seconds. Refresh at request boundaries or model selection; no periodic polling.
- Cache negative or transient failures for at most 5 seconds to avoid probe storms while allowing recovery.
- Key caches by canonical endpoint and a non-secret authentication-context identity. Invalidate on relevant configuration/authentication changes. Never store raw secrets as cache keys or diagnostics.
- Invalidate relevant results on endpoint errors indicating stale configuration or authentication failure. Session replacement and reload discard all results.
- Late discovery results MUST NOT reactivate an old selection or a disposed session.

The first prefill should be visible when a reachable, compatible Splash server completes identification before the inference request. If identity cannot be established within the bound, missing statistics are preferable to modifying an unknown provider.

### 5.4 URL and credential safety

- Preserve configured path prefixes, explicit ports, IPv6 syntax, and provider headers.
- Normalize only semantically insignificant URL differences, such as a trailing slash. Never collapse distinct path prefixes into one endpoint identity.
- Construct discovery URLs only under the configured base path; never guess ports or scan hosts.
- Disable redirects for credential-bearing discovery requests; do not forward credentials to another origin or path via redirects.
- Resolve credentials through Pi's provider/authentication interface. Do not execute configuration commands or parse credential files independently.
- Use the same provider authentication and appropriate configured headers; do not forward unrelated provider credentials or inference-specific payload headers.
- Never log API keys, authorization headers, prompts, model output, tool arguments, or raw provider chunks.

## 6. Inference request contract

Only a verified, owned streaming request to the exact configured chat-completions endpoint may be enriched.

The extension MUST:

1. Match the actual request endpoint, method, model ID, session ownership, and supported transport.
2. Preserve the original request when any of those cannot be established.
3. For an eligible streaming JSON request, set `return_progress: true`.
4. Set `stream_options.include_usage: true`, preserving other `stream_options` properties.
5. Leave all other payload fields, headers, tools, prompts, sampling parameters, and cancellation behavior unchanged.
6. Avoid mutating caller-owned payload objects in place when a replacement is possible.
7. Leave non-streaming and non-Splash requests unchanged, including when their payloads contain similarly named fields.

Malformed/unreadable bodies, unsupported request representations, absent bodies, and unexpected payload shapes MUST pass through unchanged, without consuming a body that Pi still needs.

The extension MUST NOT make a second completion call, request `/metrics` or `/status` for progress, or use aggregate server counters as per-request statistics.

## 7. Statistics and calculations

### 7.1 Input fields

| Source field | Interpretation |
| --- | --- |
| `prompt_progress.total` | Full prompt-token count. |
| `prompt_progress.cache` | Initially cached prompt-token count. |
| `prompt_progress.processed` | Completed prompt tokens, including the cached prefix. |
| `prompt_progress.time_ms` | Elapsed milliseconds since prefill admission; not queue or prompt-preparation duration. |
| `choices[0].delta.content` | Streamed visible text, when a string. |
| `choices[0].delta.reasoning_content` | Streamed reasoning text, when a string. |
| `choices[0].delta.tool_calls` | Tool-call deltas; generated output, but not necessarily one token per chunk. |
| `usage.completion_tokens` | Exact output-token count, including reasoning as reported by Splash. |
| `timings.predicted_n` | Exact final output-token count, available in Splash's finish-reason chunk. |
| `timings.prompt_per_second` | Authoritative final prompt rate, using uncached tokens. |
| `timings.predicted_per_second` | Authoritative final generation rate, excluding the first emission's tokens. |
| `timings.prompt_ms`, `predicted_ms` | Native-start-to-first-emission and first-emission-to-completion elapsed intervals. |
| `timings.prompt_n`, `cache_n` | Full and cached prompt counts; useful for consistency checks. |

Validate numeric values: finite, non-negative, with integral token counts. Reject malformed values rather than coercing strings. Ignore unrecognized additional properties for forward compatibility.

### 7.2 Cache-aware prefill progress

For a valid update, let:

```text
T = total
C = cache
P = processed
work = max(0, T - C)
done = clamp(P - C, 0, work)
percent = work > 0 ? 100 * done / work : 100
```

Use Splash's explicit `cache` field instead of assuming the first received `processed` value is the entire cached prefix. The first update may already include completed uncached work.

- Validate `0 <= C <= P <= T`.
- For a legacy update missing `cache`, use the first valid `processed` value as a conservative baseline for that request. Do not infer cached tokens from another request.
- Percentages MUST remain in `[0, 100]` and SHOULD not regress within one valid request.
- Ignore isolated regressing counters/timestamps. If totals or baseline change incompatibly, omit misleading rate/ETA rather than inventing continuity.
- A fully cached or zero-work prompt MUST not trigger division by zero or an invented throughput.

### 7.3 Prefill throughput and ETA

For two valid increasing samples:

```text
rate_tok_s = (done_now - done_previous) * 1000 / (time_ms_now - time_ms_previous)
```

Before two usable samples exist, a cumulative estimate MAY use `done * 1000 / time_ms` when both are positive.

Maintain at most 20 valid rate samples. Calculate ETA from remaining uncached work divided by the arithmetic mean of those positive rates; use the cumulative rate as fallback. This bounded smoothing is deliberately simpler than the reference extension's rate-curve regression. Exact numerical equivalence of ETA is not required.

Suppress unavailable/non-finite rates and ETAs. Do not display zero seconds as a fabricated prediction while work remains. Queue time and network latency MUST NOT be presented as native prefill throughput.

### 7.4 Generation counts

Output proves generation has begun even if no complete prefill update was received. Empty role announcements and keepalives do not count as generated text.

Until final exact counts arrive, an implementation SHOULD follow the reference's lightweight estimate:

```text
estimated_tokens = max(nonempty_output_chunks, round(output_characters / 6))
```

Count text and reasoning. Count each chunk once even if it contains multiple output fields. Tool argument fragments MAY be included as text in the estimate, but must not be retained or displayed. Role-only, empty, and keepalive chunks MUST NOT increase the count.

Display the estimate with `≈`; it is not exact tokenization and no fixed accuracy is promised, particularly for code, tools, non-English text, or speculative decoding.

Replace the estimate with `usage.completion_tokens` when available; otherwise use `timings.predicted_n`. Exact authoritative counts MAY correct the displayed count downward. If both exact fields disagree, prefer usage and do not attempt to repair Pi's accounting.

### 7.5 Generation throughput and final timings

Splash's inspected stream does not expose an exact cumulative token count on every output chunk. The extension MUST NOT label chunk counts or character-based rates as exact generation throughput.

- Show a live approximate count followed, when available, by a parenthesized approximate generation rate: `Generating... ≈123 tok (≈45.6 tok/s)`. Positive rates use one decimal place. Drop the rate when terminal width is insufficient.
- Estimate per request using a monotonic clock. The first nonempty output batch establishes both the time and estimated-token baseline; exclude time-to-first-output and that entire batch from the rate. Use `(current estimated tokens - baseline estimated tokens) / elapsed seconds` after at least 500 ms and a later nonempty output batch. Use the §7.4 estimator for text, reasoning, and tool-argument fragments, not one token per chunk.
- Use the cumulative window since that baseline, without additional smoothing; pauses between observations are included. Recompute on stream observations, not an idle timer. Very short responses, nonpositive deltas, invalid clocks, or nonfinite rates remain count-only. Character-based tokenization and burst delivery make this indicative, not a backend measurement.
- Count and rate approximation markers are independent. Valid final counts replace estimated counts; valid authoritative rates replace estimated rates. At finalization, do not fall back to the live estimated rate when authoritative throughput is unavailable.
- When valid final timings arrive, use `timings.predicted_per_second` for generation throughput and `prompt_per_second` for prompt throughput.
- Do not recompute authoritative rates as full count divided by duration: Splash excludes cached prompt tokens and the entire first speculative emission respectively.
- A zero final rate means unavailable, including a response completed in one emission. Omit the rate rather than displaying it as measured zero-speed generation.
- Final rates MAY appear in the active transient generation line before normal cleanup. No persistent post-response report or minimum display delay is required in this release.

## 8. UI contract

### 8.1 Placement

Use Pi's UI API, not direct terminal writes or replacement of the entire footer.

| Phase | Prefill display | Generation display |
| --- | --- | --- |
| Normal chat / tool-follow-up | `ctx.ui.setWorkingMessage(...)` | Above-editor widget keyed `pi-splash-stats`. |
| Manual/automatic/recovery compaction | Above-editor widget keyed `pi-splash-stats`; leave Pi's compaction spinner intact | Same widget switches to generation count. |
| `/tree` summary | Above-editor widget; leave Pi's summary spinner intact | Same widget switches to generation count. |

The normal-chat generation widget is the intentional extension beyond reference behavior. It ensures generation feedback remains visible after Pi stops showing its working loader.

No extension badge, footer entry, notification, blank widget, or reserved line is shown while idle or using a non-Splash model.

### 8.2 Formatting

Illustrative displays, not measured examples:

```text
Prefilling... ████████░░░░░░░░░░░░  40% · 30s · 1234.5 tok/s
Generating... ≈1.2k tok
Generating... ≈1.2k tok (≈45.6 tok/s)
Generating... 1.2k tok · 82.4 tok/s
```

- Use a 20-cell filled/empty bar and a rounded integer percentage.
- Format positive rates to one decimal place with `tok/s`.
- Format ETA as rounded seconds below one minute; otherwise minutes and seconds, normalizing second overflow.
- Format counts below 1,000 as integers, below 10,000 with one decimal `k`, and larger counts as rounded `k`, following the reference's compact style.
- Missing rate or ETA removes that segment and its separator; never show `NaN`, `Infinity`, or an unexplained placeholder.
- A valid but incomplete prefill report may show `Prefilling...` without a percentage. Invalid numeric reports do not overwrite a valid display.
- Keep one transient line per phase. Adapt to narrow terminals without wrapping into a dashboard; drop ETA and then shorten the bar if necessary, retaining the phase and primary count/percentage.
- Do not introduce fixed theme colors that clash with Pi themes.

### 8.3 Transitions and cleanup

- Restore the default working message when prefill completes or generation output begins.
- Never leave a 100% prefill bar visible throughout generation.
- Clear the widget on request completion, cancellation, error, model switch, session replacement, or shutdown.
- Between tool-loop requests, reset all per-request counts and rates; never accumulate across unrelated completions.
- If Pi starts another request immediately, hand ownership to that request without allowing old chunks to redraw the previous state.
- A non-Splash request MUST NOT cause the extension to reset another extension's working message. Restore the working message only when this extension actually overrode it.
- Clear only the extension's namespaced widget; do not remove other extensions' widgets.

### 8.4 Non-TUI modes

The initial feature targets `ctx.mode === "tui"`. `ctx.hasUI` alone is insufficient because RPC also reports UI availability.

For RPC, print, and JSON modes, the extension MUST produce no stats messages, terminal output, notifications, transcript entries, or protocol additions. It SHOULD skip discovery and statistics-specific request enrichment entirely in those modes. Ordinary Pi output remains unchanged.

## 9. Lifecycle and ownership

Keep state inside one extension runtime, divided into endpoint discovery state, current selection, operation phase, and per-request statistics.

Each owned request MUST have a unique internal ID and capture:

- Runtime/session generation ID.
- Actual normalized endpoint and requested model ID.
- Phase: `chat`, `compaction`, or `branch`.
- Selection generation at request start.
- Validated progress and bounded rate history.
- Approximate counters and any exact final counts/timings.
- Cancellation/completion state and whether it owns any UI overrides.

Lifecycle requirements:

| Event or boundary | Required action |
| --- | --- |
| `session_start` | Initialize state; inspect current model even if no model-selection event fired; begin candidate discovery in TUI mode. |
| `model_select` | Increment selection generation, clear owned UI, invalidate stale work, discover new candidate. |
| Actual supported request start | Identify request and decide eligibility; reset request-local metrics. |
| `session_before_compact` | Establish compaction phase, but show nothing until an eligible request provides data. |
| `session_compact` / `session_compact_failed` | Clear compaction UI and return to chat phase. |
| `session_before_tree` | Enter branch phase only when a summary was requested. |
| `session_tree` | Clear branch UI and return to chat phase. |
| Stream success, failure, or cancellation | Finalize exactly once and release UI ownership promptly. |
| `turn_end` / `agent_settled` | Safety-net cleanup, without clearing a newer active request. |
| `session_shutdown` | Cancel extension probes, dispose interception, clear UI, release references, reject late updates. |
| `/reload` | Dispose old runtime; load one new runtime without stacked wrappers or handlers. |

A summary request MUST be evaluated against the backend it actually uses. Do not assume that chat eligibility automatically proves a different summarization model is Splash.

Do not combine concurrent streams into a single token count. One foreground request owns the display. If concurrent requests cannot be unambiguously attributed, suppress their statistics rather than display mixed data. Background calls, cache warming, and unrelated extension-owned calls MUST NOT take over the foreground display.

## 10. Integration design constraints

### 10.1 Template adaptation

The implementation MUST begin from the inspected template or a deliberately recorded newer template commit. Keep its thin-adapter/pure-logic structure; no additional architecture framework is required.

Suggested module responsibilities, with filenames adaptable during implementation:

| Path | Responsibility |
| --- | --- |
| `src/index.ts` | Pi event registration, dependency wiring, session lifecycle. |
| `src/identity.ts` | Pure URL normalization, candidate rules, identity-response validation. |
| `src/discovery.ts` | Bounded authenticated discovery and session-local cache. |
| `src/progress.ts` | Pure progress validation, phase reducer, count/rate/ETA calculations. |
| `src/format.ts` | Pure compact-line formatting. |
| `src/transport.ts` | Request eligibility, enrichment, transparent observation, cancellation. |
| `src/ui.ts` | Working-message/widget ownership and deduplicated rendering. |
| `test/` | Offline pure-logic and fake-Pi/transport tests. |
| `e2e/` | Isolated real-Pi loading and protocol integration tests. |

Remove `/hello`, `template-greeting`, and greeting example code/assertions. Do not retain a greeting as a startup side effect.

Keep host packages as peer dependencies. Prefer Node/Web platform APIs and zero added runtime dependencies. Preserve the template's Apache-2.0 `LICENSE` unchanged. The reference package contains no license file or license metadata in its inspected archive; behavioral inspiration does not authorize copying its implementation. Independently implement the feature unless reuse permission is established.

### 10.2 Provider hooks and transport coverage

Prefer supported Pi request and parsed-stream hooks where they provide sufficient coverage and request identity. Do not assume a hook runs for every internal model call.

In the inspected Pi baseline, ordinary agent calls expose `before_provider_request` and `provider_stream_event`. Summarization uses its own request options through the stream function; hook delivery for summaries must be demonstrated, not inferred from chat behavior. The reference extension intercepts fetch partly to observe these internal requests.

If a scoped fetch observer is required to cover compaction/branch summaries, it MUST:

- Pass unrelated requests directly to the previous fetch function, without consuming or replacing their bodies/responses.
- Support the input forms actually used by the supported Pi provider; test `string`, `URL`, and `Request` forms or explicitly pass unsupported forms through unchanged.
- Associate eligible requests with the current foreground operation; matching an endpoint alone is not sufficient for ownership.
- Preserve bytes, ordering, status, headers, streaming, backpressure, errors, and cancellation for observed responses.
- Observe a single pass without an unbounded cloned/teed response backlog.
- Parse SSE safely across arbitrary byte boundaries, split UTF-8 characters, LF/CRLF, comments, multiple data lines, and a final frame without a trailing newline.
- Ignore `[DONE]`, unknown events, and malformed statistics without losing actual response data.
- Bound parser buffering, initially to 1 MiB per pending SSE event. On overflow, disable statistics for that request and continue forwarding the original stream.
- Propagate underlying transport errors to Pi unchanged while releasing extension state.
- Handle consumer cancellation without unhandled promise rejections or duplicate finalization.
- Install at most one active observer per runtime and avoid double-counting when parsed-stream hooks also fire.
- On disposal, mark captured wrappers inert. Restore global fetch only if it still points to this extension's wrapper; never overwrite a wrapper installed later by another extension.
- Keep delegation callable after disposal, since SDK clients may retain an old fetch reference.

The transport choice MUST be recorded in an ADR with evidence for chat, compaction, branch summaries, foreground attribution, and reload behavior. If the supported public API cannot provide required coverage, that is an implementation blocker to resolve explicitly, not permission to silently omit summary support.

### 10.3 Performance and resources

- No polling timers, filesystem watchers, subprocesses, or new server.
- No retained prompt/output text after a chunk has been counted.
- At most 20 rate samples per owned request and bounded parser/discovery buffers; bound discovery response JSON to 1 MiB.
- Deduplicate identical rendered lines. Coalesce updates to at most 10 per second; phase changes and cleanup may render immediately.
- Cancel any render timer on completion or disposal; no event-loop handle may survive shutdown.
- Statistics processing must not intentionally delay delivery of model tokens. UI/render failures disable the affected display, not inference.

## 11. Failure behavior

| Condition | Required result |
| --- | --- |
| Discovery timeout, DNS failure, malformed JSON, 401/403/404/5xx | Remain silent; original inference request proceeds unchanged. |
| Valid models list but requested model absent or not owned by Splash | Inactive for that model. |
| Valid Splash identity but no progress events | No invented prefill bar; generation may still display when real output arrives. |
| Server rejects `return_progress` | Let Pi report the real server error; no automatic duplicate generation. Document capability requirements and remain recoverable after reload/upgrade. |
| Final usage missing | Use valid `timings.predicted_n` if available; otherwise keep approximate count until cleanup. |
| Timings missing or zero/unavailable rate | Omit the rate; do not estimate an exact substitute. |
| Malformed/unknown progress data | Ignore safely; preserve stream behavior. |
| Esc during prefill or generation | Honor Pi cancellation; clear UI and resources; no unhandled rejection. |
| Abrupt stream termination | Clear display; preserve Pi's normal error handling. |
| Model/session changes during an in-flight probe or stream | Late callbacks cannot recreate stale UI. |
| Another extension changes fetch or uses widgets | Preserve its wrapper and widget state. |
| Terminal UI API throws | Stop affected stats display; do not fail the model request. |

No startup success/failure toast, repeated warning, console log, or assistant message is allowed as a fallback. Operational limitations belong in documentation, not unsolicited conversation content.

## 12. Verification requirements

### 12.1 Offline unit tests

Use `node:test` and deterministic fixtures/fake clocks. No external services or live model credentials.

Required cases:

1. Candidate selection: default/non-default Splash providers, arbitrary local/remote provider names, IPv4/IPv6 endpoints, directly launched Pi, unsupported APIs, invalid URLs, and no speculative probes of unselected models.
2. URL normalization: trailing slash, prefixed `/v1`, different ports, query handling, and distinct mounts.
3. Identity: matching/non-matching IDs, aliases, exact `owned_by`, non-objects, malformed lists, oversized bodies, and timing fields that do not establish identity.
4. Cached/uncached/fully cached/zero-work progress; first event after actual work has started; missing cache fallback.
5. Duplicate, regressing, negative, non-finite, fractional-token, and inconsistent-total samples.
6. Rate and ETA fallback/smoothing, absent values, rounding, duration carry, token-count boundaries, and narrow displays.
7. Text/reasoning/tool fragment estimates; keepalives and role-only chunks; exact count replacement; conflicting exact counts.
8. Authoritative final rates, zero-rate suppression, and speculative first-emission semantics.
9. Request-local resets and stale runtime/selection/request IDs.
10. Render deduplication and coalescing with immediate cleanup.

### 12.2 Wiring and transport tests

Use fake Pi contexts, in-memory streams, and injected fetch/auth functions; `npm test` MUST NOT launch Pi or use network.

Assert:

- No tools, commands, transcript messages, or startup notifications are registered/emitted.
- Correct phase and UI placement, using mode rather than `hasUI` alone.
- No discovery/enrichment/UI in non-TUI modes.
- Non-Splash payloads and response objects pass through untouched.
- Only verified model/endpoint combinations receive enrichment; nested stream options survive.
- Discovery deadlines, deduplication, cache expiry, credential isolation, redirect refusal, and cancellation.
- First supported request can obtain progress after successful discovery.
- Concurrent/late streams cannot mix counts or steal display ownership.
- Every success/error/abort path finalizes once and clears only owned UI.
- Reload does not stack observers; a retained old wrapper remains callable but inactive.
- If SSE observation is used: split UTF-8/JSON/SSE frames, comments, CRLF, multiline data, malformed frames, missing final newline, oversized event fallback, backpressure, cancellation, and byte-for-byte output preservation.

### 12.3 Isolated real-Pi tests

Preserve the template's temporary home/config/working directory, explicit environment allowlist, bounded shutdown, sanitized artifacts, and packed-archive tests.

- Keep existing no-provider-call RPC/JSON/package-load smoke scenarios, adapting assertions to a silent stats extension.
- Add a separate local fake OpenAI/Splash server scenario for real-Pi transport behavior. This deliberately expands the template's E2E boundary and MUST be documented. The server must require no credentials from the real environment and must be bound to loopback and disposed after the test.
- Test raw progress/timing delivery, an actual non-Splash response, model switching, abort, compaction, branch summarization, and reload where the harness supports those operations.
- RPC/JSON tests do not prove terminal layout. Add a PTY/TUI scenario or perform the explicit manual TUI checks below.
- Ensure packed source modules are exercised, not just checkout files.
- No public API, external model, npm registry, or real home-directory dependency during test execution.

### 12.4 Manual qualification with real Splash

On a supported Apple Silicon macOS machine with the inspected Splash/Pi versions and the extension installed:

1. Launch through `splash pi ...`; send a sufficiently long cold prompt and confirm prefill progress.
2. Send a follow-up with a cached prefix; confirm progress/rates measure uncached work.
3. Confirm generation count is approximate until exact final data; no persistent widget remains afterward.
4. Test a non-default Splash port using the launcher syntax supported by that Splash version.
5. Switch to a non-Splash model, then back; confirm silence and reactivation respectively.
6. Trigger manual/automatic compaction and a `/tree` branch summary; confirm spinner preservation, widget transitions, and cleanup.
7. Abort during both phases; test server disconnect and `/reload`.
8. Launch ordinary Pi with a non-Splash model; confirm no extension UI or request changes.
9. Launch ordinary Pi with the saved Splash provider; confirm the same activation and statistics as through `splash pi`.
10. Configure Splash manually under an arbitrary provider name; confirm identity-based activation without launcher metadata. Include a remote HTTP(S) endpoint when available, or record that scenario as unverified.

Record exact versions, OS, scenarios, and results. Linux fake-server CI does not establish real Splash/macOS compatibility.

## 13. Acceptance criteria

| ID | Acceptance criterion |
| --- | --- |
| AC-01 | Implementation derives from the template, retains its license, manifest, package allowlist, and test isolation. |
| AC-02 | With a reachable compatible server, `splash pi ...` automatically displays statistics without enabling a command. |
| AC-03 | First-request prefill works when bounded discovery completes successfully. |
| AC-04 | Uncached progress drives percentage/rate/ETA; cached tokens do not inflate throughput. |
| AC-05 | Chat, tool-follow-up, compaction, and branch-summary generation show transient counts and, after sufficient observations, a parenthesized approximate rate (§7.5); count/rate markers are independent, startup and narrow layouts remain count-only, and request-local timing excludes first-output latency/batch. |
| AC-06 | Valid exact final counts replace estimates; authoritative final rates are not recomputed using incorrect token totals. |
| AC-07 | A non-Splash model shows no extension UI, including when launched through Splash or sharing a model ID. |
| AC-08 | A llama.cpp endpoint's compatible timing fields do not activate this extension. |
| AC-09 | Switching away clears stats immediately; returning to Splash works without restarting Pi. |
| AC-10 | Non-default ports, served aliases, prefixed endpoints, and provider authentication remain correctly scoped. |
| AC-11 | Abort, stream errors, summary failures, reload, and shutdown leave no stale UI, handles, or unhandled rejections. |
| AC-12 | No prompts, model text, tools, provider credentials, sessions, or user configuration are persisted or altered by the extension. |
| AC-13 | RPC, print, and JSON modes remain silent and preserve ordinary Pi output. |
| AC-14 | Offline checks, package checks, isolated real-Pi smoke tests, and manual Splash/TUI qualification have recorded evidence before release. |
| AC-15 | Directly launched Pi and `splash pi` provide equivalent statistics for the same Splash-served model; arbitrary configured provider names do not prevent activation. |

## 14. Packaging and documentation deliverables

The implementation deliverable MUST include:

- Renamed package metadata and actual repository URLs; no invented npm publication claim.
- Pi manifest entry `./src/index.ts` and only required runtime source in the package allowlist.
- Updated README describing launch-independent automatic activation, direct-Pi and `splash pi` workflows, UI examples, approximate counts, mode behavior, requirements, and permissions.
- Updated architecture, testing, troubleshooting, security, and changelog documents.
- An ADR for identity/discovery and transport coverage, including why timing-field detection alone is unsafe here.
- Replacement feature tests and adapted smoke assertions; no greeting/template placeholders in shipped content.

Keep `private: true` and release publishing disabled until separately authorized. Do not tag, publish, add dependencies, or change the Pi/Node baseline implicitly.

Existing template verification commands to preserve:

```sh
npm test
npm run check:package
npm run check
npm run test:e2e
npm pack --dry-run
```

These are required future implementation checks, not tests run for this specification. The template has no configured build, lint, or typecheck command.

## 15. Source references

Repository links below are pinned to the inspected commits so later upstream changes do not silently change this proposal.

- [Template package and test configuration](https://github.com/cltec/pi-extension-template/tree/affec8daf662ecd815a87639ab55545acdc38089).
- [Template architecture](https://github.com/cltec/pi-extension-template/blob/affec8daf662ecd815a87639ab55545acdc38089/docs/ARCHITECTURE.md).
- [Template setup requirements](https://github.com/cltec/pi-extension-template/blob/affec8daf662ecd815a87639ab55545acdc38089/docs/TEMPLATE-SETUP.md).
- [Reference extension version](https://www.npmjs.com/package/pi-llama-cpp-stats/v/0.1.11); README and implementation inspected from its npm archive.
- [Splash Pi launcher](https://github.com/incoai/splash/blob/61f6d51643a2cf8b3ed868dcb4bcda176ae578ec/install/clients.py): `_Server.name`, `_pi`, `_write_pi_provider`.
- [Splash API specification](https://github.com/incoai/splash/blob/61f6d51643a2cf8b3ed868dcb4bcda176ae578ec/docs/api.md): progress, usage, and timing semantics.
- [Splash server and model ownership](https://github.com/incoai/splash/blob/61f6d51643a2cf8b3ed868dcb4bcda176ae578ec/server/server.py): `_models`, `_get_models`.
- [Splash streaming chat implementation](https://github.com/incoai/splash/blob/61f6d51643a2cf8b3ed868dcb4bcda176ae578ec/server/dialects/openai.py): progress, finish-reason timings, optional usage, and `[DONE]` ordering.
- [Splash timing implementation](https://github.com/incoai/splash/blob/61f6d51643a2cf8b3ed868dcb4bcda176ae578ec/server/metrics.py): `usage_dict`, `timings_dict`, `metrics_dict`.
- [Splash launcher documentation](https://github.com/incoai/splash/blob/61f6d51643a2cf8b3ed868dcb4bcda176ae578ec/docs/server.md#agent-launchers).

Pi API details were checked against the installed `@earendil-works/pi-coding-agent@1.5.2` extension documentation, extension types, SDK wiring, summarization code, and `debug-provider.ts` example. Web search/fetch was unavailable because the configured service returned HTTP 402; upstream repository checkouts and the npm registry archive were used directly instead.
