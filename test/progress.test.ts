import assert from "node:assert/strict";
import test from "node:test";

import {
  applyOutputChunk,
  applyProgress,
  applyTimings,
  applyUsage,
  createGenerationState,
  createPrefillState,
  createRequestState,
  estimateTokens,
  isOutputChunk,
  MAX_RATE_SAMPLES,
  validateProgress,
} from "../src/progress.ts";

test("7.1 validation: finite non-negative integral tokens, no string coercion", () => {
  assert.deepEqual(validateProgress({ total: 100, cache: 20, processed: 60, time_ms: 0 }), {
    total: 100,
    cache: 20,
    processed: 60,
    timeMs: 0,
  });
  assert.equal(validateProgress({ total: "100", processed: 5, time_ms: 0 }), null);
  assert.equal(validateProgress({ total: 100, processed: 5.5, time_ms: 0 }), null);
  assert.equal(validateProgress({ total: -1, processed: 0, time_ms: 0 }), null);
  assert.equal(validateProgress({ total: 100, processed: 5, time_ms: -1 }), null);
  assert.equal(validateProgress({ total: 100, processed: 5, time_ms: Number.POSITIVE_INFINITY }), null);
  assert.equal(validateProgress({ total: 100, processed: 5, time_ms: "0" }), null);
  assert.equal(validateProgress(null), null);
  assert.equal(validateProgress("x"), null);
  assert.equal(validateProgress({ total: 100, time_ms: 0 }), null);
});

test("7.1 validation: ordering 0 <= C <= P <= T, unknown props ignored", () => {
  assert.equal(validateProgress({ total: 100, cache: 60, processed: 50, time_ms: 0 }), null);
  assert.equal(validateProgress({ total: 100, processed: 101, time_ms: 0 }), null);
  assert.equal(validateProgress({ total: 100, cache: -1, processed: 50, time_ms: 0 }), null);
  assert.deepEqual(
    validateProgress({ total: 100, cache: 20, processed: 60, time_ms: 0, future_field: 42 }),
    { total: 100, cache: 20, processed: 60, timeMs: 0 },
  );
});

test("7.2 cache-aware percent: cached tokens do not inflate work", () => {
  const state = createPrefillState();
  const snap = applyProgress(state, validateProgress({ total: 100, cache: 20, processed: 60, time_ms: 0 })!);
  assert.equal(snap!.percent, 50); // done 40 of work 80
});

test("7.2 uncached prompt", () => {
  const state = createPrefillState();
  const snap = applyProgress(state, validateProgress({ total: 100, cache: 0, processed: 25, time_ms: 0 })!);
  assert.equal(snap!.percent, 25);
});

test("7.2 fully cached and zero-work prompts: 100% without division by zero or invented rate", () => {
  const fully = createPrefillState();
  const snap = applyProgress(fully, validateProgress({ total: 100, cache: 100, processed: 100, time_ms: 0 })!);
  assert.equal(snap!.percent, 100);
  assert.equal(snap!.rate, null);
  assert.equal(snap!.etaMs, 0);

  const zero = createPrefillState();
  const zeroSnap = applyProgress(zero, validateProgress({ total: 0, cache: 0, processed: 0, time_ms: 0 })!);
  assert.equal(zeroSnap!.percent, 100);
  assert.equal(zeroSnap!.rate, null);
  assert.equal(zeroSnap!.etaMs, 0);
});

test("7.2 first event after actual work has started (explicit cache is authoritative)", () => {
  const state = createPrefillState();
  const snap = applyProgress(state, validateProgress({ total: 100, cache: 20, processed: 80, time_ms: 900 })!);
  assert.equal(snap!.percent, 75); // done 60 of 80, not 80%
});

test("7.2 missing cache: first valid processed is the conservative baseline, per request", () => {
  const state = createPrefillState();
  const first = applyProgress(state, validateProgress({ total: 100, processed: 30, time_ms: 0 })!);
  assert.equal(first!.percent, 0); // baseline 30, done 0 of 70
  const second = applyProgress(state, validateProgress({ total: 100, processed: 50, time_ms: 1000 })!);
  assert.ok(Math.abs(second!.percent - (20 / 70) * 100) < 1e-9);
  // A different request does not inherit the baseline.
  const other = createPrefillState();
  const otherSnap = applyProgress(other, validateProgress({ total: 100, processed: 50, time_ms: 1000 })!);
  assert.equal(otherSnap!.percent, 0);
});

