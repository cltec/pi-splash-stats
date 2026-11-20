import assert from "node:assert/strict";
import test from "node:test";

import {
  createSSEParser,
  extractRequestInfo,
  baseUrlFromRequestUrl,
  installFetchObserver,
  MAX_EVENT_BYTES,
  type FinalizeReason,
} from "../src/fetch-observer.ts";

const enc = new TextEncoder();

/** Build a streaming SSE Response from raw frame strings. */
function sseResponse(frames: string[], status = 200, headers: Record<string, string> = {}): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(enc.encode(frame));
      controller.close();
    },
  });
  return new Response(stream, { status, headers: { "content-type": "text/event-stream", ...headers } });
}

/** Read a Response body to a string (drains the stream). */
async function drain(response: Response): Promise<string> {
  const text = await response.text();
  return text;
}

// ---------------------------------------------------------------------------
// SSE parser
// ---------------------------------------------------------------------------

test("parser: single data event with trailing newline", () => {
  const events: string[] = [];
  const parser = createSSEParser({ onEvent: (d) => events.push(d) });
  parser.feed(enc.encode('data: {"a":1}\n\n'));
  assert.deepEqual(events, ['{"a":1}']);
});

test("parser: multi-line data fields are joined with a newline", () => {
  const events: string[] = [];
  const parser = createSSEParser({ onEvent: (d) => events.push(d) });
  parser.feed(enc.encode("data: line1\ndata: line2\n\n"));
  assert.deepEqual(events, ["line1\nline2"]);
});

test("parser: CRLF line endings are handled", () => {
  const events: string[] = [];
  const parser = createSSEParser({ onEvent: (d) => events.push(d) });
  parser.feed(enc.encode('data: {"x":1}\r\n\r\n'));
  assert.deepEqual(events, ['{"x":1}']);
});

test("parser: comment and unknown fields are ignored", () => {
  const events: string[] = [];
  const parser = createSSEParser({ onEvent: (d) => events.push(d) });
  parser.feed(enc.encode(": comment\nevent: message\nid: 42\nretry: 5000\ndata: ok\n\n"));
  assert.deepEqual(events, ["ok"]);
});

test("parser: event split across chunks is assembled", () => {
  const events: string[] = [];
  const parser = createSSEParser({ onEvent: (d) => events.push(d) });
  parser.feed(enc.encode("data: {"));
  parser.feed(enc.encode('"split":'));
  parser.feed(enc.encode(' true}\n\n'));
  assert.deepEqual(events, ['{"split": true}']);
});

test("parser: split multi-byte UTF-8 is decoded across chunks", () => {
  const events: string[] = [];
  const parser = createSSEParser({ onEvent: (d) => events.push(d) });
  const full = enc.encode("data: café\n\n"); // é is 2 bytes in UTF-8
  // Split inside the multi-byte é.
  const splitAt = full.indexOf(enc.encode("é"));
  parser.feed(full.subarray(0, splitAt + 1)); // first byte of é
  parser.feed(full.subarray(splitAt + 1)); // second byte of é + rest
  assert.deepEqual(events, ["café"]);
});

test("parser: overflow disables statistics and reports once", () => {
  const events: string[] = [];
  let overflows = 0;
  const parser = createSSEParser({
    onEvent: (d) => events.push(d),
    onOverflow: () => overflows++,
    maxEventBytes: 16,
  });
  parser.feed(enc.encode("data: 0123456789abcdef\n\n")); // 16 bytes data, at the bound
  assert.deepEqual(events, ["0123456789abcdef"], "at-the-bound event is delivered");
  assert.equal(parser.disabled, false);
  parser.feed(enc.encode("data: 0123456789abcdefg\n\n")); // 17 bytes data, exceeds the bound
  assert.equal(parser.disabled, true);
  assert.equal(overflows, 1);
  parser.feed(enc.encode("data: more\n\n")); // no further events after overflow
  assert.equal(events.length, 1);
});

test("parser: [DONE] is dispatched (the observer filters it)", () => {
  const events: string[] = [];
  const parser = createSSEParser({ onEvent: (d) => events.push(d) });
  parser.feed(enc.encode("data: [DONE]\n\n"));
  assert.deepEqual(events, ["[DONE]"]);
});

test("parser: flush dispatches a trailing frame without a final newline", () => {
  const events: string[] = [];
  const parser = createSSEParser({ onEvent: (d) => events.push(d) });
  parser.feed(enc.encode("data: tail")); // no trailing newline
  assert.deepEqual(events, []);
  parser.flush();
  assert.deepEqual(events, ["tail"]);
});

test("parser: a throwing onEvent does not escape", () => {
  const parser = createSSEParser({ onEvent: () => {
    throw new Error("stats handler exploded");
  } });
  assert.doesNotThrow(() => parser.feed(enc.encode("data: x\n\n")));
});

