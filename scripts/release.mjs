import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REGISTRY = "https://registry.npmjs.org";
export const MINIMUM_NPM_VERSION = [11, 5, 1];

const STABLE_TAG = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const STABLE_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const GITHUB_PART = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PLACEHOLDERS = new Set([
  "owner",
  "repository",
  "your-org",
  "your-repo",
  "your_org",
  "your_repo",
]);

function isPlaceholder(value) {
  return PLACEHOLDERS.has(value.toLowerCase());
}

function stableVersionFromTag(tag) {
  const match = typeof tag === "string" ? STABLE_TAG.exec(tag) : null;
  if (!match || match[0] !== tag) {
    throw new Error(
      "Expected a canonical stable vX.Y.Z tag without leading zeroes, prerelease, build metadata, or whitespace",
    );
  }
  return match[0].slice(1);
}

export function validateReleaseRef(refType, refName) {
  if (refType !== "tag") {
    throw new Error("Release must run from an actual canonical stable version tag, not a branch or pull request");
  }
  stableVersionFromTag(refName);
  return refName;
}

export function validatePackageName(name) {
  if (typeof name !== "string" || name.length > 214 || !PACKAGE_NAME.test(name)) {
    throw new Error("package.json name must be a valid lowercase npm package name");
  }
  return name;
}

export function validatePiVersion(piVersion) {
  const match = typeof piVersion === "string" ? STABLE_VERSION.exec(piVersion) : null;
  if (!match || match[0] !== piVersion) {
    throw new Error("scripts/quality.json piVersion must be a canonical stable X.Y.Z version");
  }
  return piVersion;
}

/**
 * Normalize a package.json repository value to the GitHub owner/repository
 * identity. Only GitHub URLs are accepted so the npm trusted-publisher identity
 * cannot silently point at another host.
 */
export function normalizeGitHubRepository(repository) {
  const value = repository && typeof repository === "object" ? repository.url : repository;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("package.json repository must contain a concrete GitHub URL");
  }

  let text = value.trim();
  if (text.startsWith("git+")) text = text.slice(4);
  if (/^git@github\.com:/i.test(text)) {
    text = `https://github.com/${text.slice("git@github.com:".length)}`;
  } else if (/^ssh:\/\/git@github\.com\//i.test(text)) {
    text = `https://github.com/${text.slice("ssh://git@github.com/".length)}`;
  }

  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error("package.json repository must be a canonical GitHub URL");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "github.com" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  ) {
    throw new Error("package.json repository must be a canonical HTTPS GitHub URL without credentials, port, query, or fragment");
  }

  const path = url.pathname.replace(/^\/+|\/+$/g, "");
  const parts = path.split("/");
  if (parts.length !== 2) {
    throw new Error("package.json repository must name exactly one GitHub owner and repository");
  }

  const owner = parts[0];
  let repo = parts[1];
  if (repo.toLowerCase().endsWith(".git")) repo = repo.slice(0, -4);
  if (!GITHUB_PART.test(owner) || !GITHUB_PART.test(repo) || repo === "." || repo === "..") {
    throw new Error("package.json repository owner and name must be canonical GitHub path segments");
  }
  if (isPlaceholder(owner) || isPlaceholder(repo)) {
    throw new Error("package.json repository still contains the OWNER/REPOSITORY template placeholder");
  }
  return { owner, repo, slug: `${owner}/${repo}` };
}

export function validateRepositoryIdentity(repository, githubRepository) {
  const parsed = normalizeGitHubRepository(repository);
  if (typeof githubRepository !== "string" || !githubRepository.trim()) {
    throw new Error("GITHUB_REPOSITORY is required to verify the package repository identity");
  }
  const expected = githubRepository.trim();
  const parts = expected.split("/");
  if (
    parts.length !== 2 ||
    !GITHUB_PART.test(parts[0]) ||
    !GITHUB_PART.test(parts[1]) ||
    parts.some(isPlaceholder)
  ) {
    throw new Error("github.repository must be a concrete owner/repository, not a template placeholder");
  }
  if (parsed.slug.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`package.json repository ${parsed.slug} does not match github.repository ${expected}`);
  }
  return parsed.slug;
}

