import assert from "node:assert/strict";
import { StringDecoder } from "node:string_decoder";
import test from "node:test";

import {
  HarnessError,
  JsonSession,
  RpcSession,
  assertPackedAllowlist,
  categoryOf,
  normalizeArchiveEntries,
  normalizePackedFiles,
  parseArchiveListing,
  resolvePackArchive,
  resolvePiCommand,
  scenarioEnvironment,
  shutdownFailure,
  toHarnessError,
} from "../e2e/harness.ts";

const manifest = {
  name: "example-extension",
  version: "0.1.0",
  pi: { extensions: ["./src/index.ts"] },
};
const rootFiles = ["package.json", "README.md", "LICENSE", "CHANGELOG.md"];
const validEntries = [...rootFiles, "src/greeting.ts", "src/index.ts"];

function isCategory(category) {
  return (error) => error instanceof HarnessError && error.category === category;
}

const rejectsArchive = isCategory("archive-invalid");

function tarFile(path) {
  return `-rw-r--r-- 0/0 123 2024-01-01 00:00 ${path}`;
}

function tarDirectory(path) {
  return `drwxr-xr-x 0/0 0 2024-01-01 00:00 ${path}`;
}

function fakeSession(Type) {
  const session = Object.create(Type.prototype);
  session.fatalError = null;
  session.processError = null;
  session.decoder = new StringDecoder("utf8");
  session.buffer = "";
  session.pending = new Map();
  session.notifications = [];
  session.waiters = [];
  session.sequence = 0;
  session.customMessages = [];
  return session;
}

test("normalizePackedFiles reads npm pack results that wrap the file list", () => {
  const packed = [{
    name: manifest.name,
    version: manifest.version,
    filename: "example-extension-0.1.0.tgz",
    files: [{ path: "src/index.ts" }, { path: "package.json" }],
  }];
  assert.deepEqual(normalizePackedFiles(packed), ["package.json", "src/index.ts"]);
});

test("normalizePackedFiles accepts nested file lists and rejects unsafe paths", () => {
  assert.deepEqual(normalizePackedFiles({ files: [{ path: "src/a.ts" }, "README.md"] }), [
    "README.md",
    "src/a.ts",
  ]);
  assert.deepEqual(normalizePackedFiles(["src/b.ts", { path: "src/a.ts" }]), [
    "src/a.ts",
    "src/b.ts",
  ]);
  assert.deepEqual(normalizePackedFiles([]), []);

  for (const packed of [
    [{ files: [{ path: "../secret.ts" }] }],
    [{ files: [{ path: "/etc/passwd" }] }],
    [{ files: [{ path: "src/./index.ts" }] }],
    [{ files: [{ path: "src//index.ts" }] }],
  ]) {
    assert.throws(() => normalizePackedFiles(packed), rejectsArchive);
  }
});

test("packed allowlist requires every approved root file and a literal entry point", () => {
  assert.doesNotThrow(() => assertPackedAllowlist(validEntries, manifest));

  for (const missing of rootFiles) {
    assert.throws(
      () => assertPackedAllowlist(validEntries.filter((path) => path !== missing), manifest),
      rejectsArchive,
    );
  }

  for (const extensions of [
    [],
    ["src/missing.ts"],
    ["src/*.ts"],
    ["../secret.ts"],
    [42],
    ["./src/index.ts", "./src/missing.ts"],
  ]) {
    assert.throws(
      () => assertPackedAllowlist(validEntries, { ...manifest, pi: { extensions } }),
      rejectsArchive,
    );
  }
});

test("packed allowlist rejects duplicate, agent, test, environment, and unexpected files", () => {
  for (const extra of [
    "AGENTS.md",
    "src/AGENTS.md",
    "src/CLAUDE.md",
    "src/.env",
    "src/key.pem",
    "src/data.json",
    "src/index.test.ts",
    "test/a.test.ts",
    "e2e/smoke.ts",
    "docs/TESTING.md",
    "archive.tgz",
  ]) {
    assert.throws(() => assertPackedAllowlist([...validEntries, extra], manifest), rejectsArchive);
  }
  assert.throws(() => assertPackedAllowlist([...validEntries, "src/index.ts"], manifest), rejectsArchive);
});