// ---------------------------------------------------------------------------
// extractRequestInfo / baseUrlFromRequestUrl
// ---------------------------------------------------------------------------

test("extractRequestInfo: string input with string body", () => {
  const info = extractRequestInfo("http://h/v1/chat/completions", { method: "post", body: '{"model":"m"}' });
  assert.equal(info.url, "http://h/v1/chat/completions");
  assert.equal(info.method, "POST");
  assert.equal(info.bodyText, '{"model":"m"}');
  assert.equal(info.passthrough, false);
});

test("extractRequestInfo: URL input with string body", () => {
  const url = new URL("http://h/v1/chat/completions");
  const info = extractRequestInfo(url, { method: "POST", body: '{"model":"m"}' });
  assert.equal(info.url, "http://h/v1/chat/completions");
  assert.equal(info.method, "POST");
  assert.equal(info.bodyText, '{"model":"m"}');
  assert.equal(info.passthrough, false);
});

test("extractRequestInfo: Request input is passed through", () => {
  const req = new Request("http://h/v1/chat/completions", { method: "POST", body: '{"model":"m"}' });
  const info = extractRequestInfo(req);
  assert.equal(info.passthrough, true);
  assert.equal(info.url, null);
  assert.equal(info.bodyText, null);
});

test("extractRequestInfo: missing or non-string body yields null bodyText", () => {
  assert.equal(extractRequestInfo("http://h", { method: "POST" }).bodyText, null);
  assert.equal(extractRequestInfo("http://h", { method: "POST", body: new Uint8Array() }).bodyText, null);
  assert.equal(extractRequestInfo("http://h").method, "GET");
});

test("baseUrlFromRequestUrl: strips the /chat/completions suffix", () => {
  assert.equal(baseUrlFromRequestUrl("http://h:1/splash/v1/chat/completions"), "http://h:1/splash/v1");
  assert.equal(baseUrlFromRequestUrl("http://h/models"), null);
  assert.equal(baseUrlFromRequestUrl("http://h/v1/chat/completions/extra"), null);
});

// ---------------------------------------------------------------------------
// installFetchObserver
// ---------------------------------------------------------------------------

interface Call {
  url: string;
  init?: RequestInit;
}

function makeTarget(responder: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const target = {
    fetch: async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push({ url, init });
      return responder(url, init);
    },
  };
  return { target, calls };
}

test("observer: eligible request is enriched and its SSE frames are observed", async () => {
  const { target, calls } = makeTarget(() =>
    sseResponse([
      'data: {"prompt_progress":{"total":100,"cache":0,"processed":50,"time_ms":1}}\n\n',
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
      "data: [DONE]\n\n",
    ]),
  );
  const frames: Record<string, unknown>[] = [];
  const finalizes: FinalizeReason[] = [];
  const dispose = installFetchObserver<{ tag: string }>({
    target,
    classify: (url, method, body) => (method === "POST" && url.endsWith("/chat/completions") ? { tag: "s" } : null),
    enrich: (body) => ({ ...body, return_progress: true, stream_options: { include_usage: true } }),
    onFrame: (_attr, frame) => frames.push(frame),
    onFinalize: (_attr, reason) => finalizes.push(reason),
  });
  try {
    const response = await target.fetch("http://h/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "m", stream: true }),
    });
    const text = await drain(response);
    // Enriched body was sent.
    const sent = JSON.parse(calls[0].init?.body as string);
    assert.equal(sent.return_progress, true);
    assert.equal(sent.stream_options.include_usage, true);
    assert.equal(sent.model, "m");
    // Frames observed (the [DONE] sentinel is filtered).
    assert.equal(frames.length, 2);
    assert.equal(frames[0].prompt_progress.processed, 50);
    // Bytes forwarded unchanged.
    assert.ok(text.includes('data: {"prompt_progress"'));
    assert.ok(text.includes("data: [DONE]"));
    // Finalized once, on done.
    assert.deepEqual(finalizes, ["done"]);
  } finally {
    dispose();
  }
});

test("observer: ineligible (GET) request passes through unchanged", async () => {
  const { target, calls } = makeTarget(() => sseResponse(["data: x\n\n"]));
  const frames: unknown[] = [];
  const dispose = installFetchObserver({
    target,
    classify: (_url, method) => (method === "POST" ? { t: 1 } : null),
    onFrame: (_a, f) => frames.push(f),
  });
  try {
    const init = { method: "GET" };
    const response = await target.fetch("http://h/v1/models", init);
    await drain(response);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init, init, "init passed through by reference");
    assert.equal(frames.length, 0, "no observation of a passthrough request");
  } finally {
    dispose();
  }
});