export function validateChangelog(changelog, version) {
  if (typeof changelog !== "string" || !changelog.trim()) {
    throw new Error("CHANGELOG.md is required before publication");
  }
  const escaped = version.replaceAll(".", "\\.");
  const heading = new RegExp(`^#{1,6}[ \\t]+\\[?v?${escaped}\\]?(?=[ \\t(]|\\r?$)`, "m");
  if (!heading.test(changelog)) {
    throw new Error(`CHANGELOG.md must contain a heading for version ${version}`);
  }
  return version;
}

export function readReleaseMetadata({ refType, tag, manifest, changelog, githubRepository, piVersion }) {
  validateReleaseRef(refType, tag);
  const version = stableVersionFromTag(tag);
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("package.json must contain a JSON object");
  }
  validatePackageName(manifest.name);
  if (manifest.version !== version) {
    throw new Error("Tag must match package.json version exactly");
  }
  if (manifest.private !== undefined && typeof manifest.private !== "boolean") {
    throw new Error("package.json private must be a boolean when present");
  }
  const repository = validateRepositoryIdentity(manifest.repository, githubRepository);
  validateChangelog(changelog, version);
  const pinnedPiVersion = validatePiVersion(piVersion);
  return {
    tag,
    version,
    packageName: manifest.name,
    repository,
    piVersion: pinnedPiVersion,
    // Absence must not silently opt a template into publication.
    private: manifest.private !== false,
  };
}

export function assertPublishable(metadata, environment = process.env) {
  if (environment.ENABLE_NPM_PUBLISH !== "true") {
    throw new Error("Publication is disabled: set the ENABLE_NPM_PUBLISH repository variable to the exact string true");
  }
  if (metadata?.private !== false) {
    throw new Error("package.json must set private to false intentionally before publishing");
  }
  return true;
}

export function releaseNotes(metadata) {
  return `## Pi extension\n\n` +
    `Published **${metadata.packageName}@${metadata.version}** to npm.\n\n` +
    `\`\`\`bash\npi install npm:${metadata.packageName}@${metadata.version}\n\`\`\`\n\n` +
    `Validated with Pi **${metadata.piVersion}** from \`${metadata.repository}\`.\n`;
}

export function computeIntegrity(archive) {
  if (!Buffer.isBuffer(archive) || archive.length === 0) {
    throw new Error("Release archive must be a non-empty buffer");
  }
  return `sha512-${createHash("sha512").update(archive).digest("base64")}`;
}

export function requireNpmVersion(version, minimum = MINIMUM_NPM_VERSION) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(version).trim());
  if (!match) throw new Error(`Unreadable npm version: ${version}`);
  const actual = match.slice(1, 4).map(Number);
  for (let index = 0; index < 3; index++) {
    if (actual[index] > minimum[index]) return String(version).trim();
    if (actual[index] < minimum[index]) {
      throw new Error(`npm ${String(version).trim()} is too old for OIDC trusted publishing; npm 11.5.1 or newer is required`);
    }
  }
  return String(version).trim();
}

export async function checkPublication(metadata, archive, request = fetch) {
  const integrity = computeIntegrity(archive);
  const url = `${REGISTRY}/${encodeURIComponent(metadata.packageName)}/${encodeURIComponent(metadata.version)}`;
  let response;
  try {
    response = await request(url, {
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
      headers: { accept: "application/json" },
    });
  } catch (error) {
    throw new Error(`npm registry lookup failed: ${error instanceof Error ? error.message : "network error"}`);
  }

  if (response.status === 404) return "publish";
  if (response.status !== 200) {
    throw new Error(`npm registry lookup failed (HTTP ${response.status}); refusing to publish`);
  }

  let existing;
  try {
    existing = await response.json();
  } catch {
    throw new Error("npm registry returned malformed JSON; refusing to publish");
  }
  if (existing?.name !== metadata.packageName || existing?.version !== metadata.version) {
    throw new Error("npm registry package identity mismatch; refusing to skip publication");
  }
  if (existing?.dist?.integrity !== integrity) {
    throw new Error("Existing npm version has different or missing archive integrity; refusing to skip it");
  }
  return "skip";
}

