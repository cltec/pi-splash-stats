import { execFile, spawn } from "node:child_process";
import { readFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";

import { verifyPack } from "../scripts/check-package.mjs";
import { childEnvironment } from "../scripts/isolation.mjs";

const execFileAsync = promisify(execFile);

const MAX_RECORD_BYTES = 1024 * 1024;
const MAX_PROTOCOL_BUFFER_BYTES = 2 * 1024 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;
const SPAWN_TIMEOUT_MS = 5_000;
const WRITE_TIMEOUT_MS = 2_000;
const GRACEFUL_SHUTDOWN_MS = 8_000;
const TERM_TIMEOUT_MS = 3_000;
const KILL_TIMEOUT_MS = 3_000;
const RESIDUAL_GROUP_TIMEOUT_MS = 500;
const RESIDUAL_GROUP_POLL_MS = 25;

export const ERROR_CATEGORIES = [
  "configuration-error",
  "pack-failed",
  "archive-invalid",
  "version-mismatch",
  "version-unreadable",
  "spawn-failed",
  "early-exit",
  "rpc-timeout",
  "rpc-error",
  "protocol-error",
  "protocol-buffer-overflow",
  "command-missing",
  "command-source-mismatch",
  "prompt-rejected",
  "extension-error",
  "unexpected-agent-run",
  "unexpected-ui",
  "notification-missing",
  "notification-mismatch",
  "message-mismatch",
  "state-not-idle",
  "unexpected-messages",
  "shutdown-failed",
  "process-leak",
  "process-failed",
  "json-timeout",
  "cleanup-failed",
  "assertion-failed",
  "artifact-failed",
  "unexpected-error",
];

const CATEGORY_SET = new Set(ERROR_CATEGORIES);
const SAFE_ENVIRONMENT_KEYS = new Set([
  "PATH",
  "HOME",
  "USERPROFILE",
  "TMPDIR",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "PI_CODING_AGENT_DIR",
  "PI_OFFLINE",
  "PI_SKIP_VERSION_CHECK",
  "PI_TELEMETRY",
  "LANG",
  "CI",
]);
const FORBIDDEN_AGENT_EVENTS = new Set([
  "agent_start",
  "agent_end",
  "agent_settled",
  "turn_start",
  "turn_end",
  "message_update",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "auto_retry_start",
  "auto_retry_end",
  "compaction_start",
  "compaction_end",
  "summarization_retry_scheduled",
  "summarization_retry_attempt_start",
  "summarization_retry_finished",
]);
const DIALOG_UI_METHODS = new Set(["select", "confirm", "input", "editor"]);

export class HarnessError extends Error {
  category;

  constructor(category) {
    super(`e2e ${category}`);
    this.name = "HarnessError";
    this.category = CATEGORY_SET.has(category) ? category : "unexpected-error";
  }
}

export function ensure(condition, category) {
  if (!condition) throw new HarnessError(category);
}

export function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function toHarnessError(error, fallback = "unexpected-error") {
  if (error instanceof HarnessError) return error;
  if (isRecord(error) && typeof error.category === "string" && CATEGORY_SET.has(error.category)) {
    return new HarnessError(error.category);
  }
  return new HarnessError(fallback);
}

export function categoryOf(error) {
  return toHarnessError(error).category;
}

export function createScenarioRoot(label) {
  const safeLabel = /^[a-z0-9-]+$/.test(label) ? label : "scenario";
  const root = mkdtempSync(join(tmpdir(), `pi-e2e-${safeLabel}-`));
  const paths = {
    root,
    home: join(root, "home"),
    tmp: join(root, "tmp"),
    config: join(root, "config"),
    cache: join(root, "cache"),
    agent: join(root, "agent"),
    cwd: join(root, "cwd"),
  };
  for (const path of [paths.home, paths.tmp, paths.config, paths.cache, paths.agent, paths.cwd]) {
    mkdirSync(path, { recursive: true });
  }
  return paths;
}

export function removeScenarioRoot(root) {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    return true;
  } catch {
    return false;
  }
}

