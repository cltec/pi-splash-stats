import assert from "node:assert/strict";
import test from "node:test";
import { allowedPackagePath, verifyPack } from "../scripts/check-package.mjs";

const manifest = { name: "example-extension", version: "0.1.0", pi: { extensions: ["./src/index.ts"] } };
const paths = ["package.json", "README.md", "LICENSE", "CHANGELOG.md", "src/index.ts", "src/greeting.ts"];
function pack(overrides = {}) {
  return [{ name: manifest.name, version: manifest.version, filename: "example-extension-0.1.0.tgz",
    files: paths.map(path => ({ path })), ...overrides }];
}

test("accepts only approved root files and source modules", () => {
  assert.equal(verifyPack(pack(), manifest), "example-extension-0.1.0.tgz");
  for (const path of paths) assert.equal(allowedPackagePath(path), true);
});

for (const path of [
  ".env", "src/.env", "src/key.pem", "src/data.json", "src/AGENTS.md", "src/CLAUDE.md",
  "src/GEMINI.md", "src/index.test.ts", "test/a.test.ts", "e2e/smoke.ts", "docs/TESTING.md",
  "src/../secret.ts", "src//index.ts", "src/./index.ts", "src/.hidden.ts", "src/a\\b.ts",
  "src/index.ts\0", "/src/index.ts", "archive.tgz", "node_modules/lib/index.ts",
]) {
  test(`rejects package path ${JSON.stringify(path)}`, () => {
    assert.equal(allowedPackagePath(path), false);
    assert.throws(() => verifyPack(pack({ files: [...paths, path].map(path => ({ path })) }), manifest));
  });
}

test("rejects a wrong identity, unsafe archive, duplicate or missing file", () => {
  for (const overrides of [
    { name: "other" }, { version: "0.2.0" }, { filename: "../escape.tgz" },
    { files: [] }, { files: paths.slice(1).map(path => ({ path })) },
    { files: [...paths, paths[0]].map(path => ({ path })) },
  ]) assert.throws(() => verifyPack(pack(overrides), manifest));
  assert.throws(() => verifyPack([], manifest));
  assert.throws(() => verifyPack([...pack(), ...pack()], manifest));
});

test("requires every manifest entry point to be a packed literal safe path", () => {
  for (const extensions of [[], ["src/missing.ts"], ["../secret.ts"], ["src/*.ts"], [42]]) {
    assert.throws(() => verifyPack(pack(), { ...manifest, pi: { extensions } }));
  }
});
