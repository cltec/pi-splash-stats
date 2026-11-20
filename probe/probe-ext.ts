/**
 * S5a throwaway probe extension.
 *
 * Logs which Pi provider hooks fire, and per-event transport metadata ONLY:
 * hook name, model/provider/api ids, message count, HTTP status, and the raw
 * stream-event type. It NEVER logs prompt, payload, header, credential, or
 * stream content. Output goes to the file named by the PROBE_LOG env var.
 */
import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function log(entry: Record<string, unknown>) {
  const file = process.env.PROBE_LOG;
  if (!file) return;
  try {
    appendFileSync(file, JSON.stringify({ t: Date.now(), ...entry }) + "\n");
  } catch {
    // probe must never break the session
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("before_provider_headers", (event, _ctx) => {
    log({ hook: "before_provider_headers", headerCount: event ? Object.keys(event.headers ?? {}).length : null });
  });

  pi.on("before_provider_request", (event, _ctx) => {
    const payload = event?.payload as { messages?: unknown[] } | undefined;
    log({
      hook: "before_provider_request",
      messageCount: Array.isArray(payload?.messages) ? payload.messages.length : null,
    });
  });

  pi.on("after_provider_response", (event, _ctx) => {
    log({ hook: "after_provider_response", status: event?.status ?? null });
  });

  pi.on("provider_stream_event", (event, _ctx) => {
    const data = event?.data as { type?: string } | undefined;
    log({
      hook: "provider_stream_event",
      provider: event?.provider ?? null,
      api: event?.api ?? null,
      model: event?.model ?? null,
      dataType: data && typeof data === "object" ? data.type ?? "(no type field)" : typeof data,
    });
  });
}
