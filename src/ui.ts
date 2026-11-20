/**
 * Working-message and widget ownership (SPECIFICATION.md sections 8.1, 8.3,
 * 10.3).
 *
 * The extension only touches its namespaced widget `pi-splash-stats` and
 * restores the working message only when it actually overrode it. Identical
 * lines are not re-rendered; same-phase updates coalesce to at most 10 per
 * second while phase changes and cleanup render immediately. UI API failures
 * disable the affected display without affecting inference.
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
}

export class UiController {
  private readonly ui: UiAdapter;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: PendingRender | null = null;
  private lastPrefill: string | null = null;
  private lastGeneration: string | null = null;
  private ownsWorkingMessage = false;
  private prefillDisabled = false;
  private generationDisabled = false;
  private disposed = false;

  constructor(ui: UiAdapter) {
    this.ui = ui;
  }

  /** Show/replace the prefill working-message line (null clears everything). */
  showPrefill(line: string | null): void {
    if (this.disposed) return;
    if (line === null) {
      this.clearAll();
      return;
    }
    if (this.prefillDisabled || line === this.lastPrefill) return;
    this.schedule({ phase: "prefill", line }, false);
  }

  /**
   * Show/replace the generation widget line. Phase changes restore the
   * working message immediately and render immediately.
   */
  showGeneration(line: string | null): void {
    if (this.disposed) return;
    if (line === null) {
      this.clearAll();
      return;
    }
    if (this.generationDisabled || line === this.lastGeneration) return;
    this.flushTimer();
    this.restoreWorkingMessage();
    this.schedule({ phase: "generation", line }, true);
  }

  /** Clear only this extension's owned UI (SPEC 8.3). */
  clearAll(): void {
    this.flushTimer();
    this.restoreWorkingMessage();
    if (this.lastGeneration !== null && !this.generationDisabled) {
      try {
        this.ui.setWidget(WIDGET_KEY, undefined);
      } catch {
        this.generationDisabled = true;
      }
    }
    this.lastPrefill = null;
    this.lastGeneration = null;
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
    if (render.phase === "prefill") {
      if (render.line === this.lastPrefill) return;
      try {
        this.ui.setWorkingMessage(render.line);
        this.ownsWorkingMessage = true;
        this.lastPrefill = render.line;
      } catch {
        this.prefillDisabled = true;
      }
    } else {
      if (render.line === this.lastGeneration) return;
      try {
        this.ui.setWidget(WIDGET_KEY, [render.line]);
        this.lastGeneration = render.line;
      } catch {
        this.generationDisabled = true;
      }
    }
  }
}
