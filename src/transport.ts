/**
 * Request eligibility, payload enrichment, and stream attribution
 * (SPECIFICATION.md sections 6 and 9).
 *
 * Enrichment is non-mutating: eligible payloads are replaced, never edited
 * in place. Anything malformed, non-streaming, or unmatched passes through
 * unchanged (null result).
 */

import type { RequestState } from "./progress.ts";

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Section 6: for a verified, owned, streaming JSON chat-completions request
 * to the exact model, return a replacement payload with
 * `return_progress: true` and `stream_options.include_usage: true`
 * (preserving other `stream_options`). Returns null when the payload must
 * pass through unchanged.
 */
export function enrichPayload(payload: unknown, modelId: string): Record<string, unknown> | null {
  if (!isPlainObject(payload)) return null;
  if (payload.stream !== true) return null;
  if (typeof payload.model !== "string" || payload.model !== modelId) return null;
  const streamOptions: Record<string, unknown> = isPlainObject(payload.stream_options)
    ? { ...payload.stream_options }
    : {};
  streamOptions.include_usage = true;
  return { ...payload, return_progress: true, stream_options: streamOptions };
}

/**
 * Stream attribution (SPEC 9): a raw stream event feeds an owned request
 * only when provider, api, and model all match.
 */
export function matchesStreamRequest(
  request: RequestState,
  event: { provider: string; api: string; model: string },
): boolean {
  return request.provider === event.provider && request.api === event.api && request.modelId === event.model;
}
