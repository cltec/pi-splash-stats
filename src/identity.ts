/**
 * Pure Splash identity rules (SPECIFICATION.md sections 5.1-5.4).
 *
 * No I/O, no Pi imports: URL normalization, discovery-candidate selection,
 * and identity-response validation. Discovery (src/discovery.ts) owns the
 * network behavior and response bounds.
 */

/** Maximum bytes for an identity response body (SPEC 5.3). */
export const MAX_RESPONSE_BYTES = 1024 * 1024;

/** OpenAI-style model list response shape. */
export interface IdentityEntry {
  id?: unknown;
  owned_by?: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Canonical endpoint identity for a configured base URL (SPEC 5.4).
 *
 * Preserves protocol, host, explicit port, path prefixes, query, and IPv6
 * syntax; strips only semantically insignificant trailing slashes. Returns
 * null for invalid URLs and non-HTTP(S) schemes.
 */
export function normalizeEndpoint(baseUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  let path = url.pathname;
  while (path.endsWith("/")) path = path.slice(0, -1);
  return url.origin + path + url.search;
}

/** The discovery URL for a canonical endpoint (SPEC 5.2). */
export function discoveryUrl(endpoint: string): string {
  return endpoint + "/models";
}

export interface CandidateModel {
  api?: string;
  baseUrl?: string;
  id?: string;
}

/**
 * Discovery candidate rule (SPEC 5.1): the selected configured
 * `openai-completions` model with a valid HTTP(S) base URL, regardless of
 * provider name, hostname, port, or launch method.
 */
export function isDiscoveryCandidate(model: CandidateModel): boolean {
  if (model.api !== "openai-completions") return false;
  return normalizeEndpoint(model.baseUrl ?? "") !== null;
}

/**
 * Positive identification (SPEC 5.2): successful JSON with an OpenAI-style
 * `data` array containing an object whose `id` exactly matches the requested
 * model and whose `owned_by` is exactly `"splash"`.
 */
export function validateIdentityResponse(body: unknown, modelId: string): boolean {
  if (!isPlainObject(body)) return false;
  if (!Array.isArray(body.data)) return false;
  return body.data.some((entry) => {
    if (!isPlainObject(entry)) return false;
    return entry.id === modelId && entry.owned_by === "splash";
  });
}
