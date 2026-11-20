import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_FILES = new Set(["package.json", "README.md", "LICENSE", "CHANGELOG.md"]);

/** Explicit starter policy. Extend together with tests when adding shipped resources. */
export function allowedPackagePath(path) {
  if (typeof path !== "string" || path.includes("\\") || path.includes("\0")) return false;
  const parts = path.split("/");
  if (parts.some(part => !part || part === "." || part === ".." || part.startsWith("."))) return false;
  if (ROOT_FILES.has(path)) return true;
  return parts[0] === "src" && parts.length > 1 && path.endsWith(".ts") &&
    parts.every(part => !/^(?:AGENTS|CLAUDE|GEMINI)\./i.test(part)) &&
    !/\.(?:test|spec)\.ts$/.test(path);
}

export function verifyPack(result, manifest) {
  assert.ok(Array.isArray(result) && result.length === 1, "Expected one npm pack result");
  const packed = result[0];
  assert.equal(packed.name, manifest.name, "Packed name mismatch");
  assert.equal(packed.version, manifest.version, "Packed version mismatch");
  assert.match(packed.filename, /^[a-zA-Z0-9._-]+\.tgz$/, "Unsafe archive filename");
  assert.ok(Array.isArray(packed.files) && packed.files.length > 0, "Missing packed file list");
  const paths = packed.files.map(file => file.path);
  assert.equal(new Set(paths).size, paths.length, "Duplicate packed paths");
  assert.ok(paths.every(allowedPackagePath), "Unexpected package contents (review the allowlist)");
  for (const required of ROOT_FILES) assert.ok(paths.includes(required), `Missing ${required}`);
  assert.ok(Array.isArray(manifest.pi?.extensions) && manifest.pi.extensions.length > 0, "Missing Pi extension manifest");
  for (const entry of manifest.pi.extensions) {
    assert.ok(typeof entry === "string", "Entry point must be a literal path");
    const path = entry.startsWith("./") ? entry.slice(2) : entry;
    assert.ok(allowedPackagePath(path) && paths.includes(path), "Missing or unsafe Pi entry point");
  }
  return packed.filename;
}

/** Pack once, suppress lifecycle scripts, check contents and bytes. Caller owns destination cleanup. */
export function packPackage(destination) {
  assert.ok(isAbsolute(destination), "Pack destination must be absolute");
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));
  const packed = JSON.parse(execFileSync("npm", [
    "pack", "--json", "--ignore-scripts", "--pack-destination", destination,
  ], { encoding: "utf8", timeout: 60_000, maxBuffer: 2 * 1024 * 1024 }));
  const filename = verifyPack(packed, manifest);
  const archive = resolve(destination, filename);
  const bytes = readFileSync(archive);
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  assert.equal(integrity, packed[0].integrity, "Archive differs from npm pack metadata");
  return { archive, manifest, packed };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const destination = mkdtempSync(join(tmpdir(), "pi-template-pack-"));
  try {
    const { packed } = packPackage(destination);
    console.log(`Package allowlist: ${packed[0].files.length} approved files`);
    for (const { path } of packed[0].files) console.log(`  ${path}`);
  } finally {
    rmSync(destination, { recursive: true, force: true });
  }
}
