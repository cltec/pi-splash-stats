/**
 * Bounded authenticated discovery (SPECIFICATION.md section 5.3).
 *
 * Total 2s deadline per attempt, in-flight dedupe per endpoint + auth
 * context, 60s positive / 5s negative cache, no redirects, 1 MiB response
 * bound, cancellation on dispose. Cache keys never contain secrets.
 */

import {
  discoveryUrl,
  isDiscoveryCandidate,
  MAX_RESPONSE_BYTES,
  normalizeEndpoint,
  validateIdentityResponse,
  type CandidateModel,
} from "./identity.ts";

export interface AuthContext {
  apiKey?: string;
  headers?: Record<string, string>;
}

/** Minimal response surface so tests can inject fakes. */
export interface DiscoveryResponse {
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type DiscoveryFetch = (
  url: string,
  init?: { method?: string; redirect?: string; signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<DiscoveryResponse>;

export interface DiscoveryOptions {
  fetchImpl?: DiscoveryFetch;
  now?: () => number;
  deadlineMs?: number;
  positiveTtlMs?: number;
  negativeTtlMs?: number;
}

interface CacheEntry {
  verified: boolean;
  expiresAt: number;
}

/**
 * Non-secret identity of an auth context (SPEC 5.3): key presence plus
 * sorted header names. Never stores raw secrets.
 */
export function authContextId(auth: AuthContext): string {
  const names = Object.keys(auth.headers ?? {}).sort().join(",");
  return (auth.apiKey ? "key" : "none") + ":" + names;
}

export class DiscoveryCache {
  private readonly fetchImpl: DiscoveryFetch;
  private readonly now: () => number;
  private readonly deadlineMs: number;
  private readonly positiveTtlMs: number;
  private readonly negativeTtlMs: number;
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<boolean>>();
  private readonly pending = new Set<AbortController>();
  private disposed = false;

  constructor(options: DiscoveryOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.now = options.now ?? Date.now;
    this.deadlineMs = options.deadlineMs ?? 2000;
    this.positiveTtlMs = options.positiveTtlMs ?? 60_000;
    this.negativeTtlMs = options.negativeTtlMs ?? 5_000;
  }

  /**
   * Verify that `model`'s endpoint serves the model as Splash-owned.
   * Resolves `true` only on a fresh or newly verified identity. Bounded by
   * the per-attempt deadline; cached and in-flight results are reused.
   */
  async ensure(model: CandidateModel, resolveAuth: () => Promise<AuthContext>): Promise<boolean> {
    if (this.disposed) return false;
    if (!isDiscoveryCandidate(model) || typeof model.id !== "string" || model.id === "") return false;
    const endpoint = normalizeEndpoint(model.baseUrl ?? "");
    if (!endpoint) return false;

    const started = this.now();
    let auth: AuthContext;
    try {
      auth = await resolveAuth();
    } catch {
      auth = { apiKey: undefined, headers: undefined };
    }
    if (this.disposed) return false;

    const key = endpoint + "|" + authContextId(auth);
    const entry = this.entries.get(key);
    if (entry && entry.expiresAt > this.now()) return entry.verified;
    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const remaining = this.deadlineMs - (this.now() - started);
    const attempt =
      remaining <= 0
        ? Promise.resolve(false)
        : this.attempt(endpoint, model.id, auth, remaining);
    this.inFlight.set(key, attempt);
    try {
      const verified = await attempt;
      if (!this.disposed) {
        this.entries.set(key, {
          verified,
          expiresAt: this.now() + (verified ? this.positiveTtlMs : this.negativeTtlMs),
        });
      }
      return verified;
    } finally {
      this.inFlight.delete(key);
    }
  }

  private async attempt(
    endpoint: string,
    modelId: string,
    auth: AuthContext,
    budgetMs: number,
  ): Promise<boolean> {
    const controller = new AbortController();
    this.pending.add(controller);
    const timer = setTimeout(() => controller.abort(), budgetMs);
    try {
      const headers: Record<string, string> = { ...(auth.headers ?? {}) };
      if (auth.apiKey) headers["Authorization"] = `Bearer ${auth.apiKey}`;
      const response = await this.fetchImpl(discoveryUrl(endpoint), {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers,
      });
      if (response.status >= 300 && response.status < 400) return false;
      if (!response.ok) return false;
      const declared = Number(response.headers?.get("content-length") ?? "");
      if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) return false;
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > MAX_RESPONSE_BYTES) return false;
      let body: unknown;
      try {
        body = JSON.parse(new TextDecoder().decode(buffer));
      } catch {
        return false;
      }
      return validateIdentityResponse(body, modelId);
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
      this.pending.delete(controller);
    }
  }

  /** Cancel in-flight probes and stop all further caching (SPEC 9). */
  dispose(): void {
    this.disposed = true;
    for (const controller of this.pending) controller.abort();
    this.pending.clear();
    this.inFlight.clear();
    this.entries.clear();
  }
}
