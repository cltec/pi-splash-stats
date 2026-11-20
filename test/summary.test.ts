import assert from "node:assert/strict";
import test from "node:test";
import { renderSummary } from "../scripts/summarize-e2e.mjs";

test("missing smoke evidence never claims success", () => {
  assert.match(renderSummary(null), /Compatibility is unproven/);
});

test("summary renders known safe fields and excludes raw errors and protocol data", () => {
  const summary = renderSummary({
    schemaVersion: 1, outcome: "fail", nodeVersion: "22.22.3", piVersion: "1.5.2", cleanup: "clean",
    raw: "private transcript", checks: [{ name: "checkout", status: "fail", cleanup: "clean",
      errorCategory: "command-missing", message: "private transcript" }],
  });
  assert.match(summary, /Node: 22\.22\.3/);
  assert.match(summary, /checkout \| fail \| command-missing \| clean/);
  assert.doesNotMatch(summary, /private transcript/);
});

test("unexpected artifact fields cannot inject markdown or HTML", () => {
  const summary = renderSummary({ schemaVersion: 1, outcome: "pass", nodeVersion: "<secret>",
    checks: [{ name: "</code>|\nsecret", status: "injected", cleanup: "bad", errorCategory: "<secret>" }] });
  assert.doesNotMatch(summary, /secret|injected|<|>/);
  assert.match(summary, /unavailable/);
  assert.throws(() => renderSummary({ schemaVersion: 2, checks: [] }));
});
