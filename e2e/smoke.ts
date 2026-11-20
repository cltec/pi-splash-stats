import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { packPackage } from "../scripts/check-package.mjs";
import {
  HarnessError,
  JsonSession,
  RpcSession,
  assertPackedAllowlist,
  createScenarioRoot,
  ensure,
  extractArchive,
  inspectArchive,
  isRecord,
  normalizePackedFiles,
  removeScenarioRoot,
  resolvePackArchive,
  resolvePiCommand,
  scenarioEnvironment,
  shutdownFailure,
  toHarnessError,
  verifyPiVersion,
} from "./harness.ts";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CHECKOUT_ENTRY = join(REPO_ROOT, "src", "index.ts");

function commonRpcArguments() {
  return [
    "--mode",
    "rpc",
    "--no-session",
    "--no-approve",
    "--no-tools",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--no-mcp",
  ];
}

function checkoutArguments() {
  return [...commonRpcArguments(), "--no-extensions", "-e", CHECKOUT_ENTRY];
}

function packageArguments() {
  return commonRpcArguments();
}

function headlessArguments() {
  return [
    "--mode",
    "json",
    "-p",
    "--no-session",
    "--no-approve",
    "--no-tools",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--no-mcp",
    "--no-extensions",
    "-e",
    CHECKOUT_ENTRY,
    "/hello Ada",
  ];
}

function parseCommands(data) {
  ensure(isRecord(data) && Array.isArray(data.commands), "protocol-error");
  for (const command of data.commands) {
    ensure(isRecord(command) && typeof command.name === "string", "protocol-error");
  }
  return data.commands;
}

function safeCommandNames(commands) {
  const names = [];
  for (const command of commands) {
    if (typeof command.name !== "string") continue;
    if (!/^[A-Za-z0-9:_.-]{1,64}$/.test(command.name)) continue;
    if (!names.includes(command.name)) names.push(command.name);
  }
  return names;
}

async function expectGreeting(session, message, expected) {
  const before = session.notificationCount();
  const response = await session.request({ type: "prompt", message }, 10_000);
  ensure(isRecord(response) && response.disposition === "handled", "unexpected-agent-run");

  const notifications = await session.waitForNotifications(before + 1, 5_000);
  const additions = notifications.slice(before);
  ensure(additions.length === 1, "notification-mismatch");
  const notification = additions[0];
  ensure(notification.method === "notify", "notification-mismatch");
  ensure(notification.message === expected, "notification-mismatch");
  ensure((notification.notifyType ?? "info") === "info", "notification-mismatch");
}

async function expectIdleWithoutMessages(session) {
  const state = await session.request({ type: "get_state" }, 5_000);
  ensure(isRecord(state), "protocol-error");
  ensure(state.isStreaming === false, "state-not-idle");
  ensure(state.isCompacting === false, "state-not-idle");
  ensure(state.pendingMessageCount === 0, "state-not-idle");
  ensure(state.messageCount === 0, "unexpected-messages");

  const messages = await session.request({ type: "get_messages" }, 5_000);
  ensure(isRecord(messages) && Array.isArray(messages.messages), "protocol-error");
  ensure(messages.messages.length === 0, "unexpected-messages");
}

async function exerciseRpcScenario(session, expectedOrigin) {
  const commands = parseCommands(await session.request({ type: "get_commands" }, 30_000));
  ensure(commands.some((command) => command.name === "hello"), "command-missing");

  const hello = commands.find((command) => command.name === "hello");
  ensure(hello.source === "extension", "command-source-mismatch");
  ensure(isRecord(hello.sourceInfo), "command-source-mismatch");
  ensure(hello.sourceInfo.origin === expectedOrigin, "command-source-mismatch");

  await expectGreeting(session, "/hello Ada", "Hello, Ada!");
  await expectGreeting(session, "/hello    ", "Hello, world!");
  await expectIdleWithoutMessages(session);

  ensure(session.notificationCount() === 2, "notification-mismatch");
  session.assertHealthy();
  return safeCommandNames(commands);
}

async function finishScenario(session, failure, root) {
  let remainingFailure = failure;
  let cleanup = "clean";

  try {
    if (session) {
      let shutdown = null;
      try {
        shutdown = await session.close();
      } catch (error) {
        if (!remainingFailure) remainingFailure = toHarnessError(error, "shutdown-failed");
      }
      try {
        session.assertHealthy();
      } catch (error) {
        if (!remainingFailure) remainingFailure = toHarnessError(error);
      }
      if (!remainingFailure && shutdown) remainingFailure = shutdownFailure(shutdown);
    }
  } catch (error) {
    if (!remainingFailure) remainingFailure = toHarnessError(error, "shutdown-failed");
  } finally {
    if (!removeScenarioRoot(root.root)) cleanup = "failed";
  }

  if (cleanup === "failed" && !remainingFailure) {
    remainingFailure = new HarnessError("cleanup-failed");
  }
  return { failure: remainingFailure, cleanup };
}

