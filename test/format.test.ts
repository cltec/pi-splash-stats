import assert from "node:assert/strict";
import test from "node:test";

import {
  BAR_CELLS,
  formatBar,
  formatCount,
  formatEta,
  formatRate,
  generationLine,
  prefillLine,
} from "../src/format.ts";

test("bar: 20 filled/empty cells, rounded, clamped", () => {
  assert.equal(formatBar(0), "░".repeat(20));
  assert.equal(formatBar(100), "█".repeat(20));
  assert.equal(formatBar(40), "█".repeat(8) + "░".repeat(12));
  assert.equal(formatBar(50), "█".repeat(10) + "░".repeat(10));
  assert.equal(formatBar(150).length, 20); // clamped
  assert.equal(formatBar(Number.NaN), "░".repeat(20));
  assert.equal(BAR_CELLS, 20);
});

test("counts: <1k integers, <10k one-decimal k, larger rounded k", () => {
  assert.equal(formatCount(0), "0");
  assert.equal(formatCount(999), "999");
  assert.equal(formatCount(1000), "1k");
  assert.equal(formatCount(1200), "1.2k");
  assert.equal(formatCount(9999), "10k");
  assert.equal(formatCount(12345), "12k");
  assert.equal(formatCount(Number.NaN), "0");
  assert.equal(formatCount(-3), "0");
});

test("rates: one decimal with tok/s; zero, negative, and non-finite are unavailable", () => {
  assert.equal(formatRate(82.4), "82.4 tok/s");
  assert.equal(formatRate(20), "20.0 tok/s");
  assert.equal(formatRate(0), null);
  assert.equal(formatRate(-1), null);
  assert.equal(formatRate(Number.POSITIVE_INFINITY), null);
  assert.equal(formatRate(Number.NaN), null);
  assert.equal(formatRate(null), null);
  assert.equal(formatRate(undefined), null);
});

test("ETA: seconds below a minute, minutes+seconds with carry above", () => {
  assert.equal(formatEta(30_000), "30s");
  assert.equal(formatEta(59_400), "59s");
  assert.equal(formatEta(60_000), "1m 0s");
  assert.equal(formatEta(90_000), "1m 30s");
  assert.equal(formatEta(125_000), "2m 5s");
  assert.equal(formatEta(null), null);
  assert.equal(formatEta(Number.NaN), null);
  assert.equal(formatEta(-1), null);
});

test("prefill line: segments drop with separators; phase alone when incomplete", () => {
  const full = prefillLine({ percent: 40, rate: 1234.5, etaMs: 30_000 });
  assert.equal(full, "Prefilling... " + "████████░░░░░░░░░░░░" + "  40% · 30s · 1234.5 tok/s");
  assert.equal(prefillLine({ percent: 40, rate: null, etaMs: null }), "Prefilling... " + "████████░░░░░░░░░░░░" + "  40%");
  assert.equal(prefillLine({ percent: null, rate: 12.3, etaMs: null }), "Prefilling... · 12.3 tok/s");
  assert.equal(prefillLine(null), "Prefilling...");
  for (const line of [full, prefillLine({ percent: 0, rate: null, etaMs: null })]) {
    assert.ok(!line.includes("NaN") && !line.includes("Infinity"));
  }
});

test("prefill line: narrow width drops ETA first, then shortens the bar", () => {
  const display = { percent: 40, rate: 1234.5, etaMs: 30_000 };
  const wide = prefillLine(display);
  assert.ok(wide.includes("30s"));
  // Width that fits without ETA but not with it.
  const noEta = prefillLine(display, wide.length - 4);
  assert.ok(!noEta.includes("30s"));
  assert.ok(noEta.includes("40%"));
  // Narrower: bar shortens, phase and percentage survive.
  const narrow = prefillLine(display, 28);
  assert.equal(narrow, "Prefilling... " + "██░░░░" + "  40%");
  assert.ok(narrow.length <= 28);
  assert.ok(narrow.startsWith("Prefilling..."));
  assert.ok(narrow.includes("40%"));
  assert.ok(!narrow.includes("30s"));
  // Below the minimum (phase + tiny bar + percent), the minimum line is kept.
  const tiny = prefillLine(display, 13);
  assert.equal(tiny, "Prefilling... " + "██░░░░" + "  40%");
  assert.ok(tiny.length <= 30);
});

test("generation line: approximate with ≈, exact without, rate segment optional", () => {
  assert.equal(generationLine({ count: 6, exact: false, rate: null }), "Generating... ≈6 tok");
  assert.equal(generationLine({ count: 1200, exact: false, rate: null }), "Generating... ≈1.2k tok");
  assert.equal(generationLine({ count: 7, exact: true, rate: 82.4 }), "Generating... 7 tok · 82.4 tok/s");
  assert.equal(generationLine({ count: 7, exact: true, rate: 0 }), "Generating... 7 tok");
  const narrow = generationLine({ count: 12345, exact: true, rate: 82.4 }, 21);
  assert.ok(narrow.length <= 21);
  assert.ok(narrow.includes("12k"));
});

test("no line ever contains NaN, Infinity, or a bare placeholder", () => {
  const lines = [
    prefillLine({ percent: 50, rate: Number.NaN, etaMs: Number.POSITIVE_INFINITY }),
    prefillLine({ percent: Number.NaN, rate: null, etaMs: null }),
    generationLine({ count: Number.NaN, exact: false, rate: Number.NaN }),
    generationLine({ count: 5, exact: true, rate: null }),
  ];
  for (const line of lines) {
    assert.ok(!/NaN|Infinity|undefined/.test(line), line);
  }
});