test("observer: non-JSON body passes through unchanged", async () => {
  const { target, calls } = makeTarget(() => sseResponse(["data: x\n\n"]));
  const finalizes: FinalizeReason[] = [];
  const dispose = installFetchObserver({
    target,
    classify: () => ({ t: 1 }),
    onFinalize: (_a, r) => finalizes.push(r),
  });
  try {
    const body = "not-json";
    const response = await target.fetch("http://h/v1/chat/completions", { method: "POST", body });
    await drain(response);
    assert.equal(calls[0].init?.body, body, "body unchanged");
    assert.equal(finalizes.length, 0);
  } finally {
    dispose();
  }
});

test("observer: classify returning null passes through without enrichment", async () => {
  const { target, calls } = makeTarget(() => sseResponse(["data: x\n\n"]));
  const frames: unknown[] = [];
  const dispose = installFetchObserver({
    target,
    classify: () => null, // e.g. chat phase, or non-owned backend
    enrich: (b) => ({ ...b, return_progress: true }),
    onFrame: (_a, f) => frames.push(f),
  });
  try {
    const body = JSON.stringify({ model: "m", stream: true });
    const response = await target.fetch("http://h/v1/chat/completions", { method: "POST", body });
    await drain(response);
    assert.equal(calls[0].init?.body, body, "body not enriched");
    assert.equal(frames.length, 0);
  } finally {
    dispose();
  }
});

test("observer: response status, headers, and bytes are preserved", async () => {
  const { target } = makeTarget(() =>
    sseResponse(['data: {"a":1}\n\n', "data: [DONE]\n\n"], 200, { "x-custom": "yes" }),
  );
  const dispose = installFetchObserver({ target, classify: () => ({ t: 1 }) });
  try {
    const response = await target.fetch("http://h/v1/chat/completions", { method: "POST", body: '{"model":"m"}' });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-custom"), "yes");
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    const text = await drain(response);
    assert.equal(text, 'data: {"a":1}\n\ndata: [DONE]\n\n');
  } finally {
    dispose();
  }
});

test("observer: a rejected fetch propagates the error and reports finalize(error)", async () => {
  const { target } = makeTarget(() => {
    throw new Error("network down");
  });
  const finalizes: FinalizeReason[] = [];
  const dispose = installFetchObserver({
    target,
    classify: () => ({ t: 1 }),
    onFinalize: (_a, r) => finalizes.push(r),
  });
  try {
    await assert.rejects(
      () => target.fetch("http://h/v1/chat/completions", { method: "POST", body: '{"model":"m"}' }),
      /network down/,
    );
    assert.deepEqual(finalizes, ["error"]);
  } finally {
    dispose();
  }
});

test("observer: consumer cancellation reports finalize(abort) and cancels the source", async () => {
  let sourceCancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(enc.encode("data: first\n\n"));
      // Keep the stream open; the consumer will cancel it.
    },
    cancel() {
      sourceCancelled = true;
    },
  });
  const { target } = makeTarget(() => new Response(stream, { status: 200 }));
  const finalizes: FinalizeReason[] = [];
  const frames: Record<string, unknown>[] = [];
  const dispose = installFetchObserver({
    target,
    classify: () => ({ t: 1 }),
    onFrame: (_a, f) => frames.push(f),
    onFinalize: (_a, r) => finalizes.push(r),
  });
  try {
    const response = await target.fetch("http://h/v1/chat/completions", { method: "POST", body: '{"model":"m"}' });
    const reader = response.body!.getReader();
    const { value } = await reader.read(); // read the first frame
    assert.ok(value !== undefined);
    await reader.cancel(); // consumer cancels
    assert.equal(sourceCancelled, true, "the source stream was cancelled");
    assert.deepEqual(finalizes, ["abort"]);
  } finally {
    dispose();
  }
});

test("observer: dispose restores the previous fetch and makes the wrapper inert", async () => {
  const inner = async (_input: string, _init?: RequestInit): Promise<Response> => sseResponse(["data: x\n\n"]);
  const target = { fetch: inner as typeof fetch };
  const finalizes: FinalizeReason[] = [];
  const dispose = installFetchObserver({
    target,
    classify: () => ({ t: 1 }),
    onFinalize: (_a, r) => finalizes.push(r),
  });
  assert.notEqual(target.fetch, inner, "fetch was wrapped");
  dispose();
  assert.equal(target.fetch, inner, "fetch restored after dispose");
  // A retained reference to the wrapper is inert (delegates, no observation).
  // (The wrapper is no longer reachable via target.fetch, but dispose is idempotent.)
  dispose();
  assert.equal(target.fetch, inner, "second dispose is a no-op");
  assert.equal(finalizes.length, 0);
});

