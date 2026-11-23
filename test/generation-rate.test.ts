import assert from "node:assert/strict";
import test from "node:test";
import { applyOutputChunk, createGenerationState, estimateGenerationRate, applyUsage, applyTimings } from "../src/progress.ts";
import { generationLine } from "../src/format.ts";
const chunk = (delta: object) => ({ choices: [{ delta }] });

test("live cumulative rate excludes TTFT and first batch, includes pauses, has a 500ms floor", () => {
  const s = createGenerationState();
  applyOutputChunk(s, chunk({ content: "x".repeat(60) }), 90000);
  assert.equal(estimateGenerationRate(s, 99999), null);
  applyOutputChunk(s, chunk({ reasoning_content: "x".repeat(30) }), 90499);
  assert.equal(estimateGenerationRate(s, 90499), null);
  assert.equal(estimateGenerationRate(s, 90500), 10);
  assert.equal(estimateGenerationRate(s, 91000), 5);
  applyOutputChunk(s, chunk({ tool_calls: [{ function: { name: "f", arguments: "xxxxx" } }] }), 92000);
  assert.equal(estimateGenerationRate(s, 92000), 3);
  for (const now of [NaN, Infinity, -1, 89999]) assert.equal(estimateGenerationRate(s, now), null);
  assert.equal(estimateGenerationRate(createGenerationState(), 99999), null);
});

test("rate omits nonpositive deltas and invalid initial clock; authoritative fields are independent", () => {
  const s = createGenerationState();
  applyOutputChunk(s, chunk({ content: "x".repeat(600) }), 0);
  applyOutputChunk(s, chunk({ content: "x" }), 500);
  assert.equal(estimateGenerationRate(s, 500), null);
  applyUsage(s, { completion_tokens: 4 });
  applyTimings(s, { predicted_per_second: 12 });
  assert.equal(s.exact, 4);
  assert.equal(s.genRate, 12);
  applyTimings(s, { predicted_per_second: 0 });
  assert.equal(s.genRate, null);
  const invalid = createGenerationState();
  applyOutputChunk(invalid, chunk({ content: "a" }), NaN);
  applyOutputChunk(invalid, chunk({ content: "b" }), 1000);
  assert.equal(estimateGenerationRate(invalid, 2000), null);
});

test("count and rate approximation markers are independent, with count-only width fallback", () => {
  assert.equal(generationLine({ count: 7, exact: false, rate: 10, rateExact: false }), "Generating... ≈7 tok · ≈10.0 tok/s");
  assert.equal(generationLine({ count: 7, exact: true, rate: 10, rateExact: false }), "Generating... 7 tok · ≈10.0 tok/s");
  assert.equal(generationLine({ count: 7, exact: false, rate: 10, rateExact: true }), "Generating... ≈7 tok · 10.0 tok/s");
  assert.equal(generationLine({ count: 7, exact: false, rate: 10, rateExact: false }, 25), "Generating... ≈7 tok");
});