test("archive listing accepts regular files and directories under package", () => {
  const listing = [
    tarDirectory("package/"),
    tarFile("package/src/index.ts"),
    tarDirectory("package/src/"),
    tarFile("package/package.json"),
    tarFile("package/docs/Release Notes.md"),
  ].join("\n");
  assert.deepEqual(parseArchiveListing(listing), [
    "docs/Release Notes.md",
    "package.json",
    "src/index.ts",
  ]);
});

test("archive listing rejects symlinks, links, and other nonregular entries", () => {
  for (const mode of ["lrwxrwxrwx", "hrw-r--r--", "prw-r--r--", "crw-r--r--", "brw-r--r--", "srwxr-xr-x"]) {
    const listing = `${mode} 0/0 0 2024-01-01 00:00 package/src/index.ts`;
    assert.throws(() => parseArchiveListing(listing), rejectsArchive);
  }
  assert.throws(() => parseArchiveListing("not a tar listing"), rejectsArchive);
});

test("archive listing rejects noncanonical paths and duplicate entries", () => {
  for (const path of [
    "package/../secret.ts",
    "package//etc/passwd",
    "package/./src/index.ts",
    "package/src/../index.ts",
    "package/src//index.ts",
    "package/src\\index.ts",
    "/etc/passwd",
  ]) {
    assert.throws(() => parseArchiveListing(tarFile(path)), rejectsArchive);
  }

  assert.throws(
    () => parseArchiveListing(`${tarFile("package/src/index.ts")}\n${tarFile("package/src/index.ts")}`),
    rejectsArchive,
  );
  assert.throws(
    () => parseArchiveListing(`${tarDirectory("package/src/")}\n${tarDirectory("package/src/")}`),
    rejectsArchive,
  );
  assert.throws(() => parseArchiveListing(tarDirectory("package/src")), rejectsArchive);
});

test("path-only archive entries are strict about canonical paths and duplicates", () => {
  assert.deepEqual(
    normalizeArchiveEntries("package/\npackage/package.json\npackage/src/index.ts\n"),
    ["package.json", "src/index.ts"],
  );

  for (const listing of [
    "package/src/index.ts\npackage/src/index.ts\n",
    "package/./src/index.ts\n",
    "package/src/../secret.ts\n",
    "package//etc/passwd\n",
    "package/src\\index.ts\n",
    "/etc/passwd\n",
    "package/\n",
  ]) {
    assert.throws(() => normalizeArchiveEntries(listing), rejectsArchive);
  }
});

test("RPC framing records notifications and fails closed on malformed records", () => {
  const session = fakeSession(RpcSession);
  session.handleLine(JSON.stringify({
    type: "extension_ui_request",
    id: "ui-1",
    method: "notify",
    message: "Hello, Ada!",
  }));
  assert.equal(session.notificationCount(), 1);
  assert.deepEqual(session.notifications, [
    { method: "notify", message: "Hello, Ada!", notifyType: "info" },
  ]);

  session.handleLine("{not json");
  assert.equal(categoryOf(session.fatalError), "protocol-error");
  assert.throws(() => session.assertHealthy(), isCategory("protocol-error"));
});

test("RPC responses resolve only matching pending requests", () => {
  const session = fakeSession(RpcSession);
  let resolved = null;
  session.pending.set("e2e-1", {
    resolve: (value) => {
      resolved = value;
    },
    reject: (error) => {
      throw error;
    },
    timer: null,
    command: "get_state",
  });
  session.handleLine(JSON.stringify({
    type: "response",
    id: "e2e-1",
    command: "get_state",
    success: true,
    data: { isStreaming: false },
  }));
  assert.deepEqual(resolved, { isStreaming: false });
  assert.equal(session.pending.size, 0);

  const mismatched = fakeSession(RpcSession);
  mismatched.pending.set("e2e-1", {
    resolve: () => {},
    reject: () => {},
    timer: null,
    command: "get_state",
  });
  mismatched.handleLine(JSON.stringify({
    type: "response",
    id: "e2e-1",
    command: "prompt",
    success: true,
    data: {},
  }));
  assert.equal(categoryOf(mismatched.fatalError), "protocol-error");
});

test("RPC write failures reject the request instead of leaving it pending", async () => {
  const session = fakeSession(RpcSession);
  session.writeRecord = () => Promise.reject(new HarnessError("early-exit"));
  await assert.rejects(
    session.request({ type: "get_state" }, 1_000),
    (error) => categoryOf(error) === "early-exit",
  );
  assert.equal(session.pending.size, 0);
});

