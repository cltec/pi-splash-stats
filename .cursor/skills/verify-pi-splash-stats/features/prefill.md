# Cache-aware prompt processing

While Splash processes a prompt, users see transient percentage, throughput and ETA for uncached
work. Pi's ordinary chat working message returns when generation starts.

## Sub-features

- `prefill-first`: first supported request displays progress without an enable command (AC-03).
- `prefill-cache`: cached tokens do not inflate percentage/rate/ETA (AC-04).
- `prefill-empty`: fully cached/zero-work/malformed samples never fabricate rates.
- `prefill-layout`: one theme-compatible line, 20-cell bar, narrow-terminal adaptation.

## How to get to it (user POV)

- Send a sufficiently long cold chat prompt to Splash.
- Send a conversation follow-up with a cached prefix.
- Trigger a tool follow-up or summary (separate mapped journeys; same calculations, different placement).

## Driving it with verify.py

Preconditions: skill baseline and compatible progress enrichment.

- **First request.** Run `"$V" run chat`. At the gated prefill snapshot, the fixture reports
  total=100, cache=20, processed=60 after increasing samples at 0/1000/2000 ms.
  Uncached done=40 of 80: require **50%**, **20.0 tok/s**; inspect the available ETA/bar too
  (ETA should represent 40/20=2 seconds, not full-token or wall-clock work).
  The helper asserts percentage/rate; ETA, bar cells and placement still require artifact review.
- **Follow-up/reset.** Run `"$V" run cached`. It sends a second genuine user prompt in the same
  conversation and checks fresh per-request samples; no accumulated percentage/count.
  Read both prefill and generation snapshots. This is not proof that Splash's real cache was warm.
- **Transition.** In each run, generation snapshot must contain no prefill display; idle snapshot
  must contain no stats or reserved stats line. Inspect `terminal.ansi` for wrapping/flicker.
- **Edge/narrow journeys.** Require deterministic offline tests for spec §7.2/7.3/8.2/12.1.
  Currently BLOCKED in this PTY seed: there are no fully cached, missing-cache, regressing,
  zero-work or narrow-width variants. Add fixture variants/terminal-size controls before claiming them.

## Gotchas

- The first received processed value may already include uncached work; explicit cache is authoritative.
- Keep server timing separate from queue/network time. The fixture's deliberate gates must not
  enter native rates/ETA.
- A final 100% frame need not stay visible. No-progress identity success must not invent a bar.
- Long cold prompts and real cached follow-ups remain part of real Splash qualification.
