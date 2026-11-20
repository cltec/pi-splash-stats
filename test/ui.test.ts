import assert from "node:assert/strict";
import test from "node:test";

import { COALESCE_MS, UiController, WIDGET_KEY } from "../src/ui.ts";

function makeUi() {
  const calls: { method: string; args: unknown[] }[] = [];
  const ui = {
    calls,
    adapter: {
      setWorkingMessage(message?: string) {
        calls.push({ method: "working", args: [message] });
      },
      setWidget(key: string, content: string[] | undefined) {
        calls.push({ method: "widget", args: [key, content] });
      },
    },
  };
  return ui;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("identical lines are rendered once (dedupe)", async () => {
  const { adapter, calls } = makeUi();
  const controller = new UiController(adapter);
  controller.showGeneration("Generating... ≈6 tok");
  controller.showGeneration("Generating... ≈6 tok");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { method: "widget", args: [WIDGET_KEY, ["Generating... ≈6 tok"]] });
  controller.dispose();
});

test("same-phase updates coalesce to at most one render per 100ms window", async () => {
  const { adapter, calls } = makeUi();
  const controller = new UiController(adapter);
  controller.showPrefill("Prefilling... 10%");
  controller.showPrefill("Prefilling... 20%");
  controller.showPrefill("Prefilling... 30%");
  assert.equal(calls.length, 0); // nothing rendered before the coalesce window
  await sleep(COALESCE_MS + 30);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { method: "working", args: ["Prefilling... 30%"] });
  controller.dispose();
});

test("phase change restores the working message immediately and renders the widget immediately", async () => {
  const { adapter, calls } = makeUi();
  const controller = new UiController(adapter);
  controller.showPrefill("Prefilling... 50%");
  await sleep(COALESCE_MS + 30);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "working");
  controller.showGeneration("Generating... ≈2 tok");
  // Both the restore and the widget render synchronously.
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[1], { method: "working", args: [undefined] });
  assert.deepEqual(calls[2], { method: "widget", args: [WIDGET_KEY, ["Generating... ≈2 tok"]] });
  controller.dispose();
});

test("clearAll restores the working message only when this extension overrode it", async () => {
  const untouched = makeUi();
  const untouchedController = new UiController(untouched.adapter);
  untouchedController.clearAll();
  assert.equal(untouched.calls.length, 0);
  untouchedController.dispose();

  const { adapter, calls } = makeUi();
  const controller = new UiController(adapter);
  controller.showPrefill("Prefilling... 10%");
  await sleep(COALESCE_MS + 30);
  controller.clearAll();
  const methods = calls.map((c) => c.method);
  assert.deepEqual(methods, ["working", "working"]);
  assert.deepEqual(calls[1], { method: "working", args: [undefined] });
  controller.dispose();
});

test("clearAll clears only the namespaced widget", async () => {
  const { adapter, calls } = makeUi();
  const controller = new UiController(adapter);
  controller.showGeneration("Generating... ≈6 tok");
  controller.clearAll();
  const widgets = calls.filter((c) => c.method === "widget");
  assert.equal(widgets.length, 2);
  assert.deepEqual(widgets[1], { method: "widget", args: [WIDGET_KEY, undefined] });
  controller.dispose();
});

test("dispose cancels pending timers; no render survives shutdown", async () => {
  const { adapter, calls } = makeUi();
  const controller = new UiController(adapter);
  controller.showPrefill("Prefilling... 10%");
  controller.dispose();
  await sleep(COALESCE_MS + 30);
  assert.equal(calls.length, 0);
});

test("cleanup renders immediately even with a pending coalesced update", async () => {
  const { adapter, calls } = makeUi();
  const controller = new UiController(adapter);
  controller.showPrefill("Prefilling... 10%");
  controller.clearAll(); // the pending line flushes, then the working message is restored
  const methods = calls.map((c) => c.method);
  assert.deepEqual(methods, ["working", "working"]);
  assert.deepEqual(calls[1], { method: "working", args: [undefined] });
  await sleep(COALESCE_MS + 30);
  assert.equal(calls.length, 2); // nothing further
  controller.dispose();
});

test("a throwing UI API disables the affected display without throwing", async () => {
  const calls: string[] = [];
  const controller = new UiController({
    setWorkingMessage(message?: string) {
      calls.push("working:" + message);
      throw new Error("terminal gone");
    },
    setWidget() {
      calls.push("widget");
    },
  });
  controller.showPrefill("Prefilling... 10%");
  await new Promise((resolve) => setTimeout(resolve, COALESCE_MS + 30));
  // No throw escaped; further prefill updates are disabled, widget still works.
  controller.showGeneration("Generating... ≈1 tok");
  assert.equal(calls.filter((c) => c.startsWith("working")).length, 1);
  assert.equal(calls.includes("widget"), true);
  controller.clearAll();
  controller.dispose();
});