export function resolvePiCommand(source = process.env) {
  const configured = source.PI_BIN;
  if (configured !== undefined) {
    if (typeof configured !== "string" || configured.length === 0 || !isAbsolute(configured)) {
      throw new HarnessError("configuration-error");
    }
    return configured;
  }
  if (typeof source.PATH !== "string" || source.PATH.length === 0) {
    throw new HarnessError("configuration-error");
  }
  return "pi";
}

export function scenarioEnvironment(root, source = process.env) {
  const environment = childEnvironment(root, source);
  if (!isRecord(environment)) throw new HarnessError("configuration-error");

  for (const key of Object.keys(environment)) {
    if (!SAFE_ENVIRONMENT_KEYS.has(key)) throw new HarnessError("configuration-error");
  }

  const expectedPaths = {
    HOME: join(root, "home"),
    USERPROFILE: join(root, "home"),
    TMPDIR: join(root, "tmp"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_CACHE_HOME: join(root, "cache"),
    PI_CODING_AGENT_DIR: join(root, "agent"),
  };
  for (const [key, value] of Object.entries(expectedPaths)) {
    if (environment[key] !== value) throw new HarnessError("configuration-error");
  }
  for (const [key, value] of Object.entries({
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    LANG: "C.UTF-8",
    CI: "1",
  })) {
    if (environment[key] !== value) throw new HarnessError("configuration-error");
  }
  if (typeof environment.PATH !== "string" || environment.PATH.length === 0) {
    throw new HarnessError("configuration-error");
  }
  return environment;
}

function toolEnvironment(source = process.env) {
  if (typeof source.PATH !== "string" || source.PATH.length === 0) {
    throw new HarnessError("configuration-error");
  }
  return { PATH: source.PATH, LANG: "C" };
}

function isStableVersion(value) {
  return typeof value === "string" && /^\d+\.\d+\.\d+$/.test(value);
}

export function readPiBaseline(repoRoot) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(join(repoRoot, "scripts", "quality.json"), "utf8"));
  } catch {
    throw new HarnessError("configuration-error");
  }
  if (!isRecord(parsed) || !isStableVersion(parsed.piVersion)) {
    throw new HarnessError("configuration-error");
  }
  return parsed.piVersion;
}

function parsePiVersion(stdout) {
  const lines = String(stdout)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length !== 1 || !isStableVersion(lines[0])) {
    throw new HarnessError("version-unreadable");
  }
  return lines[0];
}

async function runCapture(command, args, options) {
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd,
      env: options.env,
      encoding: "utf8",
      timeout: options.timeout,
      maxBuffer: options.maxBuffer ?? 64 * 1024,
      windowsHide: true,
      killSignal: "SIGKILL",
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    if (isRecord(error) && typeof error.code === "number") {
      return {
        code: error.code,
        stdout: typeof error.stdout === "string" ? error.stdout : "",
        stderr: typeof error.stderr === "string" ? error.stderr : "",
      };
    }
    if (isRecord(error) && (error.killed === true || typeof error.signal === "string")) {
      throw new HarnessError("process-failed");
    }
    if (isRecord(error) && (error.code === "ENOENT" || error.code === "EACCES")) {
      throw new HarnessError("spawn-failed");
    }
    throw new HarnessError("process-failed");
  }
}

export async function verifyPiVersion(repoRoot, source = process.env) {
  const baseline = readPiBaseline(repoRoot);
  let expected = baseline;
  if (source.PI_VERSION !== undefined) {
    if (!isStableVersion(source.PI_VERSION)) throw new HarnessError("configuration-error");
    expected = source.PI_VERSION;
  }

  const command = resolvePiCommand(source);
  const root = createScenarioRoot("version");
  let actual = null;
  let failure = null;
  let cleanup = "clean";

  try {
    const environment = scenarioEnvironment(root.root, source);
    const result = await runCapture(command, ["--version"], {
      cwd: root.cwd,
      env: environment,
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    });
    if (result.code !== 0) throw new HarnessError("version-unreadable");
    actual = parsePiVersion(result.stdout);
  } catch (error) {
    failure = toHarnessError(error, "version-unreadable");
  } finally {
    if (!removeScenarioRoot(root.root)) cleanup = "failed";
  }

  return { baseline, expected, actual, failure, cleanup };
}

