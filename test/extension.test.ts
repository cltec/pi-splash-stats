import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../src/index.ts";

function register() {
  const commands = new Map<string, unknown>();
  const messages: unknown[][] = [];
  const registrations: string[] = [];
  // Deliberately partial fake: any registration or messaging fails closed.
  const api = {
    registerCommand(name: string) {
      commands.set(name, true);
      registrations.push(`command:${name}`);
    },
    registerTool(name: string) {
      registrations.push(`tool:${name}`);
    },
    on(event: string) {
      registrations.push(`on:${event}`);
    },
    sendMessage(...args: unknown[]) { messages.push(args); },
  };
  extension(api as unknown as ExtensionAPI);
  return { commands, messages, registrations };
}

test("registers no commands, tools, event listeners, or startup messages", () => {
  const { commands, messages, registrations } = register();
  assert.deepEqual([...commands.keys()], []);
  assert.deepEqual(messages, []);
  assert.deepEqual(registrations, []);
});

test("repeated registration stays silent (reload does not accumulate state)", () => {
  for (let i = 0; i < 2; i++) {
    const { commands, messages, registrations } = register();
    assert.deepEqual([...commands.keys()], []);
    assert.deepEqual(messages, []);
    assert.deepEqual(registrations, []);
  }
});
