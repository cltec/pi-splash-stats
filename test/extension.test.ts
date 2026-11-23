import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../src/index.ts";

const SPLASH_MODEL = {
  api: "openai-completions",
  baseUrl: "http://127.0.0.1:9443/splash/v1",
  id: "verify-model",
  provider: "verify-local",
};

const MODELS_OK = JSON.stringify({ object: "list", data: [{ id: "verify-model", object: "model", owned_by: "splash" }] });
const MODELS_NOT_SPLASH = JSON.stringify({ object: "list", data: [{ id: "verify-model", object: "model", owned_by: "llama.cpp" }] });

function modelsFetch(body: string) {
  const calls: { url: string; init: any }[] = [];
  const impl = async (url: string, init?: any) => {
    calls.push({ url, init });
    const bytes = new TextEncoder().encode(body);
    return {
      ok: true,
      status: 200,
      headers: { get: (name: string) => (name.toLowerCase() === "content-length" ? String(bytes.byteLength) : null) },
      arrayBuffer: async () => bytes.buffer as ArrayBuffer,
    };
  };
  return { calls, impl };
}

function makePi() {
  const handlers = new Map<string, Function[]>();
  const commands: string[] = [];
  const tools: string[] = [];
  const api = {
    registerCommand(name: string) {
      commands.push(name);
    },
    registerTool(name: string) {
      tools.push(name);
    },
    on(event: string, handler: Function) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event)!.push(handler);
    },
    sendMessage() {
      throw new Error("extension must not send messages");
    },
  };
  return {
    api: api as unknown as ExtensionAPI,
    commands,
    tools,
    events: () => [...handlers.keys()].sort(),
    emit: async (event: string, e: unknown, ctx: unknown) => {
      const list = handlers.get(event) ?? [];
      let result: unknown;
      for (const handler of list) result = await handler(e, ctx);
      return result;
    },
  };
}

function makeCtx(mode: string, model?: object) {
  const uiCalls: unknown[][] = [];
  const widgets: { render(width: number): string[]; invalidate(): void }[] = [];
  const ctx = {
    mode,
    model,
    sessionManager: {},
    ui: {
      setWorkingMessage(message?: string) {
        uiCalls.push(["working", message]);
      },
      setWidget(key: string, content?: string[] | (() => { render(width: number): string[]; invalidate(): void })) {
        if (typeof content === "function") {
          const component = content();
          widgets.push(component);
          uiCalls.push(["widget", key, component.render(120)]);
        } else {
          uiCalls.push(["widget", key, content]);
        }
      },
    },
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
    },
  };
  return { ctx, uiCalls, widgets };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("live rate uses request-local monotonic output clock and final rates stay authoritative", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = modelsFetch(MODELS_OK).impl as typeof fetch;
  const pi = makePi();
  const { ctx, uiCalls, widgets } = makeCtx("tui", SPLASH_MODEL);
  let now = 90000;
  extension(pi.api, () => now);
  try {
    await pi.emit("session_start", {}, ctx);
    for (let request = 0; request < 2; request++) {
      await pi.emit("before_provider_request", { payload: { model: "verify-model", messages: [], stream: true } }, ctx);
      const stream = { provider: "verify-local", api: "openai-completions", model: "verify-model" };
      uiCalls.length = 0;
      await pi.emit("provider_stream_event", { ...stream, data: { choices: [{ delta: { content: "xxxxxx" } }] } }, ctx);
      assert.doesNotMatch(JSON.stringify(uiCalls), /tok\/s/);
      now += 500;
      await pi.emit("provider_stream_event", { ...stream, data: { choices: [{ delta: { tool_calls: [{ function: { arguments: "xxxxxx" } }] } }] } }, ctx);
      // Finalization flushes the coalesced live update before replacing it.
      await new Promise(resolve => setTimeout(resolve, 110));
      const liveWidget = widgets.at(-1)!;
      assert.match(liveWidget.render(120)[0], /tok\/s/);
      assert.doesNotMatch(liveWidget.render(22)[0], /tok\/s/);
      liveWidget.invalidate(); // Same component after resize, without another stream event.
      assert.match(liveWidget.render(120)[0], /tok\/s/);
      assert.doesNotMatch(liveWidget.render(22)[0], /tok\/s/);
      await pi.emit("provider_stream_event", { ...stream, data: { choices: [{ finish_reason: "stop" }], usage: { completion_tokens: 7 }, timings: { predicted_per_second: 12 } } }, ctx);
      assert.match(JSON.stringify(uiCalls), /7 tok.*12\.0 tok\/s/);
      const finalWidget = widgets.at(-1)!;
      assert.match(finalWidget.render(120)[0], /12\.0 tok\/s/);
      assert.doesNotMatch(finalWidget.render(22)[0], /tok\/s/);
      finalWidget.invalidate();
      assert.match(finalWidget.render(120)[0], /12\.0 tok\/s/);
      now += 10000;
    }
  } finally {
    await pi.emit("session_shutdown", {}, ctx);
    globalThis.fetch = original;
  }
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 130));

