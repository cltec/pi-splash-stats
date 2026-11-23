/**
 * Pure compact-line formatting (SPECIFICATION.md section 8.2).
 *
 * 20-cell bar, rounded integer percent, one-decimal rates, s / m s ETA with
 * carry, compact counts, `≈` for estimates, missing segments dropped with
 * their separators, narrow-width adaptation (drop ETA, then shorten the
 * bar). Never emits NaN, Infinity, or unexplained placeholders.
 */

export const BAR_CELLS = 20;
export const NARROW_BAR_CELLS = 10;
export const TINY_BAR_CELLS = 6;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Counts: <1k integers, <10k one-decimal k, larger rounded k (SPEC 8.2). */
export function formatCount(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "0";
  if (value < 1000) return String(Math.round(value));
  if (value < 10000) {
    const k = Math.round((value / 1000) * 10) / 10;
    return (Number.isInteger(k) ? String(k) : k.toFixed(1)) + "k";
  }
  return Math.round(value / 1000) + "k";
}

/** Positive finite rates only; zero and non-finite are unavailable. */
export function formatRate(rate: number | null | undefined): string | null {
  if (rate === null || rate === undefined) return null;
  if (!Number.isFinite(rate) || rate <= 0) return null;
  return rate.toFixed(1) + " tok/s";
}

/** Rounded seconds below one minute; minutes and seconds with carry above. */
export function formatEta(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined) return null;
  if (!Number.isFinite(ms) || ms < 0) return null;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return seconds + "s";
  const minutes = Math.floor(seconds / 60);
  return minutes + "m " + (seconds % 60) + "s";
}

export function formatBar(percent: number, cells: number = BAR_CELLS): string {
  if (!Number.isFinite(percent)) return "░".repeat(cells);
  const filled = clamp(Math.round((percent / 100) * cells), 0, cells);
  return "█".repeat(filled) + "░".repeat(cells - filled);
}

export interface PrefillDisplay {
  percent: number | null;
  rate: number | null;
  etaMs: number | null;
}

/**
 * One transient prefill line. Missing segments drop with their separators;
 * a valid report without a percentage renders the phase alone. Narrow
 * widths drop the ETA first, then shorten the bar, keeping phase and the
 * primary percentage.
 */
export function prefillLine(display: PrefillDisplay | null, width: number = Number.MAX_SAFE_INTEGER): string {
  if (display === null) return "Prefilling...";
  const eta = formatEta(display.etaMs);
  const rate = formatRate(display.rate);
  const build = (cells: number, withEta: boolean, withRate: boolean): string => {
    let line = "Prefilling...";
    if (display.percent !== null && Number.isFinite(display.percent)) {
      line += " " + formatBar(clamp(display.percent, 0, 100), cells) + "  " + Math.round(clamp(display.percent, 0, 100)) + "%";
    }
    if (withEta && eta) line += " · " + eta;
    if (withRate && rate) line += " · " + rate;
    return line;
  };
  let line = build(BAR_CELLS, true, true);
  if (line.length > width) {
    line = build(BAR_CELLS, false, true);
    if (line.length > width) {
      line = build(NARROW_BAR_CELLS, false, true);
      if (line.length > width) {
        line = build(TINY_BAR_CELLS, false, true);
        if (line.length > width) line = build(TINY_BAR_CELLS, false, false);
      }
    }
  }
  return line;
}

export interface GenerationDisplay {
  count: number;
  /** True once an exact final count replaced the estimate. */
  exact: boolean;
  rate: number | null;
  rateExact?: boolean;
}

/** One transient generation line; estimates are marked with `≈`. */
export function generationLine(display: GenerationDisplay, width: number = Number.MAX_SAFE_INTEGER): string {
  const rate = formatRate(display.rate);
  const count = display.exact ? formatCount(display.count) : "≈" + formatCount(display.count);
  let line = "Generating... " + count + " tok";
  if (rate) line += " · " + (display.rateExact === false ? "≈" : "") + rate;
  if (line.length > width && rate) line = "Generating... " + count + " tok";
  return line;
}
