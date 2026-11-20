import assert from "node:assert/strict";
import test from "node:test";

import { createRequestState } from "../src/progress.ts";
import { enrichPayload, isPlainObject, matchesStreamRequest } from "../src/transport.ts";

const base = {
  model: "verify-model",
  messages: [{ role: "user", content: "hi" }],
  stream: true,
  temperature: 0.7,
};

test("eligible streaming payload is replaced, never mutated", () => {
  const original = { ...base };
  const enriched = enrichPayload(original, "verify-model");
  assert.notEqual(enriched, original);
  assert.equal(enriched!.return_progress, true);
  assert.equal(enriched!.stream_options.include_usage, true);
  assert.equal(enriched!.model, "verify-model");
  assert.equal(enriched!.stream, true);
  assert.equal(enriched!.temperature, 0.7);
  assert.deepEqual(enriched!.messages, original.messages);
  // Original is untouched.
  assert.equal("return_progress" in original, false);
  assert.equal("stream_options" in original, false);
});

test("nested stream_options survive enrichment", () => {
  const payload = { ...base, stream_options: { include_usage: false, max_tokens: 42 } };
  const enriched = enrichPayload(payload, "verify-model");
  assert.equal(enriched!.stream_options.include_usage, true);
  assert.equal(enriched!.stream_options.max_tokens, 42);
  // The caller-owned stream_options object is not mutated.
  assert.equal(payload.stream_options.include_usage, false);
  assert.equal("max_tokens" in (payload.stream_options as object), true);
});

test("absent stream_options are created with include_usage", () => {
  const enriched = enrichPayload(base, "verify-model");
  assert.deepEqual(enriched!.stream_options, { include_usage: true });
});

test("non-streaming, mismatched model, and malformed payloads pass through unchanged", () => {
  assert.equal(enrichPayload({ ...base, stream: false }, "verify-model"), null);
  assert.equal(enrichPayload({ ...base, stream: "true" }, "verify-model"), null);
  assert.equal(enrichPayload({ ...base, model: "other-model" }, "verify-model"), null);
  assert.equal(enrichPayload({ ...base, model: 42 }, "verify-model"), null);
  assert.equal(enrichPayload(null, "verify-model"), null);
  assert.equal(enrichPayload("{}", "verify-model"), null);
  assert.equal(enrichPayload([base], "verify-model"), null);
  assert.equal(enrichPayload(undefined, "verify-model"), null);
  assert.equal(enrichPayload(Object.create(null), "verify-model"), null); // no stream/model
});

test("isPlainObject distinguishes plain objects from arrays and null", () => {
  assert.equal(isPlainObject({}), true);
  assert.equal(isPlainObject(Object.create(null)), true);
  assert.equal(isPlainObject([]), false);
  assert.equal(isPlainObject(null), false);
  assert.equal(isPlainObject("x"), false);
});

test("stream attribution requires provider, api, and model to all match", () => {
  const request = createRequestState(1, 1, "http://h/v1", "verify-model", "verify-local", "openai-completions");
  assert.equal(matchesStreamRequest(request, { provider: "verify-local", api: "openai-completions", model: "verify-model" }), true);
  assert.equal(matchesStreamRequest(request, { provider: "splash", api: "openai-completions", model: "verify-model" }), false);
  assert.equal(matchesStreamRequest(request, { provider: "verify-local", api: "openai-responses", model: "verify-model" }), false);
  assert.equal(matchesStreamRequest(request, { provider: "verify-local", api: "openai-completions", model: "other" }), false);
});
