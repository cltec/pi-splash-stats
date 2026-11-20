import assert from "node:assert/strict";
import test from "node:test";

import { authContextId, DiscoveryCache, type DiscoveryResponse } from "../src/discovery.ts";

function jsonResponse(body: unknown, overrides: Partial<DiscoveryResponse> = {}): DiscoveryResponse {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => (name.toLowerCase() === "content-length" ? String(bytes.byteLength) : null) },
    arrayBuffer: async () => bytes.buffer as ArrayBuffer,
    ...overrides,
  };
}

const splashModel = { id: "verify-model", object: "model", owned_by: "splash" };
const MODEL = { api: "openai-completions", baseUrl: "http://127.0.0.1:1234/splash/v1", id: "verify-model" };

function makeCache(options: {
  fetchImpl?: (url: string, init?: unknown) => Promise<DiscoveryResponse>;
  clock?: () => number;
  advance?: (ms: number) => void;
  deadlineMs?: number;
} = {}) {
  let nowMs = 1_000_000;
  const calls: { url: string; init: any }[] = [];
  const fetchImpl =
    options.fetchImpl ??
    (async (url: string, init?: any) => {
      calls.push({ url, init });
      return jsonResponse({ object: "list", data: [splashModel] });
    });
  const cache = new DiscoveryCache({
    fetchImpl,
    now: options.clock ?? (() => nowMs),
    deadlineMs: options.deadlineMs ?? 2000,
  });
  return {
    cache,
    calls,
    advance: (ms: number) => {
      nowMs += ms;
    },
    ensure: () => cache.ensure(MODEL, async () => ({ apiKey: "secret-key", headers: { "x-custom": "v" } })),
  };
}

test("verified identity is cached positively for 60s (no refetch)", async () => {
  const { cache, calls, advance, ensure } = makeCache();
  assert.equal(await ensure(), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:1234/splash/v1/models");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.redirect, "manual");
  assert.equal(calls[0].init.headers.Authorization, "Bearer secret-key");
  assert.equal(calls[0].init.headers["x-custom"], "v");
  advance(59_000);
  assert.equal(await ensure(), true);
  assert.equal(calls.length, 1);
  advance(1_000); // 60s total: expired, refetch
  assert.equal(await ensure(), true);
  assert.equal(calls.length, 2);
});

test("negative results are cached for 5s, then allowed to recover", async () => {
  const { cache, calls, advance, ensure } = makeCache({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return jsonResponse({ object: "list", data: [{ id: "verify-model", owned_by: "llama.cpp" }] });
    },
  });
  assert.equal(await ensure(), false);
  advance(4_000);
  assert.equal(await ensure(), false);
  assert.equal(calls.length, 1);
  advance(1_000);
  assert.equal(await ensure(), false);
  assert.equal(calls.length, 2);
});

test("in-flight discovery is deduplicated per endpoint + auth context", async () => {
  let resolveFetch: (response: DiscoveryResponse) => void = () => {};
  const { cache, calls, ensure } = makeCache({
    fetchImpl: () =>
      new Promise<DiscoveryResponse>((resolve) => {
        calls.push({});
        resolveFetch = resolve;
      }),
  });
  const first = ensure();
  const second = ensure();
  await new Promise((resolve) => setTimeout(resolve, 0)); // let both reaches in-flight
  resolveFetch(jsonResponse({ object: "list", data: [splashModel] }));
  assert.equal(await first, true);
  assert.equal(await second, true);
  assert.equal(calls.length, 1);
});

test("distinct auth contexts are cached separately (non-secret identity)", async () => {
  const calls: number[] = [];
  const cache = new DiscoveryCache({
    fetchImpl: async () => {
      calls.push(1);
      return jsonResponse({ object: "list", data: [splashModel] });
    },
    now: () => 0,
  });
  // Non-secret identity: presence of a key plus header names, never values.
  assert.equal(await cache.ensure(MODEL, async () => ({})), true);
  assert.equal(await cache.ensure(MODEL, async () => ({ headers: { Authorization: "x" } })), true);
  assert.equal(calls.length, 2);
  assert.equal(await cache.ensure(MODEL, async () => ({})), true);
  assert.equal(calls.length, 2);
});

test("auth context identity never contains secrets", () => {
  assert.equal(authContextId({ apiKey: "top-secret", headers: { Authorization: "x" } }), "key:Authorization");
  assert.equal(authContextId({}), "none:");
});

