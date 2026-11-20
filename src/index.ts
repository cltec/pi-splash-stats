/**
 * Pi adapter for pi-splash-stats (SPECIFICATION.md).
 *
 * Thin wiring only: TUI-mode gating, lifecycle, discovery, request
 * enrichment, stream observation, and UI ownership. All statistics math is
 * pure (identity, discovery, progress, format, transport, ui modules).
 *
 * In print, JSON, and RPC modes the extension performs no discovery, no
 * enrichment, and no UI of any kind (SPEC 8.4).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { DiscoveryCache, type AuthContext } from "./discovery.ts";
import { generationLine, prefillLine } from "./format.ts";
import { normalizeEndpoint } from "./identity.ts";
import {
  applyOutputChunk,
  applyTimings,
  applyUsage,
  applyProgress,
  createRequestState,
  estimateTokens,
  isOutputChunk,
  validateProgress,
  type RequestState,
} from "./progress.ts";
import { enrichPayload, isPlainObject, matchesStreamRequest } from "./transport.ts";
import { UiController } from "./ui.ts";

interface RuntimeState {
  /** Increments on every session_start; identifies the runtime/session. */
  runtimeGeneration: number;
  /** Increments on session_start and model_select; guards in-flight work. */
  selectionGeneration: number;
  /** The single active request, or null when none is in flight. */
  activeRequest: RequestState | null;
  /**
   * The request the turn/agent safety net may finalize (SPEC 9). Set when a
   * request starts; cleared on finalization or a generation bump, so a stale
   * boundary event never clears a newer active request.
   */
  armedRequest: RequestState | null;
  ui: UiController | null;
  discovery: DiscoveryCache;
  /** True after session_shutdown; the state is inert until a new session. */
  disposed: boolean;
}

function resolveAuth(ctx: ExtensionContext, model: { id: string; baseUrl?: string; headers?: Record<string, string> }): Promise<AuthContext> {
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
}

export default function extension(pi: ExtensionAPI): void {
  const state: RuntimeState = {
    runtimeGeneration: 0,
    selectionGeneration: 0,
    activeRequest: null,
    armedRequest: null,
    ui: null,
    discovery: new DiscoveryCache(),
    disposed: false,
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
      .ensure(model, () => resolveAuth(ctx, model as { id: string; baseUrl?: string; headers?: Record<string, string> }))
      .catch(() => false);
  };

  const clearOwnedUi = (): void => {
    state.ui?.clearAll();
  };

  /** Finalize exactly once and release UI ownership (SPEC 9). */
  const finalizeRequest = (request: RequestState): void => {
    if (request.finalized) return;
    request.finalized = true;
    if (state.activeRequest === request) state.activeRequest = null;
    clearOwnedUi();
    // This request is no longer a safety-net target (SPEC 9).
    if (state.armedRequest === request) state.armedRequest = null;
  };

  const isTui = (ctx: ExtensionContext): boolean => ctx.mode === "tui";

  pi.on("session_start", (event, ctx) => {
    if (!isTui(ctx)) return;
    // Session replacement/reload discards all results (SPEC 5.3/9).
    state.runtimeGeneration += 1;
    state.selectionGeneration += 1;
    state.activeRequest = null;
    state.armedRequest = null;
    clearOwnedUi(); // release UI owned by the previous session
    state.ui = null;
    state.disposed = false;
    // Fresh discovery cache per session: discard all identity results (SPEC 5.3/9).
    state.discovery.dispose();
    state.discovery = new DiscoveryCache();
    startDiscovery(ctx, ctx.model);
  });

  pi.on("model_select", (event, ctx) => {
    if (!isTui(ctx)) return;
    state.selectionGeneration += 1;
    if (state.activeRequest) finalizeRequest(state.activeRequest);
    state.armedRequest = null; // a generation bump invalidates the safety-net target
    clearOwnedUi();
    startDiscovery(ctx, event.model ?? ctx.model);
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (!isTui(ctx)) return;
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

  pi.on("provider_stream_event", (event, ctx) => {
    if (!isTui(ctx)) return;
    const request = state.activeRequest;
    if (!request || request.finalized) return;
    // Reject late chunks from an older runtime/selection (SPEC 9).
    if (request.runtimeGeneration !== state.runtimeGeneration) return;
    if (request.selectionGeneration !== state.selectionGeneration) return;
    if (!matchesStreamRequest(request, event)) return;
    if (!isPlainObject(event.data)) return;
    const data = event.data;
    const ui = ensureUi(ctx);
    if (!ui) return;

    if (data.prompt_progress !== undefined) {
      const sample = validateProgress(data.prompt_progress);
      if (sample) {
        const snap = applyProgress(request.prefill, sample);
        if (snap) {
          request.prefillSnap = snap;
          ui.showPrefill(prefillLine(snap));
        }
      }
    }

    if (isOutputChunk(data)) {
      applyOutputChunk(request.generation, data);
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
        ui.showGeneration(
          generationLine({
            count: estimateTokens(gen),
            exact: gen.exact !== null,
            rate: gen.genRate,
          }),
        );
      }
      finalizeRequest(request);
    } else if (request.generationStarted) {
      const gen = request.generation;
      ui.showGeneration(
        generationLine({
          count: estimateTokens(gen),
          exact: gen.exact !== null,
          rate: gen.genRate,
        }),
      );
    }
  });

  /**
   * Safety-net cleanup on turn_end/agent_settled (SPEC 9): finalize the armed
   * request only when it is still the active request (abrupt termination with
   * no final chunk). Never clear a newer active request; clear orphaned owned
   * UI only when no request is in flight.
   */
  const safetyNetCleanup = (ctx: ExtensionContext): void => {
    if (!isTui(ctx)) return;
    if (state.disposed) return;
    const request = state.activeRequest;
    if (request && state.armedRequest === request && !request.finalized) {
      finalizeRequest(request);
      return;
    }
    if (!state.activeRequest) clearOwnedUi();
  };

  pi.on("turn_end", (_event, ctx) => {
    safetyNetCleanup(ctx);
  });

  pi.on("agent_settled", (_event, ctx) => {
    safetyNetCleanup(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (!isTui(ctx)) {
      state.discovery.dispose();
      return;
    }
    state.disposed = true;
    state.activeRequest = null;
    state.armedRequest = null;
    clearOwnedUi();
    state.ui?.dispose();
    state.ui = null;
    state.discovery.dispose();
  });
}
