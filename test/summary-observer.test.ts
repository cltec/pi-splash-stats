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

const SUMMARY_URL = "http://127.0.0.1:9443/splash/v1/chat/completions";

const SUMMARY_FRAMES = [
  'data: {"prompt_progress":{"total":100,"cache":20,"processed":60,"time_ms":10}}\n\n',
  'data: {"choices":[{"delta":{"content":"Summary "}}]}\n\n',
  'data: {"choices":[{"finish_reason":"stop"}],"usage":{"completion_tokens":7,"prompt_tokens":100,"total_tokens":107}}\n\n',
  "data: [DONE]\n\n",
];

function makePi() {
  const handlers = new Map<string, Function[]>();
  const api = {
    registerCommand() {},
    registerTool() {},
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
  const ctx = {
    mode,
    model,
    sessionManager: {},
    ui: {
      setWorkingMessage(message?: string) {
        uiCalls.push(["working", message]);
      },
      setWidget(key: string, content?: string[]) {
        uiCalls.push(["widget", key, content]);
      },
    },
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
    },
  };
  return { ctx, uiCalls };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = () => new Promise((resolve) => setTimeout(resolve, 130));

/**
 * A global-fetch fake that serves the discovery /models endpoint (as a
 * DiscoveryResponse) and the summary /chat/completions endpoint (as a streaming
 * SSE Response).
 */
function summaryFetch(modelsBody: string, frames: string[]) {
  const calls: { url: string; init?: any }[] = [];
  const impl = async (url: string, init?: any) => {
    calls.push({ url, init });
    if (url.endsWith("/models")) {
      const bytes = new TextEncoder().encode(modelsBody);
      return {
        ok: true,
        status: 200,
        headers: { get: (name: string) => (name.toLowerCase() === "content-length" ? String(bytes.byteLength) : null) },
        arrayBuffer: async () => bytes.buffer as ArrayBuffer,
      };
    }
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const f of frames) controller.enqueue(new TextEncoder().encode(f));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  return { calls, impl };
}

function widgetLines(uiCalls: unknown[][]): (string | undefined)[] {
  return uiCalls.filter((c) => c[0] === "widget" && c[1] === "pi-splash-stats").map((c) => c[2]?.[0]);
}

test("registers the summary lifecycle listeners in addition to the chat ones", () => {
  const pi = makePi();
  extension(pi.api);
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

test("compaction journey: summary stats render in the above-editor widget, working message untouched", async () => {
  const fetch = summaryFetch(MODELS_OK, SUMMARY_FRAMES);
  const realFetch = globalThis.fetch;
  globalThis.fetch = fetch.impl;
  try {
    const pi = makePi();
    extension(pi.api);
    const { ctx, uiCalls } = makeCtx("tui", { ...SPLASH_MODEL });
    await pi.emit("session_start", { reason: "startup" }, ctx);
    await tick();

    // Compaction begins; the phase gates the observer.
    await pi.emit("session_before_compact", { reason: "manual" }, ctx);

    // The summary request goes through the global fetch (observed by the extension).
    const response = await globalThis.fetch(SUMMARY_URL, {
      method: "POST",
      body: JSON.stringify({ model: "verify-model", stream: true, messages: [] }),
    });
    await response.text(); // drain: drives the observer's SSE parsing
    await settle();

    // The summary body was enriched.
    const summaryCall = fetch.calls.find((c) => c.url === SUMMARY_URL);
    assert.ok(summaryCall, "summary request reached the backend");
    const sent = JSON.parse(summaryCall.init.body);
    assert.equal(sent.return_progress, true);
    assert.equal(sent.stream_options.include_usage, true);
    assert.equal(sent.model, "verify-model");

    // Prefill + generation rendered in the WIDGET (SPEC 8.1).
    const lines = widgetLines(uiCalls);
    assert.ok(lines.some((l) => l?.includes("Prefilling") && l.includes("50%")), JSON.stringify(lines));
    assert.ok(lines.some((l) => l?.includes("Generating")), JSON.stringify(lines));
    // The widget is cleared once the summary finalizes.
    assert.equal(lines[lines.length - 1], undefined, "widget cleared after the final chunk");
    // Pi's compaction spinner owns the working message; we never touched it.
    assert.ok(!uiCalls.some((c) => c[0] === "working"), "working message untouched for a summary");

    // Compaction completes: the phase resets (the UI was already cleared).
    const before = uiCalls.length;
    await pi.emit("session_compact", { fromExtension: false, reason: "manual" }, ctx);
    assert.equal(uiCalls.length, before, "session_compact is a no-op once the summary finalized");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("branch summary journey: /tree summary renders in the widget", async () => {
  const fetch = summaryFetch(MODELS_OK, SUMMARY_FRAMES);
  const realFetch = globalThis.fetch;
  globalThis.fetch = fetch.impl;
  try {
    const pi = makePi();
    extension(pi.api);
    const { ctx, uiCalls } = makeCtx("tui", { ...SPLASH_MODEL });
    await pi.emit("session_start", { reason: "startup" }, ctx);
    await tick();

    // Tree navigation WITH a summary requested.
    await pi.emit("session_before_tree", { preparation: { userWantsSummary: true } }, ctx);
    const response = await globalThis.fetch(SUMMARY_URL, {
      method: "POST",
      body: JSON.stringify({ model: "verify-model", stream: true, messages: [] }),
    });
    await response.text();
    await settle();

    const lines = widgetLines(uiCalls);
    assert.ok(lines.some((l) => l?.includes("Prefilling")), JSON.stringify(lines));
    assert.ok(lines.some((l) => l?.includes("Generating")), JSON.stringify(lines));
    assert.ok(!uiCalls.some((c) => c[0] === "working"), "working message untouched for a branch summary");

    await pi.emit("session_tree", { newLeafId: "leaf-2", oldLeafId: "leaf-1" }, ctx);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("tree navigation WITHOUT a summary shows no statistics (negative)", async () => {
  const fetch = summaryFetch(MODELS_OK, SUMMARY_FRAMES);
  const realFetch = globalThis.fetch;
  globalThis.fetch = fetch.impl;
  try {
    const pi = makePi();
    extension(pi.api);
    const { ctx, uiCalls } = makeCtx("tui", { ...SPLASH_MODEL });
    await pi.emit("session_start", { reason: "startup" }, ctx);
    await tick();

    // Tree navigation WITHOUT a summary: the phase stays "chat".
    await pi.emit("session_before_tree", { preparation: { userWantsSummary: false } }, ctx);
    const response = await globalThis.fetch(SUMMARY_URL, {
      method: "POST",
      body: JSON.stringify({ model: "verify-model", stream: true, messages: [] }),
    });
    await response.text();
    await settle();

    // The request passed through unchanged (no enrichment) and was not observed.
    const summaryCall = fetch.calls.find((c) => c.url === SUMMARY_URL);
    assert.ok(summaryCall);
    const sent = JSON.parse(summaryCall.init.body);
    assert.equal("return_progress" in sent, false, "no enrichment without a summary phase");
    assert.deepEqual(widgetLines(uiCalls), [], "no widget for a non-summary navigation");
    assert.ok(!uiCalls.some((c) => c[0] === "working"), "no working message either");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("non-Splash summary backend: no enrichment, no statistics (pass-through)", async () => {
  const fetch = summaryFetch(MODELS_NOT_SPLASH, SUMMARY_FRAMES);
  const realFetch = globalThis.fetch;
  globalThis.fetch = fetch.impl;
  try {
    const pi = makePi();
    extension(pi.api);
    const { ctx, uiCalls } = makeCtx("tui", { ...SPLASH_MODEL });
    await pi.emit("session_start", { reason: "startup" }, ctx);
    await tick();

    await pi.emit("session_before_compact", { reason: "manual" }, ctx);
    const response = await globalThis.fetch(SUMMARY_URL, {
      method: "POST",
      body: JSON.stringify({ model: "verify-model", stream: true, messages: [] }),
    });
    await response.text();
    await settle();

    const summaryCall = fetch.calls.find((c) => c.url === SUMMARY_URL);
    assert.ok(summaryCall);
    const sent = JSON.parse(summaryCall.init.body);
    assert.equal("return_progress" in sent, false, "a non-Splash backend is never enriched");
    assert.deepEqual(widgetLines(uiCalls), [], "no statistics for a non-Splash summary");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("chat is not double-counted: chat phase passes the observer through", async () => {
  const fetch = summaryFetch(MODELS_OK, SUMMARY_FRAMES);
  const realFetch = globalThis.fetch;
  globalThis.fetch = fetch.impl;
  try {
    const pi = makePi();
    extension(pi.api);
    const { ctx, uiCalls } = makeCtx("tui", { ...SPLASH_MODEL });
    await pi.emit("session_start", { reason: "startup" }, ctx);
    await tick();

    // In the chat phase, a /chat/completions fetch is NOT a summary; the
    // observer passes it through (the provider hooks own chat).
    const response = await globalThis.fetch(SUMMARY_URL, {
      method: "POST",
      body: JSON.stringify({ model: "verify-model", stream: true, messages: [] }),
    });
    await response.text();
    await settle();

    const summaryCall = fetch.calls.find((c) => c.url === SUMMARY_URL);
    assert.ok(summaryCall);
    const sent = JSON.parse(summaryCall.init.body);
    assert.equal("return_progress" in sent, false, "chat-phase fetch is not enriched by the observer");
    assert.deepEqual(widgetLines(uiCalls), [], "no widget from the observer in the chat phase");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("session_shutdown disposes the observer: a later summary fetch is not observed", async () => {
  const fetch = summaryFetch(MODELS_OK, SUMMARY_FRAMES);
  const realFetch = globalThis.fetch;
  globalThis.fetch = fetch.impl;
  try {
    const pi = makePi();
    extension(pi.api);
    const { ctx, uiCalls } = makeCtx("tui", { ...SPLASH_MODEL });
    await pi.emit("session_start", { reason: "startup" }, ctx);
    await tick();
    await pi.emit("session_before_compact", { reason: "manual" }, ctx);

    // Shutdown restores the global fetch (the wrapper is removed).
    await pi.emit("session_shutdown", { reason: "quit" }, ctx);
    assert.equal(globalThis.fetch, fetch.impl, "the global fetch was restored on shutdown");

    // A later summary fetch is served directly (no observation, no enrichment).
    const response = await globalThis.fetch(SUMMARY_URL, {
      method: "POST",
      body: JSON.stringify({ model: "verify-model", stream: true, messages: [] }),
    });
    await response.text();
    await settle();
    const summaryCall = fetch.calls.find((c) => c.url === SUMMARY_URL);
    const sent = JSON.parse(summaryCall!.init.body);
    assert.equal("return_progress" in sent, false, "no enrichment after shutdown");
    assert.deepEqual(widgetLines(uiCalls), [], "no widget after shutdown");
  } finally {
    globalThis.fetch = realFetch;
  }
});
