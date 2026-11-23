/**
 * Pi adapter for pi-splash-stats (SPECIFICATION.md).
 *
 * Thin wiring only: TUI-mode gating, lifecycle, discovery, request
 * enrichment, stream observation, and UI ownership. All statistics math is
 * pure (identity, discovery, progress, format, transport, ui,
 * fetch-observer modules).
 *
 * Chat requests use the provider hooks (`before_provider_request`,
 * `provider_stream_event`) as the source of truth. Compaction and
 * branch-summary requests do NOT fire those hooks (ADR 0002), so a scoped
 * global-fetch observer (src/fetch-observer.ts) observes and enriches them.
 * The observer passes chat traffic through untouched, so nothing is
 * double-counted.
 *
 * In print, JSON, and RPC modes the extension performs no discovery, no
 * enrichment, installs no observer, and no UI of any kind (SPEC 8.4).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { DiscoveryCache, type AuthContext } from "./discovery.ts";
import { generationLine, prefillLine } from "./format.ts";
import { normalizeEndpoint, type CandidateModel } from "./identity.ts";
import {
  applyOutputChunk,
  applyTimings,
  applyUsage,
  applyProgress,
  createRequestState,
  estimateTokens,
  estimateGenerationRate,
  isOutputChunk,
  validateProgress,
  type RequestState,
} from "./progress.ts";
import { enrichPayload, isPlainObject, matchesStreamRequest } from "./transport.ts";
import { installFetchObserver, baseUrlFromRequestUrl } from "./fetch-observer.ts";
import { UiController } from "./ui.ts";

/** The foreground operation that owns the display (SPEC 9, 10.2). */
type Phase = "chat" | "compaction" | "branch";

interface ModelLike {
  id: string;
  baseUrl?: string;
  headers?: Record<string, string>;
}

