import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const escape = value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;").replaceAll("|", "&#124;").replaceAll("\n", " ").replaceAll("\r", " ");

/** Render only known safe fields; never include raw failure messages or protocol data. */
export function renderSummary(result) {
  if (!result) return "# Pi smoke\n\nNo result was produced. Compatibility is unproven; inspect setup/runner steps.\n";
  if (result.schemaVersion !== 1 || !["pass", "fail"].includes(result.outcome) || !Array.isArray(result.checks)) {
    throw new Error("Invalid smoke result schema");
  }
  const version = value => typeof value === "string" && /^\d+\.\d+\.\d+$/.test(value) ? value : "unavailable";
  const cleanup = value => ["clean", "failed", "not-run"].includes(value) ? value : "unknown";
  const rows = result.checks.map(check => {
    const name = typeof check.name === "string" && /^[a-z-]{1,64}$/.test(check.name) ? check.name : "unknown";
    const status = ["pass", "fail"].includes(check.status) ? check.status : "unknown";
    const category = typeof check.errorCategory === "string" && /^[a-z-]{1,64}$/.test(check.errorCategory) ? check.errorCategory : "none";
    return `| ${escape(name)} | ${status} | ${category} | ${cleanup(check.cleanup)} |`;
  });
  return `# Pi smoke: ${result.outcome}\n\nNode: ${version(result.nodeVersion)} · Pi: ${version(result.piVersion)} · Cleanup: ${cleanup(result.cleanup)}\n\n` +
    "| Check | Status | Failure category | Cleanup |\n| --- | --- | --- | --- |\n" + rows.join("\n") + "\n";
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const path = process.env.E2E_RESULT_PATH || "artifacts/e2e-result.json";
  const text = renderSummary(existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
  else process.stdout.write(text);
}
