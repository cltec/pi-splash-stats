/**
 * Pure statistics math (SPECIFICATION.md section 7) and per-request state.
 *
 * No I/O, no timers, no Pi imports. Every validator rejects malformed input
 * rather than coercing it, and every derived value is finite or null.
 */

function isNonNegativeIntegral(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Section 7.1: validated `prompt_progress` sample. */
export interface ProgressSample {
  total: number;
  /** Explicit cache field; null when the update omitted it. */
  cache: number | null;
  processed: number;
  timeMs: number;
}

/**
 * Validate a `prompt_progress` object. Finite, non-negative, integral token
 * counts; `time_ms` finite non-negative. Strings and other types are
 * rejected, never coerced. Unknown properties are ignored.
 */
export function validateProgress(raw: unknown): ProgressSample | null {
  if (typeof raw !== "object" || raw === null) return null;
  const sample = raw as Record<string, unknown>;
  if (!isNonNegativeIntegral(sample.total)) return null;
  if (!isNonNegativeIntegral(sample.processed)) return null;
  if (sample.cache !== undefined && !isNonNegativeIntegral(sample.cache)) return null;
  if (!isFiniteNonNegative(sample.time_ms)) return null;
  const cache = sample.cache as number | undefined;
  if (sample.processed > sample.total) return null;
  if (cache !== undefined && cache > sample.processed) return null;
  return {
    total: sample.total,
    cache: cache === undefined ? null : cache,
    processed: sample.processed,
    timeMs: sample.time_ms,
  };
}

/** Bounded prefill rate/ETA state for one request (SPEC 7.2-7.3). */
export interface PrefillState {
  /** Established cached prefix: explicit `cache`, else first processed. */
  baseline: number | null;
  total: number | null;
  lastDone: number | null;
  lastTime: number | null;
  /** At most 20 valid rate samples (tokens/second). */
  samples: number[];
  maxPercent: number | null;
}

export const MAX_RATE_SAMPLES = 20;

export function createPrefillState(): PrefillState {
  return { baseline: null, total: null, lastDone: null, lastTime: null, samples: [], maxPercent: null };
}

export interface PrefillSnapshot {
  percent: number;
  /** Mean rate in tokens/second, or null when unavailable. */
  rate: number | null;
  /** Estimated remaining milliseconds, 0 at completion, null when unavailable. */
  etaMs: number | null;
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  const sum = values.reduce((a, b) => a + b, 0);
  const result = sum / values.length;
  return Number.isFinite(result) && result > 0 ? result : null;
}

/**
 * Section 7.2/7.3: fold one validated sample into prefill state.
 *
 * Returns null when the sample must be ignored (regressing counters) so the
 * previous display survives. Incompatible total/baseline changes drop rate
 * continuity rather than inventing it.
 */
export function applyProgress(state: PrefillState, sample: ProgressSample): PrefillSnapshot | null {
  if (sample.cache !== null) {
    if (state.baseline !== null && state.baseline !== sample.cache) {
      // Baseline changed incompatibly: drop rate/ETA continuity.
      state.samples = [];
      state.lastDone = null;
      state.lastTime = null;
    }
    state.baseline = sample.cache;
  } else if (state.baseline === null) {
    // Legacy update without cache: first valid processed is the baseline.
    state.baseline = sample.processed;
  }

  if (state.total !== null && state.total !== sample.total) {
    state.samples = [];
    state.lastDone = null;
    state.lastTime = null;
  }
  state.total = sample.total;

  const work = Math.max(0, sample.total - (state.baseline ?? 0));
  const done = Math.min(Math.max(sample.processed - (state.baseline ?? 0), 0), work);
  if (state.lastDone !== null && done < state.lastDone) return null;

  if (state.lastTime !== null && state.lastDone !== null) {
    if (sample.timeMs > state.lastTime && done > state.lastDone) {
      const rate = ((done - state.lastDone) * 1000) / (sample.timeMs - state.lastTime);
      if (Number.isFinite(rate) && rate > 0) {
        state.samples.push(rate);
        if (state.samples.length > MAX_RATE_SAMPLES) state.samples.shift();
      }
    }
    state.lastDone = done;
    state.lastTime = sample.timeMs;
  } else {
    state.lastDone = done;
    state.lastTime = sample.timeMs;
  }

  const rawPercent = work > 0 ? (100 * done) / work : 100;
  const percent = Math.min(
    100,
    Math.max(0, Math.max(rawPercent, state.maxPercent ?? 0)),
  );
  state.maxPercent = percent;

  const rate =
    mean(state.samples) ??
    (done > 0 && sample.timeMs > 0
      ? Number.isFinite((done * 1000) / sample.timeMs)
        ? (done * 1000) / sample.timeMs
        : null
      : null);

  const remaining = work - done;
  let etaMs: number | null;
  if (remaining <= 0) {
    etaMs = 0;
  } else if (rate === null) {
    etaMs = null;
  } else {
    const candidate = (remaining / rate) * 1000;
    // Never display a fabricated 0s prediction while work remains.
    etaMs = Number.isFinite(candidate) && candidate >= 500 ? candidate : null;
  }

  return { percent, rate, etaMs };
}

/** Section 7.4: approximate generated-output state for one request. */
export interface GenerationState {
  /** Nonempty output chunks (text, reasoning, or tool fragments). */
  chunks: number;
  firstOutputMs: number | null;
  firstOutputEstimate: number;
  /** Output characters (text + reasoning + tool argument fragments). */
  chars: number;
  /** Exact final count: usage.completion_tokens, else timings.predicted_n. */
  exact: number | null;
  /** Authoritative final generation rate (timings only), null = unavailable. */
  genRate: number | null;
  /** Authoritative final prompt rate (timings only), null = unavailable. */
  promptRate: number | null;
}

export function createGenerationState(): GenerationState {
  return { chunks: 0, chars: 0, firstOutputMs: null, firstOutputEstimate: 0, exact: null, genRate: null, promptRate: null };
}

function chunkFields(data: Record<string, unknown>): {
  content: string;
  reasoning: string;
  toolChars: number;
} | null {
  const choices = data.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const choice = choices[0];
  if (typeof choice !== "object" || choice === null) return null;
  const delta = (choice as Record<string, unknown>).delta;
  if (typeof delta !== "object" || delta === null) return null;
  const d = delta as Record<string, unknown>;
  const content = typeof d.content === "string" ? d.content : "";
  const reasoning = typeof d.reasoning_content === "string" ? d.reasoning_content : "";
  let toolChars = 0;
  if (Array.isArray(d.tool_calls)) {
    for (const call of d.tool_calls) {
      if (typeof call !== "object" || call === null) continue;
      const fn = (call as Record<string, unknown>).function;
      if (typeof fn === "object" && fn !== null) {
        const args = (fn as Record<string, unknown>).arguments;
        if (typeof args === "string") toolChars += args.length;
      }
    }
  }
  return { content, reasoning, toolChars };
}

/** True when the chunk carries generated output (not role-only/keepalive). */
export function isOutputChunk(data: unknown): boolean {
  if (typeof data !== "object" || data === null) return false;
  const fields = chunkFields(data as Record<string, unknown>);
  if (!fields) return false;
  return fields.content.length > 0 || fields.reasoning.length > 0 || fields.toolChars > 0;
}

/**
 * Section 7.4: count one output chunk once, text and reasoning characters;
 * tool fragments count but are never retained.
 */
export function applyOutputChunk(state: GenerationState, data: unknown, nowMs: number = NaN): void {
  if (typeof data !== "object" || data === null) return;
  const fields = chunkFields(data as Record<string, unknown>);
  if (!fields) return;
  if (fields.content.length === 0 && fields.reasoning.length === 0 && fields.toolChars === 0) return;
  state.chunks += 1;
  state.chars += fields.content.length + fields.reasoning.length + fields.toolChars;
  if (state.chunks === 1) {
    state.firstOutputMs = Number.isFinite(nowMs) ? nowMs : null;
    state.firstOutputEstimate = Math.max(state.chunks, Math.round(state.chars / 6));
  }
}

/** Cumulative unsmoothed estimate, excluding TTFT and the entire first batch. */
export function estimateGenerationRate(state: GenerationState, nowMs: number): number | null {
  if (state.firstOutputMs === null || state.chunks < 2 || !Number.isFinite(nowMs)) return null;
  const elapsed = nowMs - state.firstOutputMs;
  if (elapsed < 500) return null;
  const delta = Math.max(state.chunks, Math.round(state.chars / 6)) - state.firstOutputEstimate;
  const rate = delta * 1000 / elapsed;
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

/** Estimated tokens until exact final data arrives (SPEC 7.4). */
export function estimateTokens(state: GenerationState): number {
  if (state.exact !== null) return state.exact;
  return Math.max(state.chunks, Math.round(state.chars / 6));
}

/** Exact count from a `usage` object; usage wins over timings. */
export function applyUsage(state: GenerationState, usage: unknown): void {
  if (typeof usage !== "object" || usage === null) return;
  const tokens = (usage as Record<string, unknown>).completion_tokens;
  if (isNonNegativeIntegral(tokens)) state.exact = tokens;
}

/**
 * Section 7.5: authoritative final data from `timings`. Zero rates mean
 * unavailable, never measured zero-speed generation.
 */
export function applyTimings(state: GenerationState, timings: unknown): void {
  if (typeof timings !== "object" || timings === null) return;
  const t = timings as Record<string, unknown>;
  if (isNonNegativeIntegral(t.predicted_n) && state.exact === null) state.exact = t.predicted_n;
  if ("predicted_per_second" in t) {
    state.genRate = isFiniteNonNegative(t.predicted_per_second) && t.predicted_per_second > 0 ? t.predicted_per_second : null;
  }
  if (isFiniteNonNegative(t.prompt_per_second) && t.prompt_per_second > 0) {
    state.promptRate = t.prompt_per_second;
  }
}

/**
 * Per-request statistics state (SPEC 9): a unique id plus the runtime/session
 * and selection generations captured at request start, so late, stale, or
 * cross-runtime work can be rejected.
 */
let requestCounter = 0;

export interface RequestState {
  id: number;
  /** Runtime/session generation captured at request start (SPEC 9). */
  runtimeGeneration: number;
  /** Selection generation captured at request start (SPEC 9). */
  selectionGeneration: number;
  endpoint: string;
  modelId: string;
  provider: string;
  api: string;
  phase: "chat";
  prefill: PrefillState;
  prefillSnap: PrefillSnapshot | null;
  generation: GenerationState;
  generationStarted: boolean;
  finalized: boolean;
}

export function createRequestState(
  runtimeGeneration: number,
  selectionGeneration: number,
  endpoint: string,
  modelId: string,
  provider: string,
  api: string,
): RequestState {
  requestCounter += 1;
  return {
    id: requestCounter,
    runtimeGeneration,
    selectionGeneration,
    endpoint,
    modelId,
    provider,
    api,
    phase: "chat",
    prefill: createPrefillState(),
    prefillSnap: null,
    generation: createGenerationState(),
    generationStarted: false,
    finalized: false,
  };
}