test("redirect responses are refused, never followed", async () => {
  const { calls, ensure } = makeCache({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return jsonResponse(null, { ok: false, status: 302 });
    },
  });
  assert.equal(await ensure(), false);
  assert.equal(calls.length, 1);
});

test("HTTP failures, malformed JSON, and wrong identity fail closed", async () => {
  for (const response of [
    jsonResponse(null, { ok: false, status: 401 }),
    jsonResponse(null, { ok: false, status: 404 }),
    jsonResponse(null, { ok: false, status: 500 }),
    jsonResponse("not json", {
      arrayBuffer: async () => new TextEncoder().encode("not json").buffer as ArrayBuffer,
    }),
    jsonResponse({ object: "list", data: [{ id: "verify-model", owned_by: "llama.cpp" }] }),
    jsonResponse({ data: "nope" }),
  ]) {
    const { ensure } = makeCache({ fetchImpl: async () => response });
    assert.equal(await ensure(), false);
  }
});

test("response bodies over 1 MiB are rejected without being read past the bound", async () => {
  const declared = makeCache({
    fetchImpl: async () =>
      jsonResponse(null, {
        headers: { get: (name: string) => (name.toLowerCase() === "content-length" ? String(1024 * 1024 + 1) : null) },
        arrayBuffer: async () => {
          throw new Error("must not be read");
        },
      }),
  });
  assert.equal(await declared.ensure(), false);

  let read = false;
  const actual = makeCache({
    fetchImpl: async () =>
      jsonResponse(null, {
        headers: { get: () => null },
        arrayBuffer: async () => {
          read = true;
          return new ArrayBuffer(1024 * 1024 + 1);
        },
      }),
  });
  assert.equal(await actual.ensure(), false);
  assert.equal(read, true);
});

test("the total deadline aborts a hung probe", async () => {
  const aborts: boolean[] = [];
  const cache = new DiscoveryCache({
    fetchImpl: (_url, init) =>
      new Promise<DiscoveryResponse>((resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborts.push(true);
          reject(new Error("aborted"));
        });
      }),
    now: Date.now,
    deadlineMs: 30,
  });
  assert.equal(await cache.ensure(MODEL, async () => ({})), false);
  assert.deepEqual(aborts, [true]);
});

test("auth resolution counts toward the deadline", async () => {
  const started = Date.now();
  const cache = new DiscoveryCache({
    fetchImpl: async () => jsonResponse({ object: "list", data: [splashModel] }),
    deadlineMs: 20,
  });
  // Auth resolution alone exceeds the budget.
  assert.equal(
    await cache.ensure(MODEL, () => new Promise((resolve) => setTimeout(() => resolve({}), 60))),
    false,
  );
  assert.ok(Date.now() - started < 500);
});

test("non-candidate models never probe", async () => {
  const { calls, cache } = makeCache();
  assert.equal(await cache.ensure({ api: "anthropic-messages", baseUrl: "http://host/v1", id: "m" }, async () => ({})), false);
  assert.equal(await cache.ensure({ api: "openai-completions", baseUrl: "bad", id: "m" }, async () => ({})), false);
  assert.equal(calls.length, 0);
});

test("dispose cancels in-flight probes and rejects late results", async () => {
  const aborts: boolean[] = [];
  let resolveFetch: (response: DiscoveryResponse) => void = () => {};
  const cache = new DiscoveryCache({
    fetchImpl: (_url, init) =>
      new Promise<DiscoveryResponse>((resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborts.push(true);
          reject(new Error("aborted"));
        });
        resolveFetch = resolve;
      }),
    deadlineMs: 60_000,
  });
  const pending = cache.ensure(MODEL, async () => ({}));
  await new Promise((resolve) => setTimeout(resolve, 0)); // probe is now in flight
  cache.dispose();
  assert.equal(await pending, false);
  assert.deepEqual(aborts, [true]);
  // Late results must not reactivate a disposed session.
  resolveFetch(jsonResponse({ object: "list", data: [splashModel] }));
  assert.equal(await cache.ensure(MODEL, async () => ({})), false);
});

test("auth failures fall back to anonymous probing without throwing", async () => {
  const { cache } = makeCache();
  // A throwing auth resolver must not crash the probe; it degrades to no auth.
  assert.equal(
    await cache.ensure(MODEL, async () => {
      throw new Error("no credentials");
    }),
    true,
  );
});
