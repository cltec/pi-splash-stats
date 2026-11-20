# Automatic backend activation and model switching

Users get statistics automatically for requests actually served by Splash, regardless of launcher,
provider name, port, or previously selected model. Other backends remain untouched and invisible.

## Sub-features

- `identity-first`: first directly launched request identifies Splash before enrichment (AC-03/15).
- `identity-negative`: llama.cpp ownership with identical model ID/timing fields stays silent (AC-07/08).
- `identity-switch`: switching away clears UI and switching back resumes (AC-09).
- `identity-routing`: non-default ports, prefixed mounts, aliases, remote endpoints and auth scope (AC-10).
- `identity-launcher`: real `splash pi` and saved/direct/manual providers behave equivalently (AC-02/15).

## How to get to it (user POV)

- Launch ordinary Pi with a configured Splash model, including an arbitrary provider name.
- Launch through Splash's Pi integration.
- Use `/model` (or Ctrl+L) to switch between Splash and another backend; then send a prompt.
- Select a saved Splash provider after previously using another model.

## Driving it with verify.py

Preconditions: skill baseline, real implemented extension; separate qualified Splash install for launcher entry.

- **Direct/arbitrary provider.** Run `"$V" run chat`. The selected `verify-local/verify-model`
  serves through `/splash/v1`; HTTP evidence must show bounded identity then enriched inference,
  prefill/generation and empty idle UI. No enabling slash command exists.
- **Deceptive provider/timings.** Run `"$V" run non-splash`. The provider named `splash` serves
  the same ID with `owned_by: "llama.cpp"`, yet emits compatible progress and timing fields.
  Phase snapshots remain silent; one real response completes; payload hash matches no-extension baseline.
- **Switch away/back.** Run `"$V" run switch`. The actual editor commands are
  `/model splash/verify-model`, then `/model verify-local/verify-model`.
  Capture selected/idle states and each next completion: visible → invisible → visible.
- **Real launcher/saved/manual/remote entry points.** Follow qualification §12.4 of the specification,
  record launcher syntax from the installed pinned Splash help, and run both launch methods against
  the same server/model. Currently BLOCKED: no Splash/model or real-launch driver is seeded.
  Do not invent server flags or treat the fixture as launcher proof.

## Gotchas

- Names, hostnames, optional SPLASH_API_KEY and compatible timings are not identity.
- Switching recipe currently switches **between** requests, not mid-probe/mid-stream.
  Those race journeys still need transport tests and an extended PTY drive.
- Fixture coverage includes prefixed paths, dummy auth, arbitrary names and a non-default port;
  it does not cover IPv6, redirects, credential changes, TTL expiry, aliases or failed discovery.
  Add deterministic fixtures/tests for those preconditions rather than extrapolating a pass.
- Cold first-request identification and exact body/header preservation need HTTP/wiring assertions
  alongside the UI; the map must track any newly supported actual transport entry points.