export function verifyArchiveFile(archivePath) {
  const absolute = isAbsolute(archivePath) ? archivePath : resolve(archivePath);
  let stats;
  try {
    stats = lstatSync(absolute);
  } catch {
    throw new Error("Release archive is missing or unreadable");
  }
  if (stats.isSymbolicLink() || !stats.isFile() || stats.size === 0) {
    throw new Error("Release archive must be a non-empty regular file, not a symlink");
  }
  return { absolute, archive: readFileSync(absolute) };
}

export function verifyReleaseRecord(record, metadata, archive) {
  if (!record || typeof record !== "object" || record.schemaVersion !== 1) {
    throw new Error("Release metadata is missing or has an unsupported schema");
  }
  if (
    record.tag !== metadata.tag ||
    record.version !== metadata.version ||
    record.name !== metadata.packageName ||
    record.repository !== metadata.repository ||
    record.piVersion !== metadata.piVersion ||
    record.private !== metadata.private
  ) {
    throw new Error("Release metadata does not match the tagged source identity");
  }
  if (record.archive !== "package.tgz") {
    throw new Error("Release metadata names an unexpected archive");
  }
  const integrity = computeIntegrity(archive);
  if (record.integrity !== integrity || record.size !== archive.length) {
    throw new Error("Release archive integrity does not match release metadata; refusing to publish");
  }
  return integrity;
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`${label} must exist and contain valid JSON`);
  }
}

function readText(path, label) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw new Error(`${label} is missing or unreadable`);
  }
}

function loadSource(cwd = process.cwd()) {
  const manifest = readJson(resolve(cwd, "package.json"), "package.json");
  const changelog = readText(resolve(cwd, "CHANGELOG.md"), "CHANGELOG.md");
  const quality = readJson(resolve(cwd, "scripts/quality.json"), "scripts/quality.json");
  return { manifest, changelog, piVersion: validatePiVersion(quality.piVersion) };
}

function loadMetadata(environment = process.env, cwd = process.cwd()) {
  const source = loadSource(cwd);
  return readReleaseMetadata({
    refType: environment.RELEASE_REF_TYPE,
    tag: environment.RELEASE_TAG,
    manifest: source.manifest,
    changelog: source.changelog,
    githubRepository: environment.GITHUB_REPOSITORY,
    piVersion: source.piVersion,
  });
}

/**
 * Pack exactly once through scripts/check-package.mjs, verify the archive, and
 * write the immutable release record and notes used by later workflow jobs.
 */