async function runRpcScenario(options) {
  const root = createScenarioRoot(options.rootLabel);
  let session = null;
  let failure = null;
  let commands = [];
  let cleanup = "clean";

  try {
    const environment = scenarioEnvironment(root.root, options.env);
    session = await RpcSession.start({
      command: options.piCommand,
      args: options.args,
      cwd: root.cwd,
      env: environment,
    });
    commands = await exerciseRpcScenario(session, options.expectedOrigin);
  } catch (error) {
    failure = toHarnessError(error);
  } finally {
    const finished = await finishScenario(session, failure, root);
    failure = finished.failure;
    cleanup = finished.cleanup;
  }

  return { failure, commands, cleanup };
}

async function checkoutScenario(context) {
  return runRpcScenario({
    ...context,
    rootLabel: "checkout",
    args: checkoutArguments(),
    expectedOrigin: "top-level",
  });
}

async function packedArchiveScenario(context) {
  const root = createScenarioRoot("packed");
  let session = null;
  let failure = null;
  let commands = [];
  let cleanup = "clean";

  try {
    const destination = join(root.root, "pack");
    mkdirSync(destination, { recursive: true });

    let packedResult;
    try {
      // Releases supply the already-checked bytes; never replace them by repacking.
      packedResult = context.env.PACKAGE_ARCHIVE
        ? { archive: context.env.PACKAGE_ARCHIVE,
            manifest: JSON.parse(readFileSync(join(context.repoRoot, "package.json"), "utf8")) }
        : await packPackage(destination);
    } catch {
      throw new HarnessError("pack-failed");
    }
    ensure(isRecord(packedResult), "pack-failed");

    const archive = resolvePackArchive(packedResult.archive, destination, context.env);
    ensure(existsSync(archive), "archive-invalid");
    ensure(statSync(archive).isFile(), "archive-invalid");

    const entries = await inspectArchive(archive, context.env);
    const tree = join(root.root, "tree");
    await extractArchive(archive, tree, context.env);

    const packageDirectory = join(tree, "package");
    const manifestPath = join(packageDirectory, "package.json");
    ensure(existsSync(manifestPath), "archive-invalid");

    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch {
      throw new HarnessError("archive-invalid");
    }
    ensure(isRecord(manifest), "archive-invalid");
    assertPackedAllowlist(entries, manifest);

    if (isRecord(packedResult.manifest)) {
      for (const key of ["name", "version"]) {
        if (typeof packedResult.manifest[key] === "string" && typeof manifest[key] === "string") {
          ensure(packedResult.manifest[key] === manifest[key], "archive-invalid");
        }
      }
    }

    for (const path of normalizePackedFiles(packedResult.packed)) {
      ensure(entries.includes(path), "archive-invalid");
    }

    writeFileSync(
      join(root.agent, "settings.json"),
      `${JSON.stringify({ packages: [packageDirectory] }, null, 2)}\n`,
    );

    const environment = scenarioEnvironment(root.root, context.env);
    session = await RpcSession.start({
      command: context.piCommand,
      args: packageArguments(),
      cwd: root.cwd,
      env: environment,
    });
    commands = await exerciseRpcScenario(session, "package");
  } catch (error) {
    failure = toHarnessError(error);
  } finally {
    const finished = await finishScenario(session, failure, root);
    failure = finished.failure;
    cleanup = finished.cleanup;
  }

  return { failure, commands, cleanup };
}

async function headlessScenario(context) {
  const root = createScenarioRoot("headless");
  let session = null;
  let failure = null;
  let commands = [];
  let cleanup = "clean";

  try {
    const environment = scenarioEnvironment(root.root, context.env);
    session = await JsonSession.start({
      command: context.piCommand,
      args: headlessArguments(),
      cwd: root.cwd,
      env: environment,
      stdin: "ignore",
    });

    session.expectNaturalExit();
    const exit = await session.waitForExit(20_000);
    ensure(exit !== null, "json-timeout");
    session.assertHealthy();
    ensure(exit.code === 0, "process-failed");

    const messages = session.getCustomMessages();
    ensure(messages.length === 1, "message-mismatch");
    ensure(messages[0].customType === "template-greeting", "message-mismatch");
    ensure(messages[0].content === "Hello, Ada!", "message-mismatch");
    ensure(messages[0].display === true, "message-mismatch");
    commands = ["hello"];
  } catch (error) {
    failure = toHarnessError(error);
  } finally {
    const finished = await finishScenario(session, failure, root);
    failure = finished.failure;
    cleanup = finished.cleanup;
  }

  return { failure, commands, cleanup };
}

function checkRecord(name, failure, durationMs, commands, cleanup) {
  const error = failure ? toHarnessError(failure) : null;
  const cleanValue = cleanup === "failed" ? "failed" : cleanup === "not-run" ? "not-run" : "clean";
  return {
    name,
    status: error ? "fail" : "pass",
    durationMs: Math.max(0, Math.round(durationMs)),
    commands: safeCommandNames(commands.map((name) => ({ name }))),
    cleanup: cleanValue,
    errorCategory: error ? error.category : null,
  };
}