test("JSON framing records custom messages and rejects agent messages", () => {
  const session = fakeSession(JsonSession);
  session.handleLine(JSON.stringify({
    type: "message_end",
    message: {
      role: "custom",
      customType: "template-greeting",
      content: "Hello, Ada!",
      display: true,
    },
  }));
  assert.deepEqual(session.getCustomMessages(), [{
    customType: "template-greeting",
    content: "Hello, Ada!",
    display: true,
  }]);

  const agent = fakeSession(JsonSession);
  agent.handleLine(JSON.stringify({
    type: "message_end",
    message: { role: "assistant", content: "unexpected" },
  }));
  assert.equal(categoryOf(agent.fatalError), "unexpected-agent-run");
});

test("error helpers preserve known categories and map unknown failures", () => {
  assert.equal(categoryOf(new HarnessError("archive-invalid")), "archive-invalid");
  assert.equal(categoryOf({ category: "rpc-timeout" }), "rpc-timeout");
  assert.equal(categoryOf(new Error("boom")), "unexpected-error");
  assert.equal(new HarnessError("not-a-category").category, "unexpected-error");
  assert.equal(categoryOf(toHarnessError({ category: "not-a-category" }, "protocol-error")), "protocol-error");
});

test("scenario environment keeps all Pi state under the isolation root", () => {
  const environment = scenarioEnvironment("/tmp/example", {
    PATH: "/usr/bin",
    HOME: "/real/home",
    PI_CODING_AGENT_DIR: "/real/agent",
    OPENAI_API_KEY: "test-secret",
    HTTPS_PROXY: "http://invalid",
  });
  assert.deepEqual(environment, {
    PATH: "/usr/bin",
    HOME: "/tmp/example/home",
    USERPROFILE: "/tmp/example/home",
    TMPDIR: "/tmp/example/tmp",
    XDG_CONFIG_HOME: "/tmp/example/config",
    XDG_CACHE_HOME: "/tmp/example/cache",
    PI_CODING_AGENT_DIR: "/tmp/example/agent",
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    LANG: "C.UTF-8",
    CI: "1",
  });
  assert.equal(environment.OPENAI_API_KEY, undefined);
  assert.equal(environment.HTTPS_PROXY, undefined);
});

test("Pi selection requires an absolute override or a usable PATH", () => {
  assert.equal(resolvePiCommand({ PATH: "/usr/bin" }), "pi");
  assert.equal(resolvePiCommand({ PATH: "/usr/bin", PI_BIN: "/opt/pi" }), "/opt/pi");
  for (const source of [{ PI_BIN: "pi", PATH: "/usr/bin" }, { PI_BIN: "", PATH: "/usr/bin" }, {}]) {
    assert.throws(
      () => resolvePiCommand(source),
      isCategory("configuration-error"),
    );
  }
});

test("packed archive selection accepts reported or absolute external paths only", () => {
  assert.equal(resolvePackArchive("example-1.0.0.tgz", "/tmp/pack", {}), "/tmp/pack/example-1.0.0.tgz");
  assert.equal(resolvePackArchive("/tmp/pack/example-1.0.0.tgz", "/tmp/pack", {}), "/tmp/pack/example-1.0.0.tgz");
  assert.equal(resolvePackArchive(undefined, "/tmp/pack", { PACKAGE_ARCHIVE: "/tmp/other.tgz" }), "/tmp/other.tgz");
  assert.throws(
    () => resolvePackArchive(undefined, "/tmp/pack", { PACKAGE_ARCHIVE: "other.tgz" }),
    isCategory("configuration-error"),
  );
  assert.throws(
    () => resolvePackArchive("", "/tmp/pack", {}),
    isCategory("pack-failed"),
  );
});

test("shutdown failures distinguish leaks, unexpected exits, and forced shutdown", () => {
  const clean = { leaked: false, unexpectedExit: false, forced: false, killed: false, code: 0 };
  assert.equal(shutdownFailure(clean), null);
  for (const [change, category] of [
    [{ leaked: true }, "process-leak"],
    [{ unexpectedExit: true }, "early-exit"],
    [{ forced: true }, "shutdown-failed"],
    [{ killed: true }, "shutdown-failed"],
    [{ code: 1 }, "shutdown-failed"],
  ]) {
    const failure = shutdownFailure({ ...clean, ...change });
    assert.ok(failure instanceof HarnessError);
    assert.equal(failure.category, category);
  }
});