test("registers no commands, tools, or messages; only the expected event listeners", () => {
  const pi = makePi();
  extension(pi.api);
  assert.deepEqual(pi.commands, []);
  assert.deepEqual(pi.tools, []);
  assert.deepEqual(pi.events(), [
    "agent_settled",
    "before_provider_request",
    "model_select",
    "provider_stream_event",
    "session_before_compact",
    "session_before_tree",
    "session_compact",
    "session_compact_failed",
    "session_shutdown",
    "session_start",
    "session_tree",
    "turn_end",
  ]);
});

test("non-TUI modes: no discovery, no enrichment, no UI (SPEC 8.4)", async () => {
  const fetch = modelsFetch(MODELS_OK);
  const realFetch = globalThis.fetch;
  globalThis.fetch = fetch.impl;
  try {
    for (const mode of ["rpc", "print", "json"]) {
      const pi = makePi();
      extension(pi.api);
      const { ctx, uiCalls } = makeCtx(mode, { ...SPLASH_MODEL });
      await pi.emit("session_start", { reason: "startup" }, ctx);
      await tick();
      const payload = { model: "verify-model", messages: [], stream: true };
      const result = await pi.emit("before_provider_request", { payload }, ctx);
      assert.equal(result, undefined, `mode ${mode}: payload must pass through unchanged`);
      assert.equal(payload.return_progress, undefined);
      await pi.emit(
        "provider_stream_event",
        { provider: "verify-local", api: "openai-completions", model: "verify-model", data: { prompt_progress: { total: 100, cache: 20, processed: 60, time_ms: 0 } } },
        ctx,
      );
      assert.deepEqual(uiCalls, [], `mode ${mode}: no UI`);
    }
    assert.equal(fetch.calls.length, 0, "no discovery in non-TUI modes");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("TUI journey: discovery, enrichment, prefill working message, generation widget, cleanup", async () => {
  const fetch = modelsFetch(MODELS_OK);
  const realFetch = globalThis.fetch;
  globalThis.fetch = fetch.impl;
  try {
    const pi = makePi();
    extension(pi.api);
    const { ctx, uiCalls } = makeCtx("tui", { ...SPLASH_MODEL });

    await pi.emit("session_start", { reason: "startup" }, ctx);
    await tick();
    assert.equal(fetch.calls.length, 1);
    assert.equal(fetch.calls[0].url, "http://127.0.0.1:9443/splash/v1/models");
    assert.equal(fetch.calls[0].init.headers.Authorization, "Bearer test-key");

    // Enrichment for the verified streaming request.
    const payload = { model: "verify-model", messages: [{ role: "user", content: "hi" }], stream: true };
    const enriched = await pi.emit("before_provider_request", { payload }, ctx);
    assert.notEqual(enriched, payload);
    assert.equal(enriched.return_progress, true);
    assert.equal(enriched.stream_options.include_usage, true);
    assert.equal(payload.return_progress, undefined, "original payload untouched");

    // Prefill progress -> working message (coalesced within 100ms).
    const stream = { provider: "verify-local", api: "openai-completions", model: "verify-model" };
    await pi.emit("provider_stream_event", { ...stream, data: { prompt_progress: { total: 100, cache: 20, processed: 60, time_ms: 0 } } }, ctx);
    await settle();
    const working = uiCalls.filter((c) => c[0] === "working").map((c) => c[1]);
    assert.ok(working.some((line) => line?.includes("Prefilling") && line.includes("50%")), JSON.stringify(working));

    // First generation chunk: working message restored, widget appears immediately.
    const before = uiCalls.length;
    await pi.emit("provider_stream_event", { ...stream, data: { choices: [{ delta: { content: "Verification " } }] } }, ctx);
    const tail = uiCalls.slice(before);
    assert.deepEqual(tail[0], ["working", undefined]);
    assert.deepEqual(tail[1], ["widget", "pi-splash-stats", ["Generating... ≈2 tok"]]);

    // Final chunk: exact count, then cleanup.
    const beforeFinal = uiCalls.length;
    await pi.emit(
      "provider_stream_event",
      { ...stream, data: { choices: [{ finish_reason: "stop" }], usage: { completion_tokens: 7, prompt_tokens: 100, total_tokens: 107 } } },
      ctx,
    );
    const finalTail = uiCalls.slice(beforeFinal);
    assert.ok(finalTail.some((c) => c[0] === "widget" && c[2]?.[0]?.includes("7 tok")));
    assert.deepEqual(finalTail[finalTail.length - 1], ["widget", "pi-splash-stats", undefined]);
    // Working message was already restored; not touched again after.
    assert.ok(!uiCalls.slice(beforeFinal).some((c) => c[0] === "working"));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("non-Splash endpoint: no enrichment, no UI (zero modification)", async () => {
  const fetch = modelsFetch(MODELS_NOT_SPLASH);
  const realFetch = globalThis.fetch;
  globalThis.fetch = fetch.impl;
  try {
    const pi = makePi();
    extension(pi.api);
    const { ctx, uiCalls } = makeCtx("tui", { ...SPLASH_MODEL });
    await pi.emit("session_start", { reason: "startup" }, ctx);
    await tick();
    const payload = { model: "verify-model", messages: [], stream: true };
    const enriched = await pi.emit("before_provider_request", { payload }, ctx);
    assert.equal(enriched, undefined);
    assert.equal(payload.return_progress, undefined);
    const stream = { provider: "verify-local", api: "openai-completions", model: "verify-model" };
    await pi.emit("provider_stream_event", { ...stream, data: { prompt_progress: { total: 10, cache: 0, processed: 5, time_ms: 0 } } }, ctx);
    await settle();
    assert.deepEqual(uiCalls, []);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("model switch: discards results, clears UI, rediscovers the new model", async () => {
  const fetch = modelsFetch(MODELS_OK);
  const realFetch = globalThis.fetch;
  globalThis.fetch = fetch.impl;
  try {
    const pi = makePi();
    extension(pi.api);
    const modelA = { ...SPLASH_MODEL };
    const modelB = { ...SPLASH_MODEL, baseUrl: "http://127.0.0.1:9443/other/v1", provider: "splash" };
    const { ctx, uiCalls } = makeCtx("tui", modelA);
    await pi.emit("session_start", { reason: "startup" }, ctx);
    await tick();
    await pi.emit("before_provider_request", { payload: { model: "verify-model", messages: [], stream: true } }, ctx);
    const stream = { provider: "verify-local", api: "openai-completions", model: "verify-model" };
    await pi.emit("provider_stream_event", { ...stream, data: { prompt_progress: { total: 100, cache: 0, processed: 50, time_ms: 100 } } }, ctx);
    await settle();
    assert.ok(uiCalls.some((c) => c[0] === "working" && c[1]?.includes("Prefilling")));

    ctx.model = modelB;
    await pi.emit("model_select", { model: modelB, previousModel: modelA, source: "command" }, ctx);
    await tick();
    // UI cleared and a second discovery for the new endpoint.
    assert.ok(uiCalls.some((c) => c[0] === "working" && c[1] === undefined));
    assert.equal(fetch.calls.length, 2);
    assert.ok(fetch.calls[1].url.endsWith("/other/v1/models"));

    // Old-stream events no longer feed the UI.
    const before = uiCalls.length;
    await pi.emit("provider_stream_event", { ...stream, data: { prompt_progress: { total: 100, cache: 0, processed: 90, time_ms: 200 } } }, ctx);
    await settle();
    assert.equal(uiCalls.length, before);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("stale stream events (mismatched provider/api/model) are ignored", async () => {
  const fetch = modelsFetch(MODELS_OK);
  const realFetch = globalThis.fetch;
  globalThis.fetch = fetch.impl;
  try {
    const pi = makePi();
    extension(pi.api);
    const { ctx, uiCalls } = makeCtx("tui", { ...SPLASH_MODEL });
    await pi.emit("session_start", { reason: "startup" }, ctx);
    await tick();
    await pi.emit("before_provider_request", { payload: { model: "verify-model", messages: [], stream: true } }, ctx);
    for (const data of [
      { provider: "other", api: "openai-completions", model: "verify-model" },
      { provider: "verify-local", api: "anthropic-messages", model: "verify-model" },
      { provider: "verify-local", api: "openai-completions", model: "other-model" },
    ]) {
      await pi.emit(
        "provider_stream_event",
        { ...data, data: { prompt_progress: { total: 100, cache: 0, processed: 50, time_ms: 0 } } },
        ctx,
      );
    }
    await settle();
    assert.deepEqual(uiCalls, []);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("turn_end is a safety net: clears owned UI when no final chunk arrives", async () => {
  const fetch = modelsFetch(MODELS_OK);
  const realFetch = globalThis.fetch;
  globalThis.fetch = fetch.impl;
  try {
    const pi = makePi();
    extension(pi.api);
    const { ctx, uiCalls } = makeCtx("tui", { ...SPLASH_MODEL });
    await pi.emit("session_start", { reason: "startup" }, ctx);
    await tick();
    await pi.emit("before_provider_request", { payload: { model: "verify-model", messages: [], stream: true } }, ctx);
    const stream = { provider: "verify-local", api: "openai-completions", model: "verify-model" };
    await pi.emit("provider_stream_event", { ...stream, data: { prompt_progress: { total: 100, cache: 0, processed: 50, time_ms: 0 } } }, ctx);
    await settle();
    assert.ok(uiCalls.some((c) => c[0] === "working" && c[1]?.includes("Prefilling")));
    await pi.emit("turn_end", { message: {}, completion: { stopReason: "aborted" } }, ctx);
    assert.ok(uiCalls.some((c) => c[0] === "working" && c[1] === undefined));
    // The request is finalized: late chunks are ignored.
    const before = uiCalls.length;
    await pi.emit("provider_stream_event", { ...stream, data: { choices: [{ delta: { content: "late" } }] } }, ctx);
    await settle();
    assert.equal(uiCalls.length, before);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("session_shutdown disposes everything; late events are ignored", async () => {
  const fetch = modelsFetch(MODELS_OK);
  const realFetch = globalThis.fetch;
  globalThis.fetch = fetch.impl;
  try {
    const pi = makePi();
    extension(pi.api);
    const { ctx, uiCalls } = makeCtx("tui", { ...SPLASH_MODEL });
    await pi.emit("session_start", { reason: "startup" }, ctx);
    await tick();
    await pi.emit("before_provider_request", { payload: { model: "verify-model", messages: [], stream: true } }, ctx);
    const stream = { provider: "verify-local", api: "openai-completions", model: "verify-model" };
    await pi.emit("provider_stream_event", { ...stream, data: { prompt_progress: { total: 100, cache: 0, processed: 50, time_ms: 0 } } }, ctx);
    await settle();
    const before = uiCalls.length;
    await pi.emit("session_shutdown", {}, ctx);
    assert.ok(uiCalls.slice(before).some((c) => c[0] === "working" && c[1] === undefined));
    const after = uiCalls.length;
    await pi.emit("provider_stream_event", { ...stream, data: { prompt_progress: { total: 100, cache: 0, processed: 90, time_ms: 50 } } }, ctx);
    await pi.emit("before_provider_request", { payload: { model: "verify-model", messages: [], stream: true } }, ctx);
    await tick();
    assert.equal(uiCalls.length, after, "no UI after shutdown");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("repeated registration is reload-safe: instances are independent", async () => {
  const fetch = modelsFetch(MODELS_OK);
  const realFetch = globalThis.fetch;
  globalThis.fetch = fetch.impl;
  try {
    const piA = makePi();
    const piB = makePi();
    extension(piA.api);
    extension(piB.api);
    const { ctx: ctxA } = makeCtx("tui", { ...SPLASH_MODEL });
    const { ctx: ctxB, uiCalls: uiB } = makeCtx("tui", { ...SPLASH_MODEL });
    await piA.emit("session_start", { reason: "startup" }, ctxA);
    await piA.emit("session_shutdown", {}, ctxA);
    // Shutting down instance A must not affect instance B.
    await piB.emit("session_start", { reason: "startup" }, ctxB);
    await tick();
    const payload = { model: "verify-model", messages: [], stream: true };
    const enriched = await piB.emit("before_provider_request", { payload }, ctxB);
    assert.equal(enriched?.return_progress, true);
    assert.equal(uiB.length, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---------------------------------------------------------------------------
// S4 lifecycle hardening (SPEC 9, 11)
// ---------------------------------------------------------------------------

/** Last working-message line rendered (undefined after a clear / none). */
function lastWorking(uiCalls: unknown[][]): string | undefined {
  for (let i = uiCalls.length - 1; i >= 0; i--) {
    if (uiCalls[i][0] === "working") return uiCalls[i][1] as string | undefined;
  }
  return undefined;
}

const prefillChunk = (total: number, cache: number, processed: number) => ({
  data: { prompt_progress: { total, cache, processed, time_ms: 0 } },
  provider: "verify-local",
  api: "openai-completions",
  model: "verify-model",
});

const finalChunk = (total: number, cache: number, generated: number) => ({
  data: { delta: { finish_reason: "stop" }, usage: { prompt_tokens: total, completion_tokens: generated, cache_read_input_tokens: cache }, timings: { time_to_first_token_ms: 50, duration_ms: 100 } },
  provider: "verify-local",
  api: "openai-completions",
  model: "verify-model",
});

test("a newer request starts fresh: no state leaks from a superseded request", async () => {
  const fetch = modelsFetch(MODELS_OK);
  const realFetch = globalThis.fetch;
  globalThis.fetch = fetch.impl;
  const { api: pi, emit } = makePi();
  const { ctx, uiCalls } = makeCtx("tui", { ...SPLASH_MODEL });
  extension(pi);
  try {
    await emit("session_start", { reason: "startup" }, ctx);
    // Request A starts and streams a prefill sample.
    await emit("before_provider_request", { payload: { model: "verify-model", messages: [], stream: true } }, ctx);
    await emit("provider_stream_event", prefillChunk(100, 25, 38), ctx);
    await settle();
    assert.match(lastWorking(uiCalls)!, /Prefilling\.\..*\s17%$/);
    // Request B starts (same model — next turn); A is superseded and finalized.
    await emit("before_provider_request", { payload: { model: "verify-model", messages: [], stream: true } }, ctx);
    await emit("provider_stream_event", prefillChunk(200, 50, 50), ctx);
    await settle();
    // B starts fresh: its line reflects B's own report, NOT A's (17%). Only one
    // request is ever tracked, so concurrent same-model streams cannot mix (SPEC 9).
    assert.match(lastWorking(uiCalls)!, /Prefilling\.\..*\s0%$/, "B's state is fresh, not mixed with A");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("finalize exactly once: a duplicate final chunk and a late boundary are no-ops", async () => {
  const fetch = modelsFetch(MODELS_OK);
  const realFetch = globalThis.fetch;
  globalThis.fetch = fetch.impl;
  const { api: pi, emit } = makePi();
  const { ctx, uiCalls } = makeCtx("tui", { ...SPLASH_MODEL });
  extension(pi);
  try {
    await emit("session_start", { reason: "startup" }, ctx);
    await emit("before_provider_request", { payload: { model: "verify-model", messages: [], stream: true } }, ctx);
    await emit("provider_stream_event", prefillChunk(100, 25, 38), ctx);
    await settle();
    // First final chunk finalizes the request and clears the UI once.
    await emit("provider_stream_event", finalChunk(100, 25, 4), ctx);
    const callsAfterFirstFinal = uiCalls.length;
    // A duplicate final chunk must be a no-op (already finalized).
    await emit("provider_stream_event", finalChunk(100, 25, 4), ctx);
    await settle();
    assert.equal(uiCalls.length, callsAfterFirstFinal, "double final chunk is a no-op");
    // A late boundary event must also be a no-op (no active request, no orphaned UI).
    await emit("turn_end", {}, ctx);
    assert.equal(uiCalls.length, callsAfterFirstFinal, "late boundary after finalization is a no-op");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("/reload: a second session_start re-arms exactly one runtime, no stacked state", async () => {
  const fetch = modelsFetch(MODELS_OK);
  const realFetch = globalThis.fetch;
  globalThis.fetch = fetch.impl;
  const { api: pi, emit } = makePi();
  const { ctx, uiCalls } = makeCtx("tui", { ...SPLASH_MODEL });
  extension(pi);
  try {
    await emit("session_start", { reason: "startup" }, ctx);
    // A request in the first runtime.
    await emit("before_provider_request", { payload: { model: "verify-model", messages: [], stream: true } }, ctx);
    await emit("provider_stream_event", prefillChunk(100, 25, 38), ctx);
    await settle();
    // Reload: session_shutdown disposes the runtime, session_start("reload") re-arms one.
    await emit("session_shutdown", {}, ctx);
    await emit("session_start", { reason: "reload" }, ctx);
    // The new runtime enriches exactly one active request (a fresh discovery cache).
    const callsBefore = uiCalls.length;
    const enriched = await emit("before_provider_request", { payload: { model: "verify-model", messages: [], stream: true } }, ctx);
    assert.equal(enriched?.return_progress, true, "reload re-enriches");
    await emit("provider_stream_event", prefillChunk(100, 25, 38), ctx);
    await settle();
    // Exactly one working-message render for the new request (no stacked UI).
    const renders = uiCalls.slice(callsBefore).filter((c) => c[0] === "working" && c[1] !== undefined);
    assert.equal(renders.length, 1, "reload produces exactly one active request render");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("retained late callbacks are inert after session_shutdown", async () => {
  const fetch = modelsFetch(MODELS_OK);
  const realFetch = globalThis.fetch;
  globalThis.fetch = fetch.impl;
  const { api: pi, emit } = makePi();
  const { ctx, uiCalls } = makeCtx("tui", { ...SPLASH_MODEL });
  extension(pi);
  try {
    await emit("session_start", { reason: "startup" }, ctx);
    await emit("before_provider_request", { payload: { model: "verify-model", messages: [], stream: true } }, ctx);
    await emit("provider_stream_event", prefillChunk(100, 25, 38), ctx);
    await settle();
    // Shutdown makes the state inert.
    await emit("session_shutdown", {}, ctx);
    const callsAfterShutdown = uiCalls.length;
    // A late stream chunk is inert.
    await emit("provider_stream_event", prefillChunk(100, 25, 38), ctx);
    // A late boundary event is inert.
    await emit("turn_end", {}, ctx);
    // A late before_provider_request is inert (no enrichment after shutdown).
    const enriched = await emit("before_provider_request", { payload: { model: "verify-model", messages: [], stream: true } }, ctx);
    assert.equal(enriched?.return_progress, undefined, "no enrichment after shutdown");
    assert.equal(uiCalls.length, callsAfterShutdown, "no UI calls after shutdown");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("turn_end/agent_settled safety net does not clear a newer active request", async () => {
  const fetch = modelsFetch(MODELS_OK);
  const realFetch = globalThis.fetch;
  globalThis.fetch = fetch.impl;
  const { api: pi, emit } = makePi();
  const { ctx, uiCalls } = makeCtx("tui", { ...SPLASH_MODEL });
  extension(pi);
  try {
    await emit("session_start", { reason: "startup" }, ctx);
    // Request A starts, streams, and its turn ends via the safety net.
    await emit("before_provider_request", { payload: { model: "verify-model", messages: [], stream: true } }, ctx);
    await emit("provider_stream_event", prefillChunk(100, 25, 38), ctx);
    await settle();
    await emit("turn_end", {}, ctx); // safety net finalizes A
    assert.equal(lastWorking(uiCalls), undefined, "A cleared by safety net");
    // A NEWER request B starts and streams; its UI must survive A's cleanup.
    await emit("before_provider_request", { payload: { model: "verify-model", messages: [], stream: true } }, ctx);
    await emit("provider_stream_event", prefillChunk(200, 50, 50), ctx);
    await settle();
    assert.match(lastWorking(uiCalls)!, /Prefilling\.\..*\s0%$/, "B's UI is shown");
    // B is now the newer active request. Its own final chunk finalizes it (one clear).
    const callsBeforeFinal = uiCalls.length;
    await emit("provider_stream_event", finalChunk(200, 50, 4), ctx);
    // A stale/late boundary event after B's finalization must not touch anything.
    await emit("agent_settled", {}, ctx);
    assert.equal(uiCalls.length, callsBeforeFinal + 1, "late boundary is a no-op after B finalized (one clear)");
  } finally {
    globalThis.fetch = realFetch;
  }
});
