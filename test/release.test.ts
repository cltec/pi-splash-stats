import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertPublishable,
  checkPublication,
  computeIntegrity,
  normalizeGitHubRepository,
  readReleaseMetadata,
  releaseNotes,
  requireNpmVersion,
  validateChangelog,
  validatePackageName,
  validatePiVersion,
  validateReleaseRef,
  verifyReleaseRecord,
} from "../scripts/release.mjs";

const cli = fileURLToPath(new URL("../scripts/release.mjs", import.meta.url));
const manifest = {
  name: "pi-extension-template",
  version: "0.1.0",
  private: false,
  repository: { type: "git", url: "git+https://github.com/acme/example-extension.git" },
};
const changelog = "# Changelog\n\n## [0.1.0] - 2026-01-01\n\n- Initial release.\n";
const releaseInput = {
  refType: "tag",
  tag: "v0.1.0",
  manifest,
  changelog,
  githubRepository: "acme/example-extension",
  piVersion: "1.5.2",
};
const metadata = readReleaseMetadata(releaseInput);
const archive = Buffer.from("a checked package archive");
const integrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`;

function fixture({ privateValue = false, repository = manifest.repository } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "release-fixture-"));
  mkdirSync(join(cwd, "scripts"));
  writeFileSync(join(cwd, "package.json"), JSON.stringify({
    ...manifest,
    private: privateValue,
    repository,
  }));
  writeFileSync(join(cwd, "CHANGELOG.md"), changelog);
  writeFileSync(join(cwd, "scripts/quality.json"), JSON.stringify({ piVersion: "1.5.2" }));
  return cwd;
}

function runCli(args, cwd, environment = {}) {
  const env = { PATH: process.env.PATH, HOME: cwd, ...environment };
  for (const name of ["GITHUB_OUTPUT", "ENABLE_NPM_PUBLISH"]) {
    if (!Object.hasOwn(environment, name)) delete env[name];
  }
  return spawnSync(process.execPath, [cli, ...args], { cwd, env, encoding: "utf8", timeout: 10_000 });
}

test("release dispatch must target an actual canonical stable tag, never a branch", () => {
  assert.equal(validateReleaseRef("tag", "v0.1.0"), "v0.1.0");
  assert.throws(() => readReleaseMetadata({ ...releaseInput, refType: undefined }), /version tag/i);
  for (const [type, name] of [
    ["branch", "main"],
    ["pull_request", "v0.1.0"],
    ["tag", "0.1.0"],
    ["tag", "v0.1.0rc1"],
    ["tag", "v0.1.0\n"],
  ]) {
    assert.throws(() => validateReleaseRef(type, name), /canonical stable/i);
  }
});

test("release metadata retains the exact package, tag, repository, private flag, and Pi pin", () => {
  assert.deepEqual(metadata, {
    tag: "v0.1.0",
    version: "0.1.0",
    packageName: "pi-extension-template",
    repository: "acme/example-extension",
    piVersion: "1.5.2",
    private: false,
  });
  assert.equal(readReleaseMetadata({ ...releaseInput, manifest: { ...manifest, private: true } }).private, true);
  assert.equal(readReleaseMetadata({ ...releaseInput, manifest: { ...manifest, private: undefined } }).private, true);
});

for (const tag of [
  "0.1.0",
  "v01.1.1",
  "v0.01.1",
  "v0.1.01",
  "v0.1.1-beta.1",
  "v0.1.1+build",
  "v0.1",
  "v0.1.1\n",
  "v0.1.1;echo bad",
]) {
  test(`rejects noncanonical stable tag ${JSON.stringify(tag)}`, () => {
    assert.throws(() => readReleaseMetadata({ ...releaseInput, tag }), /canonical stable/i);
  });
}

test("rejects a tag that disagrees with the manifest before packaging", () => {
  assert.throws(() => readReleaseMetadata({ ...releaseInput, tag: "v0.1.1" }), /match/i);
});

test("accepts only valid lowercase npm package names", () => {
  for (const name of ["pi-extension-template", "@scope/pi-extension-template", "a".repeat(214)]) {
    assert.equal(validatePackageName(name), name);
  }
  for (const name of ["", "Pi-Extension", "bad name", "@scope/", "@Scope/name", "a".repeat(215)]) {
    assert.throws(() => validatePackageName(name), /package name/i);
  }
});

test("accepts canonical GitHub repository forms and rejects placeholders and mismatches", () => {
  for (const repository of [
    "https://github.com/acme/example-extension",
    "https://github.com/acme/example-extension.git",
    "git+https://github.com/acme/example-extension.git",
    "git@github.com:acme/example-extension.git",
    "ssh://git@github.com/acme/example-extension.git",
    { type: "git", url: "git+ssh://git@github.com/acme/example-extension.git" },
  ]) {
    assert.equal(normalizeGitHubRepository(repository).slug, "acme/example-extension");
  }

  for (const repository of [
    "https://github.com/OWNER/REPOSITORY.git",
    { url: "https://github.com/owner/repo" },
    "https://gitlab.com/acme/example-extension",
    "https://www.github.com/acme/example-extension",
    "https://user:pass@github.com/acme/example-extension",
    "git://github.com/acme/example-extension.git",
    "https://github.com/acme/example-extension/tree/main",
    "https://github.com/acme/example-extension.git?ref=main",
  ]) {
    assert.throws(() => normalizeGitHubRepository(repository), /repository/i);
  }

  assert.equal(
    readReleaseMetadata({ ...releaseInput, githubRepository: "Acme/Example-Extension" }).repository,
    "acme/example-extension",
  );
  assert.throws(
    () => readReleaseMetadata({ ...releaseInput, githubRepository: "acme/other" }),
    /does not match/i,
  );
  assert.throws(
    () => readReleaseMetadata({ ...releaseInput, githubRepository: "OWNER/REPOSITORY" }),
    /placeholder/i,
  );
  assert.throws(
    () => readReleaseMetadata({ ...releaseInput, githubRepository: "" }),
    /GITHUB_REPOSITORY/i,
  );
});

test("requires a changelog heading for the exact release version", () => {
  for (const text of [
    "# Changelog\n\n## [0.1.00]\n",
    "# Changelog\n\n## [0.1.0-rc.1]\n",
    "# Changelog\n\n## 0.1.0.1\n",
    "# Changelog\n\n## 1.0.0\n",
    "# Changelog\n",
    "",
  ]) {
    assert.throws(() => validateChangelog(text, "0.1.0"), /CHANGELOG/i);
  }
  for (const text of ["## 0.1.0\n", "## [0.1.0](https://example.test) - 2026-01-01\n", "### v0.1.0\n", "## [0.1.0]\r\n"]) {
    assert.equal(validateChangelog(text, "0.1.0"), "0.1.0");
  }
});

test("requires a canonical stable Pi pin", () => {
  assert.equal(validatePiVersion("1.5.2"), "1.5.2");
  for (const version of ["v1.5.2", "1.5", "01.5.2", "1.5.2\n", "1.5.2-beta.1"]) {
    assert.throws(() => validatePiVersion(version), /piVersion/i);
  }
});

test("publication requires the exact repository variable and an intentionally public package", () => {
  assert.throws(() => assertPublishable(metadata, {}), /disabled/i);
  assert.throws(
    () => assertPublishable({ ...metadata, private: true }, { ENABLE_NPM_PUBLISH: "true" }),
    /private/i,
  );
  assert.throws(
    () => assertPublishable(metadata, { ENABLE_NPM_PUBLISH: "TRUE" }),
    /disabled/i,
  );
  assert.equal(assertPublishable(metadata, { ENABLE_NPM_PUBLISH: "true" }), true);
});

test("release notes use the tagged package identity, not a hardcoded template name", () => {
  const notes = releaseNotes(metadata);
  assert.match(notes, /pi-extension-template@0\.1\.0/);
  assert.match(notes, /pi install npm:pi-extension-template@0\.1\.0/);
  assert.match(notes, /1\.5\.2/);
  assert.doesNotMatch(notes, /npm:other-package/);
});

test("a real registry 404 permits a new publication", async () => {
  const action = await checkPublication(metadata, archive, async (url) => {
    assert.equal(url, "https://registry.npmjs.org/pi-extension-template/0.1.0");
    return new Response('{"error":"Not found"}', { status: 404 });
  });
  assert.equal(action, "publish");
});

test("registry lookup encodes a scoped package identity", async () => {
  const scoped = { ...metadata, packageName: "@scope/pi-extension-template" };
  await checkPublication(scoped, archive, async (url) => {
    assert.equal(url, "https://registry.npmjs.org/%40scope%2Fpi-extension-template/0.1.0");
    return new Response("", { status: 404 });
  });
});

test("an identical registry archive allows completing a missing GitHub release on retry", async () => {
  const action = await checkPublication(metadata, archive, async () => Response.json({
    name: metadata.packageName,
    version: metadata.version,
    dist: { integrity },
  }));
  assert.equal(action, "skip");
});

test("an existing version with different or missing integrity is not silently accepted", async () => {
  for (const dist of [{ integrity: "sha512-different" }, {}, { integrity: null }]) {
    await assert.rejects(checkPublication(metadata, archive, async () => Response.json({
      name: metadata.packageName,
      version: metadata.version,
      dist,
    })), /integrity/i);
  }
});

test("registry identity must match even if integrity is the same", async () => {
  for (const value of [
    { name: "another-package", version: metadata.version, dist: { integrity } },
    { name: metadata.packageName, version: "0.1.1", dist: { integrity } },
  ]) {
    await assert.rejects(checkPublication(metadata, archive, async () => Response.json(value)), /identity/i);
  }
});

for (const status of [401, 403, 429, 500, 503]) {
  test(`registry HTTP ${status} is an error, not permission to publish`, async () => {
    await assert.rejects(
      checkPublication(metadata, archive, async () => new Response("unavailable", { status })),
      /registry/i,
    );
  });
}

test("registry network errors and malformed JSON fail closed", async () => {
  await assert.rejects(
    checkPublication(metadata, archive, async () => { throw new Error("network down"); }),
    /network down/,
  );
  await assert.rejects(
    checkPublication(metadata, archive, async () => new Response("not JSON", { status: 200 })),
    /malformed JSON/i,
  );
});

test("release metadata binds the archive size and SHA-512 integrity", () => {
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
    size: archive.length,
  };
  assert.equal(verifyReleaseRecord(record, metadata, archive), integrity);

  for (const bad of [
    { ...record, integrity: "sha512-different" },
    { ...record, size: archive.length + 1 },
    { ...record, tag: "v0.1.1" },
    { ...record, repository: "acme/other" },
    { ...record, schemaVersion: 2 },
  ]) {
    assert.throws(() => verifyReleaseRecord(bad, metadata, archive), /release metadata|integrity/i);
  }
});

test("npm newer than 11.5.1 is accepted and older versions fail closed", () => {
  for (const version of ["11.5.1", "11.6.0", "12.0.0", "12.2.0-beta.1"]) {
    assert.equal(requireNpmVersion(version), version);
  }
  for (const version of ["11.5.0", "11.4.9", "10.9.8"]) {
    assert.throws(() => requireNpmVersion(version), /too old/i);
  }
  assert.throws(() => requireNpmVersion("not-a-version"), /Unreadable/i);
});

test("verify CLI validates the tagged fixture and emits workflow outputs", () => {
  const cwd = fixture();
  try {
    const output = join(cwd, "outputs");
    const result = runCli(["verify"], cwd, {
      RELEASE_REF_TYPE: "tag",
      RELEASE_TAG: "v0.1.0",
      GITHUB_REPOSITORY: "acme/example-extension",
      ENABLE_NPM_PUBLISH: "false",
      GITHUB_OUTPUT: output,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /version=0\.1\.0\n/);
    assert.match(result.stdout, /pi_version=1\.5\.2\n/);
    assert.match(result.stdout, /publish_enabled=false\n/);
    assert.match(readFileSync(output, "utf8"), /repository=acme\/example-extension\n/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("verify CLI rejects a branch dispatch before any publication step", () => {
  const cwd = fixture();
  try {
    const result = runCli(["verify"], cwd, {
      RELEASE_REF_TYPE: "branch",
      RELEASE_TAG: "main",
      GITHUB_REPOSITORY: "acme/example-extension",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /canonical stable version tag/i);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("private packages cannot be prepared even when the repository variable is enabled", () => {
  const cwd = fixture({ privateValue: true });
  try {
    const result = runCli(["prepare"], cwd, {
      RELEASE_REF_TYPE: "tag",
      RELEASE_TAG: "v0.1.0",
      GITHUB_REPOSITORY: "acme/example-extension",
      ENABLE_NPM_PUBLISH: "true",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /private/i);
    assert.equal(existsSync(join(cwd, "release/package.tgz")), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("assert-publishable CLI fails closed unless variable and manifest are both ready", () => {
  const cwd = fixture();
  try {
    const baseEnv = {
      RELEASE_REF_TYPE: "tag",
      RELEASE_TAG: "v0.1.0",
      GITHUB_REPOSITORY: "acme/example-extension",
    };
    const disabled = runCli(["assert-publishable"], cwd, baseEnv);
    assert.notEqual(disabled.status, 0);
    assert.match(disabled.stderr, /disabled/i);

    const enabled = runCli(["assert-publishable"], cwd, {
      ...baseEnv,
      ENABLE_NPM_PUBLISH: "true",
    });
    assert.equal(enabled.status, 0, enabled.stderr);
    assert.match(enabled.stdout, /publish_enabled=true/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("release workflow keeps publication gated, job-scoped, and non-cancelling", () => {
  const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /tags: \["v\*"\]/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /contents: write/);
  assert.match(workflow, /publish_enabled == 'true'/);
  assert.match(workflow, /node: \[22, 24\]/);
  assert.match(workflow, /node-version: 24/);
  assert.doesNotMatch(workflow, /NPM_TOKEN|NODE_AUTH_TOKEN|secrets\./);
});