function normalizeArchivePath(value, options = {}) {
  if (typeof value !== "string") throw new HarnessError("archive-invalid");
  if (value.includes("\0") || value.includes("\\")) throw new HarnessError("archive-invalid");
  let path = value;
  if (path === "package") return "";
  if (path.startsWith("package/")) path = path.slice("package/".length);
  if (path.length === 0) return "";

  const directory = options.directory === true;
  if (directory) {
    if (!path.endsWith("/")) throw new HarnessError("archive-invalid");
    path = path.slice(0, -1);
  } else if (path.endsWith("/")) {
    throw new HarnessError("archive-invalid");
  }
  if (path.length === 0) throw new HarnessError("archive-invalid");
  if (path.startsWith("/") || /^[A-Za-z]:\//.test(path)) throw new HarnessError("archive-invalid");

  const parts = path.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    throw new HarnessError("archive-invalid");
  }
  return path;
}

function archiveEntryKey(path, directory) {
  return directory ? `${path}/` : path;
}

function archiveListingPath(path) {
  if (path === "package" || path === "package/" || path.startsWith("package/")) return path;
  throw new HarnessError("archive-invalid");
}

export function normalizeArchiveEntries(stdout) {
  const entries = [];
  const seen = new Set();
  for (const rawLine of String(stdout).split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.length === 0) continue;
    archiveListingPath(line);

    const directory = line.endsWith("/") || line === "package";
    const normalized = normalizeArchivePath(line, { directory });
    const key = archiveEntryKey(normalized, directory);
    if (seen.has(key)) throw new HarnessError("archive-invalid");
    seen.add(key);
    if (directory) continue;
    if (normalized.length === 0) throw new HarnessError("archive-invalid");
    entries.push(normalized);
  }
  if (entries.length === 0) throw new HarnessError("archive-invalid");
  return entries.sort();
}

const LISTING_LINE = /^([-d])[rwxStTs-]{9}\s+\S+\s+\d+\s+\S+\s+\S+\s+(.+)$/;

export function parseArchiveListing(stdout) {
  const entries = [];
  const seen = new Set();
  for (const rawLine of String(stdout).split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.length === 0) continue;

    const match = LISTING_LINE.exec(line);
    if (!match) throw new HarnessError("archive-invalid");
    const [, mode, path] = match;
    if (mode !== "-" && mode !== "d") throw new HarnessError("archive-invalid");
    archiveListingPath(path);

    const directory = mode === "d";
    if (directory !== path.endsWith("/")) throw new HarnessError("archive-invalid");
    const normalized = normalizeArchivePath(path, { directory });
    const key = archiveEntryKey(normalized, directory);
    if (seen.has(key)) throw new HarnessError("archive-invalid");
    seen.add(key);
    if (directory) continue;
    if (normalized.length === 0) throw new HarnessError("archive-invalid");
    entries.push(normalized);
  }
  if (entries.length === 0) throw new HarnessError("archive-invalid");
  return entries.sort();
}

export function normalizePackedFiles(packed) {
  const files = [];
  const seen = new Set();
  const addPath = (path) => {
    if (seen.has(path)) return;
    seen.add(path);
    files.push(path);
  };
  const add = (value) => {
    if (typeof value === "string") {
      const normalized = normalizeArchivePath(value);
      if (normalized.length > 0) addPath(normalized);
    } else if (isRecord(value)) {
      if (typeof value.path === "string") add(value.path);
      else if (Array.isArray(value.files)) {
        for (const nested of value.files) add(nested);
      }
    }
  };

  if (Array.isArray(packed)) {
    for (const value of packed) add(value);
  } else if (isRecord(packed)) {
    add(packed);
  }

  return files.sort();
}

export function assertPackedAllowlist(entries, manifest) {
  try {
    ensure(Array.isArray(entries) && entries.length > 0, "archive-invalid");
    ensure(isRecord(manifest), "archive-invalid");
    verifyPack([{
      name: manifest.name,
      version: manifest.version,
      filename: "package.tgz",
      files: entries.map((path) => ({ path })),
    }], manifest);
  } catch (error) {
    throw toHarnessError(error, "archive-invalid");
  }
}