async function runCheck(name, scenario) {
  const started = Date.now();
  let outcome;
  try {
    outcome = await scenario();
  } catch (error) {
    outcome = { failure: toHarnessError(error), commands: [], cleanup: "not-run" };
  }

  let failure = outcome.failure ? toHarnessError(outcome.failure) : null;
  if (outcome.cleanup === "failed" && !failure) failure = new HarnessError("cleanup-failed");
  return checkRecord(name, failure, Date.now() - started, outcome.commands ?? [], outcome.cleanup);
}

function resultPath(repoRoot, env) {
  const configured = env.E2E_RESULT_PATH;
  if (typeof configured === "string" && configured.length > 0) {
    return isAbsolute(configured) ? configured : resolve(process.cwd(), configured);
  }
  return join(repoRoot, "artifacts", "e2e-result.json");
}

function writeResult(path, artifact) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

function printSummary(artifact, artifactPath, artifactWritten) {
  console.log(`e2e ${artifact.outcome} (${artifact.checks.length} checks, ${artifact.durationMs}ms)`);
  for (const check of artifact.checks) {
    const category = check.errorCategory ? ` [${check.errorCategory}]` : "";
    const cleanup = check.cleanup === "clean" ? "" : ` cleanup=${check.cleanup}`;
    console.log(`  ${check.name}: ${check.status}${category} (${check.durationMs}ms)${cleanup}`);
  }
  if (artifact.cleanup === "failed") console.log("  cleanup: failed");
  console.log(artifactWritten ? `  artifact: ${artifactPath}` : "  artifact: write failed");
}

async function runSmokeInternal(options = {}) {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const env = options.env ?? process.env;
  const started = Date.now();
  const checks = [];
  let versionInfo = null;
  let versionFailure = null;
  let piCommand = null;

  const versionStarted = Date.now();
  // PI_VERSION must equal the binary exactly when set (CI sets the baseline).
  // Otherwise the scripts/quality.json baseline is required. PI_BIN only selects
  // the binary; it does not bypass the expected-version check.
  try {
    versionInfo = await verifyPiVersion(repoRoot, env);
    versionFailure = versionInfo.failure;
    if (!versionFailure && versionInfo.actual !== versionInfo.expected) {
      versionFailure = new HarnessError("version-mismatch");
    }
    if (!versionFailure && versionInfo.cleanup === "failed") {
      versionFailure = new HarnessError("cleanup-failed");
    }
  } catch (error) {
    versionFailure = toHarnessError(error, "configuration-error");
  }
  checks.push(
    checkRecord(
      "pi-version",
      versionFailure,
      Date.now() - versionStarted,
      [],
      versionInfo?.cleanup ?? "not-run",
    ),
  );

  if (!versionFailure) {
    try {
      piCommand = resolvePiCommand(env);
      const context = { repoRoot, env, piCommand };
      checks.push(await runCheck("checkout", () => checkoutScenario(context)));
      checks.push(await runCheck("headless-json", () => headlessScenario(context)));
      checks.push(await runCheck("packed-archive", () => packedArchiveScenario(context)));
    } catch (error) {
      checks.push(checkRecord("environment", toHarnessError(error, "configuration-error"), 0, [], "not-run"));
    }
  }

  const cleanup = checks.some((check) => check.cleanup === "failed") ? "failed" : "clean";
  const failure = checks.find((check) => check.errorCategory);
  const outcome = !failure && cleanup === "clean" ? "pass" : "fail";

  const artifact = {
    schemaVersion: 1,
    outcome,
    nodeVersion: process.versions.node,
    piVersion: versionInfo?.actual ?? null,
    piBaseline: versionInfo?.baseline ?? null,
    piExpected: versionInfo?.expected ?? null,
    durationMs: Date.now() - started,
    cleanup,
    errorCategory: failure?.errorCategory ?? (cleanup === "failed" ? "cleanup-failed" : null),
    checks,
  };

  const artifactPath = resultPath(repoRoot, env);
  const artifactWritten = writeResult(artifactPath, artifact);
  printSummary(artifact, artifactPath, artifactWritten);

  return { artifact, artifactPath, artifactWritten, exitCode: artifact.outcome === "pass" && artifactWritten ? 0 : 1 };
}

export async function runSmoke(options = {}) {
  try {
    return await runSmokeInternal(options);
  } catch {
    const repoRoot = options?.repoRoot ?? REPO_ROOT;
    const env = options?.env ?? process.env;
    const started = Date.now();
    const checks = [
      checkRecord("environment", new HarnessError("unexpected-error"), 0, [], "not-run"),
    ];
    const artifact = {
      schemaVersion: 1,
      outcome: "fail",
      nodeVersion: process.versions.node,
      piVersion: null,
      piBaseline: null,
      piExpected: null,
      durationMs: Date.now() - started,
      cleanup: "clean",
      errorCategory: "unexpected-error",
      checks,
    };
    const artifactPath = resultPath(repoRoot, env);
    const artifactWritten = writeResult(artifactPath, artifact);
    printSummary(artifact, artifactPath, artifactWritten);
    return { artifact, artifactPath, artifactWritten, exitCode: 1 };
  }
}

export async function main() {
  const result = await runSmoke();
  return result.exitCode;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      console.error("e2e fail [unexpected-error]");
      process.exitCode = 1;
    },
  );
}