test("7.2 regressing counters are ignored, percent never regresses", () => {
  const state = createPrefillState();
  applyProgress(state, validateProgress({ total: 100, cache: 20, processed: 60, time_ms: 0 })!);
  const regressed = applyProgress(state, validateProgress({ total: 100, cache: 20, processed: 40, time_ms: 500 })!);
  assert.equal(regressed, null);
  const after = applyProgress(state, validateProgress({ total: 100, cache: 20, processed: 70, time_ms: 600 })!);
  assert.equal(after!.percent, 62.5);
});

test("7.2 incompatible total or baseline drops rate continuity", () => {
  const state = createPrefillState();
  applyProgress(state, validateProgress({ total: 100, cache: 20, processed: 40, time_ms: 1000 })!);
  assert.equal(state.samples.length, 0); // first sample: no rate yet
  applyProgress(state, validateProgress({ total: 100, cache: 20, processed: 60, time_ms: 2000 })!);
  assert.equal(state.samples.length, 1);
  // Total changes incompatibly: continuity is dropped, not invented.
  const snap = applyProgress(state, validateProgress({ total: 200, cache: 20, processed: 80, time_ms: 4000 })!);
  assert.equal(state.samples.length, 0);
  // Only a freshly computed cumulative rate (60 done at 4s), never a carried one.
  assert.equal(snap!.rate, 15);
});

test("7.3 rate: mean of bounded samples, cumulative fallback, non-finite suppressed", () => {
  const state = createPrefillState();
  applyProgress(state, validateProgress({ total: 100, cache: 20, processed: 20, time_ms: 0 })!);
  applyProgress(state, validateProgress({ total: 100, cache: 20, processed: 40, time_ms: 1000 })!);
  const mid = applyProgress(state, validateProgress({ total: 100, cache: 20, processed: 60, time_ms: 2000 })!);
  assert.equal(mid!.rate, 20);
  assert.equal(mid!.etaMs, 2000); // 40 remaining at 20 tok/s

  const cumulative = createPrefillState();
  const cum = applyProgress(cumulative, validateProgress({ total: 100, cache: 0, processed: 40, time_ms: 2000 })!);
  assert.equal(cum!.rate, 20); // done*1000/time

  const noTime = createPrefillState();
  const noTimeSnap = applyProgress(noTime, validateProgress({ total: 100, cache: 0, processed: 40, time_ms: 0 })!);
  assert.equal(noTimeSnap!.rate, null); // no division by zero
});

test("7.3 sample buffer is bounded to 20 valid rates", () => {
  const state = createPrefillState();
  let sample = validateProgress({ total: 100000, cache: 0, processed: 0, time_ms: 0 })!;
  applyProgress(state, sample);
  for (let i = 1; i <= 25; i++) {
    sample = validateProgress({ total: 100000, cache: 0, processed: i * 100, time_ms: i * 1000 })!;
    applyProgress(state, sample);
  }
  assert.equal(state.samples.length, MAX_RATE_SAMPLES);
  assert.equal(state.samples.length, 20);
});

test("7.3 ETA: rounded, suppressed when non-finite or fabricated zero", () => {
  const state = createPrefillState();
  applyProgress(state, validateProgress({ total: 100, cache: 0, processed: 0, time_ms: 0 })!);
  const snap = applyProgress(state, validateProgress({ total: 100, cache: 0, processed: 99, time_ms: 1000 })!);
  // remaining 1 at 99 tok/s -> ~10ms: would render 0s, so suppressed.
  assert.equal(snap!.etaMs, null);
  assert.equal(snap!.percent, 99);
});

test("7.4 estimates: max(chunks, round(chars/6)); role-only and keepalives never count", () => {
  const gen = createGenerationState();
  assert.equal(isOutputChunk({ choices: [{ delta: { role: "assistant", content: "" } }] }), false);
  applyOutputChunk(gen, { choices: [{ delta: { role: "assistant", content: "" } }] });
  applyOutputChunk(gen, { choices: [{ delta: {} }] });
  assert.equal(gen.chunks, 0);
  assert.equal(gen.chars, 0);

  applyOutputChunk(gen, { choices: [{ delta: { content: "Verification " } }] });
  applyOutputChunk(gen, { choices: [{ delta: { content: "response " } }] });
  applyOutputChunk(gen, { choices: [{ delta: { content: "complete." } }] });
  assert.equal(gen.chunks, 3);
  assert.equal(gen.chars, 31);
  assert.equal(estimateTokens(gen), Math.max(3, Math.round(32 / 6)));
});