export async function inspectArchive(archive, source = process.env) {
  const result = await runCapture("tar", [
    "--list",
    "--verbose",
    "--numeric-owner",
    "--quoting-style=escape",
    "--gzip",
    "--file",
    archive,
  ], {
    cwd: dirname(archive),
    env: toolEnvironment(source),
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.code !== 0) throw new HarnessError("archive-invalid");
  return parseArchiveListing(result.stdout);
}

export async function extractArchive(archive, destination, source = process.env) {
  mkdirSync(destination, { recursive: true });
  const result = await runCapture("tar", ["-xzf", archive, "-C", destination], {
    cwd: dirname(archive),
    env: toolEnvironment(source),
    timeout: 30_000,
    maxBuffer: 64 * 1024,
  });
  if (result.code !== 0) throw new HarnessError("archive-invalid");
}

function isChildAlive(child) {
  return child.exitCode === null && child.signalCode === null;
}

function killProcessTree(child, signal) {
  if (!child.pid) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall through to the direct child when the process group is gone.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // The process already exited.
  }
}

function processGroupAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return isRecord(error) && error.code === "EPERM";
  }
}

async function reapResidualGroup(child) {
  if (process.platform === "win32" || !child.pid) return { found: false, leaked: false };
  if (!processGroupAlive(child.pid)) return { found: false, leaked: false };

  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    return { found: true, leaked: true };
  }

  const deadline = Date.now() + RESIDUAL_GROUP_TIMEOUT_MS;
  while (processGroupAlive(child.pid) && Date.now() < deadline) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, RESIDUAL_GROUP_POLL_MS));
  }
  return { found: true, leaked: processGroupAlive(child.pid) };
}

async function finalizeClose(child, result) {
  const residual = await reapResidualGroup(child);
  if (!residual.found) return result;
  return {
    ...result,
    forced: true,
    killed: true,
    leaked: result.leaked || residual.leaked,
    residualGroup: true,
  };
}

function writeToStdin(child, line) {
  if (!child.stdin || child.stdin.destroyed || !child.stdin.writable || !isChildAlive(child)) {
    return Promise.reject(new HarnessError("early-exit"));
  }

  return new Promise((resolveWrite, rejectWrite) => {
    let settled = false;
    let timer = null;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.stdin.off("drain", onDrain);
      child.stdin.off("error", onError);
      if (error) rejectWrite(error);
      else resolveWrite();
    };
    const onDrain = () => finish(null);
    const onError = () => finish(new HarnessError("early-exit"));

    child.stdin.once("drain", onDrain);
    child.stdin.once("error", onError);
    timer = setTimeout(() => finish(new HarnessError("process-failed")), WRITE_TIMEOUT_MS);

    let accepted;
    try {
      accepted = child.stdin.write(line);
    } catch {
      finish(new HarnessError("early-exit"));
      return;
    }
    if (accepted) finish(null);
  });
}

export class ManagedChild {
  child;
  spawnPromise;
  exitPromise;
  exitInfo = null;
  fatalError = null;
  processError = null;
  closeRequested = false;
  exitExpected = false;
  closePromise = null;
  decoder = new StringDecoder("utf8");
  buffer = "";
  stderrBytes = 0;
  stderrDropped = false;
  resolveExit = null;

  constructor(options) {
    this.child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: [options.stdin ?? "pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });

    this.exitPromise = new Promise((resolveExit) => {
      this.resolveExit = resolveExit;
    });
    this.spawnPromise = new Promise((resolveSpawn, rejectSpawn) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        this.child.off("spawn", onSpawn);
        this.child.off("error", onSpawnError);
        if (error) rejectSpawn(new HarnessError("spawn-failed"));
        else resolveSpawn();
      };
      const onSpawn = () => finish(null);
      const onSpawnError = () => finish(new HarnessError("spawn-failed"));
      this.child.once("spawn", onSpawn);
      this.child.once("error", onSpawnError);
    });

