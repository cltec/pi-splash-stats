/**
 * Scoped global-fetch observer for owned summary inference (SPEC 10.2).
 *
 * Pi's provider hooks do not fire for compaction / branch-summary requests
 * (ADR 0002). This module wraps the global `fetch` to observe those SSE
 * responses: it enriches eligible summary requests and parses their streams
 * while forwarding bytes, order, status, headers, streaming, backpressure,
 * errors, and cancellation unchanged. Chat traffic is passed through
 * untouched — the provider hooks remain chat's source of truth, so nothing is
 * double-counted.
 *
 * The pure logic (SSE parsing, request-info extraction) is separated for
 * direct testing; `installFetchObserver` is the thin adapter that touches the
 * global fetch and response streams. No new runtime dependency is added.
 */

/** How an observed summary stream ended. */
export type FinalizeReason = "done" | "error" | "abort";

/** Maximum bytes for a pending SSE event before statistics are disabled (SPEC 10.2). */
export const MAX_EVENT_BYTES = 1024 * 1024;

/** The suffix that marks a chat-completions resource URL. */
export const CHAT_COMPLETIONS_SUFFIX = "/chat/completions";

export interface SSEParserOptions {
  /** Called with the assembled `data` payload of each complete event. */
  onEvent(data: string): void;
  /** Called once when the pending-event byte bound is exceeded. */
  onOverflow?(): void;
  /** Bound for a pending event, in bytes. Defaults to MAX_EVENT_BYTES. */
  maxEventBytes?: number;
}

export interface SSEParser {
  /** Feed a (possibly partial) chunk of the stream. */
  feed(chunk: Uint8Array): void;
  /** Flush any trailing frame that lacks a final newline. */
  flush(): void;
  /** True once statistics for this stream are disabled (overflow). */
  readonly disabled: boolean;
}

/**
 * Minimal SSE line/event parser (SPEC 10.2). Handles LF and CRLF line
 * endings, comment lines, multi-line `data` fields, and a per-pending-event
 * byte bound. On overflow it disables statistics; the caller keeps forwarding
 * the original bytes. Split multi-byte UTF-8 sequences are handled by a
 * streaming TextDecoder. Unknown fields (`event:`, `id:`, `retry:`) are
 * ignored. A stats-processing throw never escapes (SPEC 10.3).
 */
export function createSSEParser(options: SSEParserOptions): SSEParser {
  const maxEventBytes = options.maxEventBytes ?? MAX_EVENT_BYTES;
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];
  let disabled = false;

  const dataBytes = (): number => dataLines.reduce((n, line) => n + line.length, 0);

  function overflow(): void {
    if (disabled) return;
    disabled = true;
    buffer = "";
    dataLines = [];
    try {
      options.onOverflow?.();
    } catch {
      // Overflow reporting must not affect inference.
    }
  }

  function dispatch(): void {
    if (dataLines.length === 0) return;
    const data = dataLines.join("\n");
    dataLines = [];
    try {
      options.onEvent(data);
    } catch {
      // A stats-processing failure must not affect inference (SPEC 10.3).
    }
  }

  function processLine(line: string): void {
    if (disabled) return;
    if (line === "") {
      dispatch();
      return;
    }
    if (line.startsWith(":")) return; // comment
    const colon = line.indexOf(":");
    let field: string;
    let value: string;
    if (colon === -1) {
      field = line;
      value = "";
    } else {
      field = line.slice(0, colon);
      value = line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
    }
    if (field !== "data") return; // ignore event:, id:, retry:, unknown
    dataLines.push(value);
    if (dataBytes() > maxEventBytes) overflow();
  }

  function feed(chunk: Uint8Array): void {
    if (disabled) return;
    buffer += decoder.decode(chunk, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      let line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1); // CRLF
      processLine(line);
      if (disabled) return;
    }
    // After complete lines are processed, `buffer` holds the incomplete line.
    if (buffer.length > maxEventBytes) overflow();
  }

  function flush(): void {
    if (disabled) return;
    buffer += decoder.decode(); // final decoder flush
    if (buffer.length > 0) {
      let line = buffer;
      buffer = "";
      if (line.endsWith("\r")) line = line.slice(0, -1);
      processLine(line);
    }
    dispatch();
  }

  return {
    feed,
    flush,
    get disabled(): boolean {
      return disabled;
    },
  };
}

export interface RequestInfo {
  url: string | null;
  method: string;
  bodyText: string | null;
  /** True when the input form cannot be inspected/enriched safely. */
  passthrough: boolean;
}

/**
 * Extract (url, method, bodyText) from the fetch input forms actually used by
 * the supported Pi provider: a `string` or `URL` first argument with a string
 * `init.body` (the OpenAI SDK sends `fetch(URL, { body: "<json>" })`). The
 * `Request` form carries a streamed body that cannot be read without consuming
 * it, so it is explicitly passed through unchanged.
 */
export function extractRequestInfo(input: unknown, init?: RequestInit): RequestInfo {
  const method = (init?.method ?? "GET").toUpperCase();
  if (typeof input === "string") {
    return { url: input, method, bodyText: typeof init?.body === "string" ? init.body : null, passthrough: false };
  }
  if (input instanceof URL) {
    return { url: input.href, method, bodyText: typeof init?.body === "string" ? init.body : null, passthrough: false };
  }
  // Request form (or any other form): pass through unchanged.
  return { url: null, method, bodyText: null, passthrough: true };
}

