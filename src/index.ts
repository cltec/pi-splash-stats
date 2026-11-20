import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Pi adapter for pi-splash-stats.
 *
 * Walking skeleton: the extension intentionally registers no commands,
 * tools, messages, or startup notifications and produces no output in any
 * mode (TUI, RPC, print, or JSON). Statistics behavior is added by later
 * slices behind this thin adapter.
 */
export default function extension(_pi: ExtensionAPI): void {
  // Intentionally empty: no user-visible behavior.
}