    this.child.on("error", () => {
      this.processError = new HarnessError("spawn-failed");
      this.fail(this.processError);
    });
    this.child.stdin?.on("error", () => {
      // EPIPE during shutdown is expected; active writes report their own error.
    });
    this.child.stdout?.on("data", (chunk) => this.consumeStdout(chunk));
    this.child.stderr?.on("data", (chunk) => this.consumeStderr(chunk));
    this.child.on("close", (code, signal) => this.handleClose(code, signal));
  }

  static async start(options) {
    const child = new this(options);
    try {
      await child.waitForSpawn();
      return child;
    } catch (error) {
      await child.close();
      throw toHarnessError(error, "spawn-failed");
    }
  }

  async waitForSpawn() {
    let timer = null;
    try {
      await Promise.race([
        this.spawnPromise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new HarnessError("spawn-failed")), SPAWN_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  consumeStderr(chunk) {
    if (this.stderrBytes >= MAX_STDERR_BYTES) {
      this.stderrDropped = true;
      return;
    }
    this.stderrBytes += chunk.length;
    if (this.stderrBytes > MAX_STDERR_BYTES) this.stderrDropped = true;
  }

  consumeStdout(chunk) {
    if (this.fatalError) return;
    this.buffer += this.decoder.write(chunk);

    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      this.handleLine(line);
      if (this.fatalError) return;
      newline = this.buffer.indexOf("\n");
    }

    if (this.buffer.length > MAX_PROTOCOL_BUFFER_BYTES) {
      this.buffer = "";
      this.fail(new HarnessError("protocol-buffer-overflow"));
    }
  }

  handleLine(rawLine) {
    if (this.fatalError) return;
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.length === 0) return;
    if (Buffer.byteLength(line, "utf8") > MAX_RECORD_BYTES) {
      this.fail(new HarnessError("protocol-buffer-overflow"));
      return;
    }

    let record;
    try {
      record = JSON.parse(line);
    } catch {
      this.fail(new HarnessError("protocol-error"));
      return;
    }
    if (!isRecord(record)) {
      this.fail(new HarnessError("protocol-error"));
      return;
    }

    try {
      this.handleRecord(record);
    } catch (error) {
      this.fail(toHarnessError(error, "protocol-error"));
    }
  }

  handleRecord() {
    throw new HarnessError("protocol-error");
  }

  onFatal() {}

  onExit() {}

  fail(error) {
    if (this.fatalError) return;
    this.fatalError = toHarnessError(error);
    this.onFatal(this.fatalError);
  }

  assertHealthy() {
    if (this.fatalError) throw this.fatalError;
    if (this.processError) throw this.processError;
  }

  expectNaturalExit() {
    this.exitExpected = true;
  }

  handleClose(code, signal) {
    if (this.exitInfo) return;
    const trailing = this.decoder.end();
    if (!this.fatalError && (this.buffer.length > 0 || trailing.length > 0 || this.buffer.length > MAX_PROTOCOL_BUFFER_BYTES)) {
      this.fail(new HarnessError("protocol-error"));
    }
    this.buffer = "";
    this.exitInfo = { code, signal };
    this.resolveExit(this.exitInfo);
    const unexpected = !this.closeRequested && !this.exitExpected;
    this.onExit(this.exitInfo, unexpected);
  }

  async writeRecord(record) {
    this.assertHealthy();
    let line;
    try {
      line = `${JSON.stringify(record)}\n`;
    } catch {
      throw new HarnessError("protocol-error");
    }
    await writeToStdin(this.child, line);
  }

  async waitForExit(timeoutMs) {
    if (this.exitInfo) return this.exitInfo;
    let timer = null;
    try {
      return await Promise.race([
        this.exitPromise,
        new Promise((resolveTimeout) => {
          timer = setTimeout(() => resolveTimeout(null), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async close() {
    if (this.closePromise) return this.closePromise;

    const unexpectedBeforeClose = this.exitInfo !== null && !this.closeRequested && !this.exitExpected;
    this.closeRequested = true;
    this.closePromise = this.performClose(unexpectedBeforeClose);
    return this.closePromise;
  }

  async performClose(unexpectedBeforeClose) {
    if (this.exitInfo) {
      return finalizeClose(this.child, {
        ...this.exitInfo,
        forced: false,
        killed: false,
        leaked: false,
        unexpectedExit: unexpectedBeforeClose,
      });
    }

    if (!this.child.pid) {
      return {
        code: null,
        signal: null,
        forced: false,
        killed: false,
        leaked: false,
        unexpectedExit: unexpectedBeforeClose,
      };
    }

    if (this.child.stdin && !this.child.stdin.destroyed) {
      try {
        this.child.stdin.end();
      } catch {
        // The child may have exited between the check and the call.
      }
    }

    const graceful = await this.waitForExit(GRACEFUL_SHUTDOWN_MS);
    if (graceful) {
      return finalizeClose(this.child, {
        ...graceful,
        forced: false,
        killed: false,
        leaked: false,
        unexpectedExit: false,
      });
    }

    killProcessTree(this.child, "SIGTERM");
    const terminated = await this.waitForExit(TERM_TIMEOUT_MS);
    if (terminated) {
      return finalizeClose(this.child, {
        ...terminated,
        forced: true,
        killed: false,
        leaked: false,
        unexpectedExit: false,
      });
    }

    killProcessTree(this.child, "SIGKILL");
    const killed = await this.waitForExit(KILL_TIMEOUT_MS);
    if (killed) {
      return finalizeClose(this.child, {
        ...killed,
        forced: true,
        killed: true,
        leaked: false,
        unexpectedExit: false,
      });
    }

    return finalizeClose(this.child, {
      code: null,
      signal: null,
      forced: true,
      killed: true,
      leaked: true,
      unexpectedExit: false,
    });
  }
}

export class RpcSession extends ManagedChild {
  pending = new Map();
  notifications = [];
  waiters = [];
  sequence = 0;

  request(command, timeoutMs = 10_000) {
    this.assertHealthy();
    const id = `e2e-${++this.sequence}`;
    const commandName = typeof command.type === "string" ? command.type : "unknown";

    const response = new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.rejectPending(id, new HarnessError("rpc-timeout"));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: resolveRequest,
        reject: rejectRequest,
        timer,
        command: commandName,
      });
    });
    // The caller may not attach yet; keep a slow write or early exit from
    // surfacing as an unhandled rejection before it receives the handle.
    response.catch(() => {});
    this.writeRecord({ ...command, id }).catch((error) => {
      this.rejectPending(id, toHarnessError(error, "early-exit"));
    });

    return response;
  }

  rejectPending(id, error) {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.reject(toHarnessError(error));
  }

  rejectAll(error) {
    const failure = toHarnessError(error);
    for (const id of [...this.pending.keys()]) this.rejectPending(id, failure);
  }

  resolveWaiters() {
    for (let index = this.waiters.length - 1; index >= 0; index -= 1) {
      const waiter = this.waiters[index];
      if (this.notifications.length < waiter.target) continue;
      clearTimeout(waiter.timer);
      this.waiters.splice(index, 1);
      waiter.resolve(this.notifications.slice());
    }
  }

  rejectWaiters(error) {
    const failure = toHarnessError(error);
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(failure);
    }
  }

  onFatal(error) {
    this.rejectAll(error);
    this.rejectWaiters(error);
  }

  onExit(_info, unexpected) {
    if (unexpected) {
      this.rejectAll(new HarnessError("early-exit"));
      this.rejectWaiters(new HarnessError("early-exit"));
    } else {
      this.rejectWaiters(new HarnessError("shutdown-failed"));
    }
  }

  handleRecord(record) {
    const type = record.type;
    if (type === "response") {
      this.handleResponse(record);
      return;
    }
    if (type === "extension_ui_request") {
      this.handleUiRequest(record);
      return;
    }
    if (type === "extension_error") throw new HarnessError("extension-error");
    if (type === "error") throw new HarnessError("rpc-error");
    if (typeof type === "string" && FORBIDDEN_AGENT_EVENTS.has(type)) {
      throw new HarnessError("unexpected-agent-run");
    }
  }

  handleResponse(record) {
    if (typeof record.id !== "string") throw new HarnessError("rpc-error");
    const pending = this.pending.get(record.id);
    if (!pending) throw new HarnessError("protocol-error");
    if (record.success !== true) {
      const category = pending.command === "prompt" ? "prompt-rejected" : "rpc-error";
      const failure = new HarnessError(category);
      this.rejectPending(record.id, failure);
      this.fail(failure);
      return;
    }
    if (typeof record.command !== "string" || record.command !== pending.command) {
      throw new HarnessError("protocol-error");
    }
    this.pending.delete(record.id);
    clearTimeout(pending.timer);
    pending.resolve(record.data);
  }

  handleUiRequest(record) {
    if (typeof record.id !== "string" || typeof record.method !== "string") {
      throw new HarnessError("protocol-error");
    }
    if (record.method === "notify") {
      if (typeof record.message !== "string") throw new HarnessError("protocol-error");
      const notifyType = record.notifyType === undefined ? "info" : record.notifyType;
      if (notifyType !== "info" && notifyType !== "warning" && notifyType !== "error") {
        throw new HarnessError("protocol-error");
      }
      this.notifications.push({ method: "notify", message: record.message, notifyType });
      if (this.notifications.length > 32) throw new HarnessError("notification-mismatch");
      this.resolveWaiters();
      return;
    }

    if (DIALOG_UI_METHODS.has(record.method)) {
      void this.writeRecord({
        type: "extension_ui_response",
        id: record.id,
        cancelled: true,
      }).catch(() => {});
      throw new HarnessError("unexpected-ui");
    }
  }

  notificationCount() {
    return this.notifications.length;
  }

  waitForNotifications(target, timeoutMs = 5_000) {
    if (this.fatalError) return Promise.reject(this.fatalError);
    if (this.notifications.length >= target) return Promise.resolve(this.notifications.slice());

    return new Promise((resolveWait, rejectWait) => {
      const waiter = { target, resolve: resolveWait, reject: rejectWait, timer: null };
      waiter.timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) this.waiters.splice(index, 1);
        rejectWait(new HarnessError("notification-missing"));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }
}

export class JsonSession extends ManagedChild {
  customMessages = [];

  handleRecord(record) {
    const type = record.type;
    if (type === "response") {
      if (record.success !== true) throw new HarnessError("rpc-error");
      return;
    }
    if (type === "extension_error") throw new HarnessError("extension-error");
    if (type === "error") throw new HarnessError("rpc-error");
    if (type === "extension_ui_request") throw new HarnessError("unexpected-ui");
    if (typeof type === "string" && FORBIDDEN_AGENT_EVENTS.has(type)) {
      throw new HarnessError("unexpected-agent-run");
    }

    if (type === "message_start" && isRecord(record.message)) {
      if (record.message.role === "user" || record.message.role === "assistant") {
        throw new HarnessError("unexpected-agent-run");
      }
      return;
    }

    if (type === "message_end" && isRecord(record.message)) {
      const message = record.message;
      if (message.role === "user" || message.role === "assistant") {
        throw new HarnessError("unexpected-agent-run");
      }
      if (message.role !== "custom") return;
      if (typeof message.customType !== "string" || typeof message.content !== "string") {
        throw new HarnessError("protocol-error");
      }
      this.customMessages.push({
        customType: message.customType,
        content: message.content,
        display: message.display === true,
      });
      if (this.customMessages.length > 32) throw new HarnessError("message-mismatch");
    }
  }

  getCustomMessages() {
    return this.customMessages.slice();
  }
}

export function shutdownFailure(result) {
  if (result.leaked) return new HarnessError("process-leak");
  if (result.unexpectedExit) return new HarnessError("early-exit");
  if (result.forced || result.killed) return new HarnessError("shutdown-failed");
  if (result.code !== 0) return new HarnessError("shutdown-failed");
  return null;
}

export function resolvePackArchive(reportedArchive, destination, source = process.env) {
  const external = source.PACKAGE_ARCHIVE;
  let archive;
  if (external !== undefined) {
    if (typeof external !== "string" || external.length === 0 || !isAbsolute(external)) {
      throw new HarnessError("configuration-error");
    }
    archive = external;
  } else {
    if (typeof reportedArchive !== "string" || reportedArchive.length === 0) {
      throw new HarnessError("pack-failed");
    }
    archive = isAbsolute(reportedArchive) ? reportedArchive : resolve(destination, reportedArchive);
  }
  return archive;
}