test("7.4 reasoning counts; tool fragments count once per chunk and are never retained", () => {
  const gen = createGenerationState();
  applyOutputChunk(gen, { choices: [{ delta: { reasoning_content: "thinking hard " } }] });
  assert.equal(gen.chunks, 1);
  assert.equal(gen.chars, 14);
  applyOutputChunk(gen, {
    choices: [{ delta: { tool_calls: [{ function: { arguments: "ab" } }, { function: { arguments: "cd" } }] } }],
  });
  assert.equal(gen.chunks, 2);
  assert.equal(gen.chars, 14 + 4);
  // Nothing textual is retained.
  assert.equal((gen as { retained?: unknown }).retained, undefined);
  assert.equal("content" in gen, false);
});

test("7.4 a chunk with multiple output fields counts once", () => {
  const gen = createGenerationState();
  applyOutputChunk(gen, { choices: [{ delta: { content: "abc", reasoning_content: "def" } }] });
  assert.equal(gen.chunks, 1);
  assert.equal(gen.chars, 6);
});

test("7.4 exact replacement: usage.completion_tokens wins over timings.predicted_n", () => {
  const gen = createGenerationState();
  applyOutputChunk(gen, { choices: [{ delta: { content: "x" } }] });
  applyTimings(gen, { predicted_n: 9, predicted_per_second: 82.4, prompt_per_second: 20.0 });
  assert.equal(estimateTokens(gen), 9);
  applyUsage(gen, { completion_tokens: 7, prompt_tokens: 100, total_tokens: 107 });
  assert.equal(estimateTokens(gen), 7);
});

test("7.4 missing usage falls back to predicted_n; malformed exact fields are ignored", () => {
  const gen = createGenerationState();
  applyUsage(gen, { completion_tokens: "7" });
  assert.equal(gen.exact, null);
  applyTimings(gen, { predicted_n: "9" });
  assert.equal(gen.exact, null);
  applyTimings(gen, { predicted_n: 9 });
  assert.equal(estimateTokens(gen), 9);
});

test("7.5 authoritative rates come only from timings; zero rate means unavailable", () => {
  const gen = createGenerationState();
  assert.equal(gen.genRate, null);
  applyTimings(gen, { predicted_per_second: 0, prompt_per_second: 0 });
  assert.equal(gen.genRate, null);
  assert.equal(gen.promptRate, null);
  applyTimings(gen, { predicted_per_second: 82.4, prompt_per_second: 20.0 });
  assert.equal(gen.genRate, 82.4);
  assert.equal(gen.promptRate, 20);
  applyTimings(gen, { predicted_per_second: -5 });
  assert.equal(gen.genRate, 82.4); // invalid values never overwrite
});

test("7.5 chunk counts are never labeled exact", () => {
  const gen = createGenerationState();
  for (let i = 0; i < 5; i++) applyOutputChunk(gen, { choices: [{ delta: { content: "tok" } }] });
  assert.equal(gen.exact, null); // estimate only until final data
});

test("per-request state: unique ids and captured runtime/selection generations", () => {
  const a = createRequestState(1, 1, "http://h/v1", "m", "p", "openai-completions");
  const b = createRequestState(2, 2, "http://h/v1", "m", "p", "openai-completions");
  assert.notEqual(a.id, b.id);
  assert.equal(a.runtimeGeneration, 1);
  assert.equal(b.runtimeGeneration, 2);
  assert.equal(a.selectionGeneration, 1);
  assert.equal(b.selectionGeneration, 2);
  assert.equal(a.phase, "chat");
  assert.equal(a.finalized, false);
  // State is request-local: progress in one request never leaks into another.
  applyProgress(a.prefill, validateProgress({ total: 100, cache: 0, processed: 50, time_ms: 1000 })!);
  assert.equal(b.prefill.baseline, null);
});
