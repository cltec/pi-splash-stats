import assert from "node:assert/strict";
import test from "node:test";
import { formatGreeting } from "../src/greeting.ts";

for (const [input, expected] of [
  ["", "Hello, world!"],
  [" \t\n ", "Hello, world!"],
  ["Ada", "Hello, Ada!"],
  ["  Ada  ", "Hello, Ada!"],
  ["Ada Lovelace", "Hello, Ada Lovelace!"],
  ["李雷", "Hello, 李雷!"],
  ["O'Neil", "Hello, O'Neil!"],
]) {
  test(`greeting formats ${JSON.stringify(input)}`, () => {
    assert.equal(formatGreeting(input), expected);
  });
}
