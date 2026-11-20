import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import extension from "../src/index.ts";

type Command = Parameters<ExtensionAPI["registerCommand"]>[1];

function register() {
  const commands = new Map<string, Command>();
  const messages: unknown[][] = [];
  // Deliberately partial fake: unexpected API use fails instead of being silently ignored.
  const pi = {
    registerCommand(name: string, command: Command) {
      assert.equal(commands.has(name), false, "command registered twice");
      commands.set(name, command);
    },
    sendMessage(...args: unknown[]) { messages.push(args); },
  } as unknown as ExtensionAPI;
  extension(pi);
  return { commands, messages };
}

test("registers one discoverable command with a description", () => {
  const { commands, messages } = register();
  assert.deepEqual([...commands.keys()], ["hello"]);
  assert.ok(commands.get("hello")!.description);
  assert.deepEqual(messages, []);
});

test("UI command notifies with formatted arguments and does not send a model message", async () => {
  const { commands, messages } = register();
  const notifications: unknown[][] = [];
  await commands.get("hello")!.handler("  Ada  ", {
    hasUI: true,
    ui: { notify: (...args: unknown[]) => notifications.push(args) },
  } as unknown as ExtensionCommandContext);
  assert.deepEqual(notifications, [["Hello, Ada!", "info"]]);
  assert.deepEqual(messages, []);
});

test("headless command emits a visible custom message without triggering a model turn", async () => {
  const { commands, messages } = register();
  // No ui property: any accidental UI call fails this test.
  await commands.get("hello")!.handler(" \t ", { hasUI: false } as ExtensionCommandContext);
  assert.deepEqual(messages, [[
    { customType: "template-greeting", content: "Hello, world!", display: true },
    { triggerTurn: false },
  ]]);
});