/**
 * Derive the API base URL from a chat-completions request URL by stripping the
 * `/chat/completions` suffix. Returns null when the URL is not a
 * chat-completions resource (such requests are never owned summary traffic).
 */
export function baseUrlFromRequestUrl(url: string): string | null {
  if (!url.endsWith(CHAT_COMPLETIONS_SUFFIX)) return null;
  return url.slice(0, -CHAT_COMPLETIONS_SUFFIX.length);
}

export interface FetchObserverOptions<T> {
  /** The object whose `fetch` is wrapped (injectable for tests). */
  target: { fetch: typeof fetch };
  /**
   * Decide whether a request is an owned summary request worth observing.
   * Receives the extracted URL, HTTP method, and parsed JSON body. Returns
   * caller-owned attribution, or null to pass through. May be async (e.g. to
   * verify identity via discovery).
   */
  classify(url: string, method: string, body: unknown): T | null | Promise<T | null>;
  /** Enrich an eligible request body. Must return a new object (never mutate). */
  enrich?(body: Record<string, unknown>, attr: T): Record<string, unknown>;
  /** Called with each parsed SSE data frame (JSON object) of an observed stream. */
  onFrame?(attr: T, frame: Record<string, unknown>): void;
  /** Called exactly once when an observed stream ends. */
  onFinalize?(attr: T, reason: FinalizeReason): void;
}

function isPlainFrame(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Wrap `target.fetch` to observe owned summary requests (SPEC 10.2).
 *
 * - At most one active observer per runtime. The returned `dispose` restores
 *   the global fetch only if it still points to this wrapper; it never
 *   overwrites a wrapper installed later by another extension.
 * - After disposal the wrapper is inert: it delegates to the previous fetch,
 *   because SDK clients may retain old fetch references.
 * - Eligible requests are enriched (the body is replaced) and their SSE
 *   responses observed. Everything else passes through byte-for-byte.
 * - Observed responses preserve bytes, order, status, headers, streaming,
 *   backpressure, errors, and cancellation.
 */
export function installFetchObserver<T>(options: FetchObserverOptions<T>): () => void {
  const previous = options.target.fetch;
  let disposed = false;

  function finalize(attr: T, reason: FinalizeReason): void {
    try {
      options.onFinalize?.(attr, reason);
    } catch {
      // Finalize reporting must not affect inference.
    }
  }

  async function observe(responsePromise: Promise<Response>, attr: T): Promise<Response> {
    let response: Response;
    try {
      response = await responsePromise;
    } catch (err) {
      // The request failed; report, then propagate unchanged.
      finalize(attr, "error");
      throw err;
    }
    const originalBody = response.body;
    if (originalBody === null) {
      finalize(attr, "done");
      return response;
    }
    const reader = originalBody.getReader();
    let finalized = false;
    const end = (reason: FinalizeReason): void => {
      if (finalized) return;
      finalized = true;
      finalize(attr, reason);
    };
    const parser = createSSEParser({
      onEvent: (data: string) => {
        if (data === "[DONE]") return;
        let frame: unknown;
        try {
          frame = JSON.parse(data);
        } catch {
          return; // malformed data frame: ignore, bytes are still forwarded
        }
        if (isPlainFrame(frame)) {
          try {
            options.onFrame?.(attr, frame);
          } catch {
            // A stats-processing failure must not affect inference (SPEC 10.3).
          }
        }
      },
    });
    const newBody = new ReadableStream<Uint8Array>({
      async pull(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
        try {
          const { done, value } = await reader.read();
          if (done) {
            parser.flush();
            controller.close();
            end("done");
            return;
          }
          parser.feed(value);
          controller.enqueue(value); // forward bytes unchanged (order preserved)
        } catch (err) {
          end("error");
          controller.error(err); // propagate the read error
        }
      },
      cancel(reason?: unknown): Promise<void> {
        end("abort");
        return reader.cancel(reason as AbortReason | undefined);
      },
    });
    return new Response(newBody, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  async function handle(input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> {
    const info = extractRequestInfo(input, init);
    if (info.passthrough || info.url === null || info.bodyText === null) {
      return previous(input, init);
    }
    let body: unknown;
    try {
      body = JSON.parse(info.bodyText);
    } catch {
      return previous(input, init);
    }
    let attr: T | null;
    try {
      attr = await options.classify(info.url, info.method, body);
    } catch {
      return previous(input, init);
    }
    if (attr === null) return previous(input, init);
    const enriched = options.enrich
      ? options.enrich(body as Record<string, unknown>, attr)
      : (body as Record<string, unknown>);
    const newInit = { ...(init as Record<string, unknown> | undefined), body: JSON.stringify(enriched) };
    return observe(previous(input, newInit as RequestInit), attr);
  }

  const wrapper = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (disposed) return previous(input, init);
    return handle(input, init);
  }) as typeof fetch;

  options.target.fetch = wrapper;

  return function dispose(): void {
    if (disposed) return;
    disposed = true;
    if (options.target.fetch === wrapper) {
      options.target.fetch = previous;
    }
  };
}