export default function extension(pi: ExtensionAPI, now: () => number = () => performance.now()): void {
  const state = {
    /** Increments on every session_start; identifies the runtime/session. */
    runtimeGeneration: 0,
    /** Increments on session_start and model_select; guards in-flight work. */
    selectionGeneration: 0,
    /** The single active chat request (provider hooks), or null. */
    activeRequest: null as RequestState | null,
    /** The request the turn/agent safety net may finalize (SPEC 9). */
    armedRequest: null as RequestState | null,
    /** The in-flight summary request (fetch observer), or null. */
    summaryRequest: null as RequestState | null,
    /** The foreground operation owning the display. */
    phase: "chat" as Phase,
    ui: null as UiController | null,
    discovery: new DiscoveryCache(),
    /** Dispose function for the installed fetch observer, or null. */
    observer: null as (() => void) | null,
    /** Current context (model, registry) for the observer's classification. */
    ctx: null as ExtensionContext | null,
    /** True after session_shutdown; the state is inert until a new session. */
    disposed: false,
  };

  const resolveAuth = (ctx: ExtensionContext, model: ModelLike): Promise<AuthContext> => {
    const registry = ctx.modelRegistry;
    if (!registry || typeof registry.getApiKeyAndHeaders !== "function") {
      return Promise.resolve({ apiKey: undefined, headers: model.headers });
    }
    return registry
      .getApiKeyAndHeaders(model as never)
      .then((auth) =>
        auth.ok
          ? { apiKey: auth.apiKey, headers: { ...(model.headers ?? {}), ...(auth.headers ?? {}) } }
          : { apiKey: undefined, headers: model.headers },
      )
      .catch(() => ({ apiKey: undefined, headers: model.headers }));
  };

  const ensureUi = (ctx: ExtensionContext): UiController | null => {
    if (ctx.mode !== "tui" || !ctx.ui) return null;
    if (!state.ui) {
      state.ui = new UiController({
        setWorkingMessage: (message) => ctx.ui.setWorkingMessage(message),
        setWidget: (key, content) => ctx.ui.setWidget(key, content),
      });
    }
    return state.ui;
  };

  const startDiscovery = (ctx: ExtensionContext, model: { api?: string; baseUrl?: string; id?: string } | undefined): void => {
    if (state.disposed || !model) return;
    void state.discovery
      .ensure(model, () => resolveAuth(ctx, model as ModelLike))
      .catch(() => false);
  };

  const clearOwnedUi = (): void => {
    state.ui?.clearAll();
  };

  const isTui = (ctx: ExtensionContext): boolean => ctx.mode === "tui";

  /** Finalize a chat request exactly once and release UI ownership (SPEC 9). */
  const finalizeRequest = (request: RequestState): void => {
    if (request.finalized) return;
    request.finalized = true;
    if (state.activeRequest === request) state.activeRequest = null;
    clearOwnedUi();
    if (state.armedRequest === request) state.armedRequest = null;
  };

  /** Finalize the in-flight summary request (if any) and clear its UI. */
  const finalizeSummaryRequest = (): void => {
    const request = state.summaryRequest;
    if (request && !request.finalized) request.finalized = true;
    state.summaryRequest = null;
    clearOwnedUi();
  };

  /**
   * Shared frame processing for chat (provider hook) and summary (fetch
   * observer) streams (SPEC 7). `widgetPrefill` selects the prefill surface:
   * the working message for chat, the above-editor widget for summaries
   * (SPEC 8.1). Returns true when the request's final data arrived.
   */
  const renderProgressFrame = (request: RequestState, data: Record<string, unknown>, widgetPrefill: boolean): boolean => {
    const ui = state.ui;
    if (!ui) return false;
    const nowMs = now();
    const showPrefill = (line: string | null): void => (widgetPrefill ? ui.showPrefillWidget(line) : ui.showPrefill(line));

    if (data.prompt_progress !== undefined) {
      const sample = validateProgress(data.prompt_progress);
      if (sample) {
        const snap = applyProgress(request.prefill, sample);
        if (snap) {
          request.prefillSnap = snap;
          showPrefill(prefillLine(snap));
        }
      }
    }

    if (isOutputChunk(data)) {
      applyOutputChunk(request.generation, data, nowMs);
      request.generationStarted = true;
    }

    const hasTimings = data.timings !== undefined;
    const hasUsage = data.usage !== undefined;
    let finished = false;
    if (Array.isArray(data.choices) && data.choices.length > 0) {
      const choice = data.choices[0];
      if (isPlainObject(choice) && choice.finish_reason !== null && choice.finish_reason !== undefined) {
        finished = true;
      }
    }
    if (hasTimings) applyTimings(request.generation, data.timings);
    if (hasUsage) applyUsage(request.generation, data.usage);

    if (hasTimings || hasUsage || finished) {
      // Final exact counts/rates may appear on the active line before cleanup.
      if (request.generationStarted) {
        const gen = request.generation;
        ui.showGeneration(generationLine({ count: estimateTokens(gen), exact: gen.exact !== null, rate: gen.genRate }));
      }
      return true;
    }
    if (request.generationStarted) {
      const gen = request.generation;
      ui.showGeneration(generationLine({ count: estimateTokens(gen), exact: gen.exact !== null, rate: estimateGenerationRate(gen, nowMs), rateExact: false }));
    }
    return false;
  };

  /**
   * Decide whether a fetch is an owned summary request (SPEC 10.2). Returns
   * the caller-owned RequestState (attribution) or null to pass through. The
   * summary is evaluated against the backend it actually uses (endpoint +
   * model via the identity/discovery modules) — chat's eligibility proof is
   * not reused.
   */
  const classifySummary = async (url: string, method: string, body: unknown): Promise<RequestState | null> => {
    if (state.disposed) return null;
    if (state.phase !== "compaction" && state.phase !== "branch") return null;
    if (method !== "POST") return null;
    if (!isPlainObject(body)) return null;
    const modelId = body.model;
    if (typeof modelId !== "string" || modelId === "") return null;
    const base = baseUrlFromRequestUrl(url);
    if (base === null) return null;
    const endpoint = normalizeEndpoint(base);
    if (endpoint === null) return null;
    const ctx = state.ctx;
    if (!ctx) return null;
    const candidate: CandidateModel = {
      api: "openai-completions",
      baseUrl: base,
      id: modelId,
      provider: ctx.model?.provider ?? "",
    };
    const owned = await state.discovery.ensure(candidate, () => resolveAuth(ctx, candidate));
    if (!owned) return null;
    const request = createRequestState(
      state.runtimeGeneration,
      state.selectionGeneration,
      endpoint,
      modelId,
      ctx.model?.provider ?? "",
      "openai-completions",
    );
    state.summaryRequest = request;
    return request;
  };

  /** Install at most one fetch observer per runtime (SPEC 10.2). */
  const installObserver = (): void => {
    if (state.observer !== null) return;
    state.observer = installFetchObserver<RequestState>({
      target: globalThis,
      classify: (url, method, body) => classifySummary(url, method, body),
      enrich: (body, attr) => enrichPayload(body, attr.modelId) ?? body,
      onFrame: (attr, frame) => {
        if (state.disposed || attr.finalized || !state.ui) return;
        const finished = renderProgressFrame(attr, frame, true);
        if (finished) finalizeSummaryRequest();
      },
      onFinalize: (attr) => {
        if (state.disposed) return;
        if (attr === state.summaryRequest) finalizeSummaryRequest();
      },
    });
  };

  pi.on("session_start", (_event, ctx) => {
    if (!isTui(ctx)) return;
    // Session replacement/reload discards all results (SPEC 5.3/9).
    state.runtimeGeneration += 1;
    state.selectionGeneration += 1;
    state.activeRequest = null;
    state.armedRequest = null;
    state.summaryRequest = null;
    state.phase = "chat";
    clearOwnedUi(); // release UI owned by the previous session
    state.ui = null;
    state.ctx = ctx;
    state.disposed = false;
    // Fresh discovery cache per session: discard all identity results (SPEC 5.3/9).
    state.discovery.dispose();
    state.discovery = new DiscoveryCache();
    startDiscovery(ctx, ctx.model);
    installObserver();
  });

  pi.on("model_select", (event, ctx) => {
    if (!isTui(ctx)) return;
    state.selectionGeneration += 1;
    state.ctx = ctx;
    if (state.activeRequest) finalizeRequest(state.activeRequest);
    state.armedRequest = null; // a generation bump invalidates the safety-net target
    finalizeSummaryRequest();
    clearOwnedUi();
    startDiscovery(ctx, event.model ?? ctx.model);
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (!isTui(ctx)) return;
    state.phase = "chat";
    const model = ctx.model;
    if (!model || model.api !== "openai-completions") return;
    const endpoint = normalizeEndpoint(model.baseUrl ?? "");
    if (!endpoint) return;
    const modelId = model.id;
    return state.discovery
      .ensure(model, () => resolveAuth(ctx, model))
      .then((verified) => {
        if (state.disposed || !verified) return;
        if (ctx.model?.id !== modelId) return; // selection changed while pending
        const enriched = enrichPayload(event.payload, modelId);
        if (!enriched) return;
        if (state.activeRequest) finalizeRequest(state.activeRequest);
        const request = createRequestState(state.runtimeGeneration, state.selectionGeneration, endpoint, modelId, model.provider, model.api);
        state.activeRequest = request;
        state.armedRequest = request; // this request owns the turn/agent safety net
        ensureUi(ctx);
        return enriched;
      })
      .catch(() => undefined);
  });

  // Stream attribution + progress (chat only; summaries use the fetch observer).
  pi.on("provider_stream_event", (event, ctx) => {
    if (!isTui(ctx)) return;
    const request = state.activeRequest;
    if (!request || request.finalized) return;
    if (state.phase !== "chat") return; // a summary owns the display
    // Reject late chunks from an older runtime/selection (SPEC 9).
    if (request.runtimeGeneration !== state.runtimeGeneration) return;
    if (request.selectionGeneration !== state.selectionGeneration) return;
    if (!matchesStreamRequest(request, event)) return;
    if (!isPlainObject(event.data)) return;
    const ui = ensureUi(ctx);
    if (!ui) return;
    const finished = renderProgressFrame(request, event.data, false);
    if (finished) finalizeRequest(request);
  });

  // --- Summary lifecycle (SPEC 9) -----------------------------------------
  // Compaction begins: the summary request will be observed by the fetch
  // observer. Show nothing until progress data arrives (SPEC 8.1).
  pi.on("session_before_compact", () => {
    if (state.disposed || !state.ctx) return;
    state.phase = "compaction";
    ensureUi(state.ctx);
  });

  // Compaction succeeded: clear the summary UI and reset the phase.
  pi.on("session_compact", () => {
    if (state.disposed) return;
    state.phase = "chat";
    finalizeSummaryRequest();
  });

  // Compaction failed/aborted: clear the summary UI and reset the phase.
  pi.on("session_compact_failed", () => {
    if (state.disposed) return;
    state.phase = "chat";
    finalizeSummaryRequest();
  });

  // Tree navigation: only a summary-requested navigation shows statistics.
  pi.on("session_before_tree", (event) => {
    if (state.disposed || !state.ctx) return;
    if (event.preparation?.userWantsSummary) {
      state.phase = "branch";
      ensureUi(state.ctx);
    }
  });

  // Tree navigation completed: clear the summary UI and reset the phase.
  pi.on("session_tree", () => {
    if (state.disposed) return;
    state.phase = "chat";
    finalizeSummaryRequest();
  });

  /**
   * Safety-net cleanup on turn_end/agent_settled (SPEC 9): finalize the armed
   * chat request only when it is still the active request (abrupt termination
   * with no final chunk). Never clear a summary's UI; clear orphaned owned UI
   * only in the chat phase when no request is in flight.
   */
  const safetyNetCleanup = (ctx: ExtensionContext): void => {
    if (!isTui(ctx) || state.disposed) return;
    const request = state.activeRequest;
    if (request && state.armedRequest === request && !request.finalized) {
      if (state.phase !== "chat") return;
      finalizeRequest(request);
      return;
    }
    if (!state.activeRequest && state.phase === "chat") clearOwnedUi();
  };
  pi.on("turn_end", (_event, ctx) => safetyNetCleanup(ctx));
  pi.on("agent_settled", (_event, ctx) => safetyNetCleanup(ctx));

  pi.on("session_shutdown", (_event, ctx) => {
    if (!isTui(ctx)) {
      state.discovery.dispose();
      return;
    }
    state.disposed = true;
    state.activeRequest = null;
    state.armedRequest = null;
    state.summaryRequest = null;
    state.phase = "chat";
    clearOwnedUi();
    // Remove the fetch observer (restores the global fetch only if it is ours).
    if (state.observer !== null) {
      state.observer();
      state.observer = null;
    }
    state.ui?.dispose();
    state.ui = null;
    state.discovery.dispose();
  });
}