export async function prepareRelease({ destination = "release", cwd = process.cwd(), environment = process.env } = {}) {
  const source = loadSource(cwd);
  const metadata = readReleaseMetadata({
    refType: environment.RELEASE_REF_TYPE,
    tag: environment.RELEASE_TAG,
    manifest: source.manifest,
    changelog: source.changelog,
    githubRepository: environment.GITHUB_REPOSITORY,
    piVersion: source.piVersion,
  });
  assertPublishable(metadata, environment);

  const releaseDirectory = resolve(cwd, destination);
  mkdirSync(releaseDirectory, { recursive: true });
  for (const name of ["package.tgz", "notes.md", "release.json"]) {
    rmSync(resolve(releaseDirectory, name), { force: true });
  }

  const checkPackage = await import("./check-package.mjs");
  if (typeof checkPackage.packPackage !== "function" || typeof checkPackage.verifyPack !== "function") {
    throw new Error("scripts/check-package.mjs must export packPackage and verifyPack");
  }

  const result = await checkPackage.packPackage(releaseDirectory);
  if (!result || typeof result !== "object") {
    throw new Error("packPackage must return { archive, manifest, packed }");
  }
  const { archive, manifest: packedManifest, packed } = result;
  if (typeof archive !== "string" || !isAbsolute(archive) || resolve(archive) !== archive) {
    throw new Error("packPackage must return a normalized absolute archive filename");
  }
  if (
    !packedManifest ||
    packedManifest.name !== source.manifest.name ||
    packedManifest.version !== source.manifest.version ||
    (packedManifest.private !== undefined && packedManifest.private !== source.manifest.private)
  ) {
    throw new Error("Packaged manifest identity does not match the tagged source");
  }

  const verifiedFilename = await checkPackage.verifyPack(packed, source.manifest);
  if (typeof verifiedFilename === "string" && basename(archive) !== verifiedFilename) {
    throw new Error("Packaged archive filename does not match the verified npm pack result");
  }

  const bytes = verifyArchiveFile(archive).archive;
  const integrity = computeIntegrity(bytes);
  if (Array.isArray(packed) && typeof packed[0]?.integrity === "string" && packed[0].integrity !== integrity) {
    throw new Error("npm pack reported a different archive integrity");
  }

  const finalArchive = resolve(releaseDirectory, "package.tgz");
  if (archive !== finalArchive) {
    rmSync(finalArchive, { force: true });
    renameSync(archive, finalArchive);
  }

  const record = {
    schemaVersion: 1,
    tag: metadata.tag,
    version: metadata.version,
    name: metadata.packageName,
    repository: metadata.repository,
    piVersion: metadata.piVersion,
    private: metadata.private,
    archive: "package.tgz",
    integrity,
    size: bytes.length,
  };
  writeFileSync(resolve(releaseDirectory, "release.json"), `${JSON.stringify(record, null, 2)}\n`);
  writeFileSync(resolve(releaseDirectory, "notes.md"), releaseNotes(metadata));

  return { ...metadata, archive: finalArchive, integrity, size: bytes.length };
}

function output(values) {
  const entries = Object.entries(values);
  for (const [key, value] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || /[\r\n]/.test(String(value))) {
      throw new Error("Unsafe workflow output value");
    }
  }
  const text = entries.map(([key, value]) => `${key}=${value}\n`).join("");
  process.stdout.write(text);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, text);
}

async function main() {
  switch (process.argv[2]) {
    case "verify": {
      const metadata = loadMetadata();
      output({
        tag: metadata.tag,
        version: metadata.version,
        package_name: metadata.packageName,
        repository: metadata.repository,
        pi_version: metadata.piVersion,
        private: metadata.private,
        publish_enabled: process.env.ENABLE_NPM_PUBLISH === "true",
      });
      break;
    }
    case "assert-publishable": {
      assertPublishable(loadMetadata(), process.env);
      output({ publish_enabled: true });
      break;
    }
    case "prepare": {
      const result = await prepareRelease();
      output({
        tag: result.tag,
        version: result.version,
        package_name: result.packageName,
        pi_version: result.piVersion,
        archive: result.archive,
        integrity: result.integrity,
      });
      break;
    }
    case "check-publication": {
      const metadata = loadMetadata();
      assertPublishable(metadata, process.env);
      const record = readJson(resolve("release/release.json"), "release/release.json");
      const { archive } = verifyArchiveFile(resolve("release/package.tgz"));
      verifyReleaseRecord(record, metadata, archive);
      const action = await checkPublication(metadata, archive);
      output({ action, integrity: computeIntegrity(archive) });
      break;
    }
    case "check-npm": {
      const version = requireNpmVersion(execFileSync("npm", ["--version"], { encoding: "utf8" }));
      output({ npm_version: version });
      break;
    }
    default:
      throw new Error(
        "Usage: node scripts/release.mjs verify|assert-publishable|prepare|check-publication|check-npm",
      );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
