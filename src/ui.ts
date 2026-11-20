/**
 * Working-message and widget ownership (SPECIFICATION.md sections 8.1, 8.3,
 * 10.3).
 *
 * The extension only touches its namespaced widget `pi-splash-stats` and
 * restores the working message only when it actually overrode it. Chat prefill
 * uses the working message; compaction/branch-summary prefill uses the
 * above-editor widget so Pi's own spinner (which occupies the working message)
 * is left untouched. Identical lines are not re-rendered; same-phase updates
 * coalesce to at most 10 per second while phase changes and cleanup render
 * immediately. UI API failures disable the affected display without affecting
 * inference.
 */

export const WIDGET_KEY = "pi-splash-stats";
export const COALESCE_MS = 100;

export interface UiAdapter {
  setWorkingMessage(message?: string): void;
  setWidget(key: string, content: string[] | undefined): void;
}

interface PendingRender {
  phase: "prefill" | "generation";
  line: string;
  /** "working" = chat prefill (working message); "widget" = summary prefill + generation. */
  target: "working" | "widget";
}

export class UiController {
  private readonly ui: UiAdapter;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: PendingRender | null = null;
  private lastWorking: string | null = null; // chat prefill (working message)
  private lastWidget: string | null = null; // summary prefill + generation (widget)
  private ownsWorkingMessage = false;
  private phase: "prefill" | "generation" | "none" = "none";
  private workingDisabled = false;
  private widgetDisabled = false;
  private disposed = false;

  constructor(ui: UiAdapter) {
    this.ui = ui;
  }

  /** Show/replace the chat prefill working-message line (null clears everything). */
  showPrefill(line: string | null): void {
    if (this.disposed) return;
    if (line === null) {
      this.clearAll();
      return;
    }
    if (this.workingDisabled || line === this.lastWorking) return;
    this.phase = "prefill";
    this.schedule({ phase: "prefill", line, target: "working" }, false);
  }

  /**
   * Show/replace the summary prefill line in the above-editor widget (null
   * clears everything). Used for compaction/branch phases, where Pi's own
   * spinner occupies the working message and must not be touched (SPEC 8.1).
   */
  showPrefillWidget(line: string | null): void {
    if (this.disposed) return;
    if (line === null) {
      this.clearAll();
      return;
    }
    if (this.widgetDisabled || line === this.lastWidget) return;
    this.phase = "prefill";
    this.schedule({ phase: "prefill", line, target: "widget" }, false);
  }

  /**
   * Show/replace the generation widget line. The prefill→generation phase
   * transition renders immediately; later same-phase updates coalesce within
   * the 100 ms bound (SPEC 10.3). For chat the transition also restores the
   * working message; for summaries it is a no-op (we never owned it).
   */
  showGeneration(line: string | null): void {
    if (this.disposed) return;
    if (line === null) {
      this.clearAll();
      return;
    }
    if (this.widgetDisabled || line === this.lastWidget) return;
    const transition = this.phase !== "generation";
    if (transition) {
      this.flushTimer();
      this.restoreWorkingMessage();
    }
    this.phase = "generation";
    this.schedule({ phase: "generation", line, target: "widget" }, transition);
  }

  /** Clear only this extension's owned UI (SPEC 8.3). */
  clearAll(): void {
    this.flushTimer();
    this.restoreWorkingMessage();
    if (this.lastWidget !== null && !this.widgetDisabled) {
      try {
        this.ui.setWidget(WIDGET_KEY, undefined);
      } catch {
        this.widgetDisabled = true;
      }
    }
    this.lastWorking = null;
    this.lastWidget = null;
    this.phase = "none";
  }

  /** Cancel timers; no event-loop handle may survive shutdown (SPEC 10.3). */
  dispose(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending = null;
    this.disposed = true;
  }

  private restoreWorkingMessage(): void {
    if (!this.ownsWorkingMessage) return;
    this.ownsWorkingMessage = false;
    try {
      this.ui.setWorkingMessage(undefined);
    } catch {
      // Working-message restore failed; do not retry against a broken UI.
    }
  }

  private schedule(render: PendingRender, immediate: boolean): void {
    if (this.timer !== null) {
      // Coalesce: at most one pending same-phase render within 100ms.
      this.pending = render;
      return;
    }
    this.pending = render;
    if (immediate) {
      this.flushTimer();
    } else {
      this.timer = setTimeout(() => this.flushTimer(), COALESCE_MS);
    }
  }

  private flushTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const render = this.pending;
    this.pending = null;
    if (!render) return;
    if (render.target === "working") {
      if (render.line === this.lastWorking) return;
      try {
        this.ui.setWorkingMessage(render.line);
        this.ownsWorkingMessage = true;
        this.lastWorking = render.line;
      } catch {
        this.workingDisabled = true;
      }
    } else {
      if (render.line === this.lastWidget) return;
      try {
        this.ui.setWidget(WIDGET_KEY, [render.line]);
        this.lastWidget = render.line;
      } catch {
        this.widgetDisabled = true;
      }
    }
  }
}