test("observer: a retained wrapper reference is callable but inactive after dispose", async () => {
  const { target, calls } = makeTarget(() => sseResponse(["data: x\n\n"]));
  const frames: Record<string, unknown>[] = [];
  const finalizes: FinalizeReason[] = [];
  const dispose = installFetchObserver<{ tag: string }>({
    target,
    classify: (url, method) => (method === "POST" && url.endsWith("/chat/completions") ? { tag: "s" } : null),
    enrich: (b) => ({ ...b, return_progress: true, stream_options: { include_usage: true } }),
    onFrame: (_a, f) => frames.push(f),
    onFinalize: (_a, r) => finalizes.push(r),
  });
  // Capture the wrapped fetch reference BEFORE disposal (an SDK client may retain it).
  const retained = target.fetch;
  dispose();
  // The retained wrapper is still callable and delegates to the previous fetch.
  const body = JSON.stringify({ model: "m", stream: true });
  const response = await retained("http://h/v1/chat/completions", { method: "POST", body });
  const text = await drain(response);
  assert.ok(text.includes("data: x"), "retained wrapper delegates to the previous fetch");
  // It is inactive: the body is passed through (not enriched) and no observation happens.
  assert.equal(calls[0].init?.body, body, "body passed through unchanged (no enrichment)");
  assert.equal(frames.length, 0, "no observation after dispose");
  assert.equal(finalizes.length, 0, "no finalize after dispose");
});

test("observer: dispose does not overwrite a later extension's wrapper", async () => {
  const inner = async (_input: string, _init?: RequestInit): Promise<Response> => sseResponse(["data: x\n\n"]);
  const target = { fetch: inner as typeof fetch };
  const disposeA = installFetchObserver({ target, classify: () => null });
  // Another extension wraps after us.
  const wrapperA = target.fetch;
  const other = async (input: string, init?: RequestInit): Promise<Response> => inner(input, init);
  target.fetch = other as typeof fetch;
  disposeA();
  assert.equal(target.fetch, other, "our dispose left the later wrapper in place");
  assert.notEqual(target.fetch, wrapperA);
});

test("observer: a source read error propagates and reports finalize(error)", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(enc.encode("data: first\n\n"));
      controller.error(new Error("mid-stream failure"));
    },
  });
  const { target } = makeTarget(() => new Response(stream, { status: 200 }));
  const finalizes: FinalizeReason[] = [];
  const dispose = installFetchObserver({
    target,
    classify: () => ({ t: 1 }),
    onFinalize: (_a, r) => finalizes.push(r),
  });
  try {
    const response = await target.fetch("http://h/v1/chat/completions", { method: "POST", body: '{"model":"m"}' });
    await assert.rejects(() => drain(response), /mid-stream failure/);
    assert.deepEqual(finalizes, ["error"]);
  } finally {
    dispose();
  }
});

test("observer: byte-for-byte forwarding with backpressure (large stream)", async () => {
  const chunks: string[] = [];
  for (let i = 0; i < 2000; i++) chunks.push(`data: {"i":${i}}\n\n`);
  const expected = chunks.join("");
  const { target } = makeTarget(() => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(enc.encode(c));
        controller.close();
      },
    });
    return new Response(stream, { status: 200 });
  });
  const frames: Record<string, unknown>[] = [];
  const dispose = installFetchObserver({
    target,
    classify: () => ({ t: 1 }),
    onFrame: (_a, f) => frames.push(f),
  });
  try {
    const response = await target.fetch("http://h/v1/chat/completions", { method: "POST", body: '{"model":"m"}' });
    const text = await drain(response);
    assert.equal(text, expected, "all bytes forwarded in order");
    assert.equal(frames.length, 2000);
  } finally {
    dispose();
  }
});

test("observer: a malformed data frame is ignored without losing forwarded bytes", async () => {
  const { target } = makeTarget(() => sseResponse(["data: not-json\n\n", 'data: {"ok":1}\n\n']));
  const frames: Record<string, unknown>[] = [];
  const dispose = installFetchObserver({
    target,
    classify: () => ({ t: 1 }),
    onFrame: (_a, f) => frames.push(f),
  });
  try {
    const response = await target.fetch("http://h/v1/chat/completions", { method: "POST", body: '{"model":"m"}' });
    const text = await drain(response);
    assert.ok(text.includes("data: not-json"), "malformed bytes still forwarded");
    assert.equal(frames.length, 1, "only the valid frame was observed");
    assert.equal(frames[0].ok, 1);
  } finally {
    dispose();
  }
});

test("parser: MAX_EVENT_BYTES is 1 MiB", () => {
  assert.equal(MAX_EVENT_BYTES, 1024 * 1024);
});
