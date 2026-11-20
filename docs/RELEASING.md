# Releasing a Pi extension

This template releases from an explicit, manually pushed stable tag. It does **not** create tags on merge, publish on merge, or auto-merge release pull requests. Publishing is disabled by default with both:

- `"private": true` in `package.json`.
- The `ENABLE_NPM_PUBLISH` repository variable, which must be the exact string `true`.

The release workflow validates the tag and package identity before any publication work. If the variable is absent or not exactly `true`, the validation, Node 22/24 checks, and Pi smoke still run, but the package, publish, and GitHub Release jobs are skipped. If the variable is `true` while the package is still private, the validation job fails closed before packing.

The repository in `package.json` is also a guard. Until `OWNER/REPOSITORY` is replaced and it matches `github.repository`, release validation fails.

## One-time setup

### 1. Make the package publishable

Complete the template setup first. At minimum:

- Replace `OWNER` and `REPOSITORY` in `package.json`, documentation, and workflow references.
- Set the real package `name`, `version`, `description`, and repository metadata.
- Keep `repository` as the canonical GitHub URL for the repository that runs this workflow.
- Change `"private": true` to `"private": false` only when you are ready to publish.
- Keep the Pi baseline in `scripts/quality.json`; this template pins `1.5.2`.
- Add a changelog heading for the exact version, for example `## [0.2.0]`. The release script rejects a missing or mismatched heading.

The package allowlist is checked by `npm run check`. Do not widen it to make development files publishable.

### 2. Enable the repository variable

In the GitHub repository, open **Settings → Secrets and variables → Actions → Variables** and create a repository variable:

| Name | Value |
| --- | --- |
| `ENABLE_NPM_PUBLISH` | `true` |

This is a variable, not a secret. Anything other than the exact lowercase value `true` leaves publication disabled. Do not add `NPM_TOKEN`, `NODE_AUTH_TOKEN`, or any npm/GitHub personal token for this workflow.

### 3. Bootstrap the npm package, if needed

If the npm package does not exist yet, publish the reviewed `0.1.0` package manually from a clean checkout with your npm account and two-factor authentication. This is a one-time local bootstrap, not a CI credential.

Before publishing, run the package checks and inspect the exact pack contents:

```bash
npm run check
npm pack --dry-run --ignore-scripts
```

Then log in and publish:

```bash
npm login --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/
npm publish --registry=https://registry.npmjs.org/ --ignore-scripts
```

Add `--access public` when publishing a scoped package. Complete npm's browser and 2FA prompts. Never reuse an old package name or publish from an uncommitted checkout. Once the package exists, configure its trusted publisher.

### 4. Configure npm trusted publishing

Open the package on npm → **Settings → Trusted publishing → GitHub Actions** and enter the exact values for this repository:

| Field | Value |
| --- | --- |
| Organization or user | The GitHub owner, case-sensitive |
| Repository | The GitHub repository name, case-sensitive |
| Workflow filename | `release.yml` |
| Environment name | Leave blank unless you deliberately add a GitHub environment |

The workflow filename is `release.yml`, not `.github/workflows/release.yml`. The file must exist at `.github/workflows/release.yml` in the repository. Newer trusted-publisher configurations may allow staged publishing by default; also enable direct `npm publish` because this workflow publishes directly. It does not manage dist-tags. npm matches the package's `repository.url` to the GitHub repository, so keep that metadata exact.

npm requires npm CLI **11.5.1 or newer** and Node **22.14.0 or newer** for trusted publishing, and supports cloud-hosted runners such as GitHub-hosted runners. The workflow uses Node 24 and runs `scripts/release.mjs check-npm` before publishing. Self-hosted runners are not supported by this setup.

A newly created trusted-publisher configuration must complete its first successful publish within **two days**. If it expires, delete and recreate the configuration before retrying. Configure it when you are ready to release, not weeks in advance.

npm automatically generates provenance for trusted publishing when the source repository and the package are public. Provenance is not generated for private repositories, even when the package itself is public. No `--provenance` flag is needed.

Do not wrap the publishing command in a reusable workflow. Configure npm for the workflow that actually runs `npm publish`, which is the `publish` job in `release.yml`.

### 5. Protect the release boundary

- Keep branch protection and tag protection or rulesets for `v*` tags.
- Allow GitHub Actions to use the job permissions declared in `release.yml`.
- Keep `contents: read` at the workflow level. Only the publish job gets `id-token: write`; only the GitHub Release job gets `contents: write`.
- Do not add secrets to this workflow, and do not let an unrelated workflow publish the package.
- After trusted publishing works, consider npm's **Require two-factor authentication and disallow tokens** setting.

## Prepare the version

Choose the next stable version deliberately. Release pull requests are reviewed like any other change:

```bash
git switch -c chore/release-v0.2.0
npm version 0.2.0 --no-git-tag-version
```

Update `CHANGELOG.md` with an exact `0.2.0` heading, then verify:

```bash
npm run check
PI_BIN=/absolute/path/to/pi npm run test:e2e
npm pack --dry-run --ignore-scripts
```

`npm run check` runs the offline tests and the package allowlist check. It does not launch Pi. `npm run test:e2e` is the real-Pi smoke test and reads `PI_BIN`; its version must match `scripts/quality.json`, or `PI_VERSION` may set the exact stable version for a temporary experiment. The release workflow installs the exact Pi tarball from `scripts/quality.json` into a temporary prefix outside the checkout and sets `PI_BIN` for you.

Commit `package.json` and `CHANGELOG.md`, open a pull request, review it, and merge it normally. **Merging does not create a tag or publish anything.**

## Create and push the release tag

Tag the reviewed commit, not a later moving tip:

```bash
git tag -a v0.2.0 <reviewed-commit-sha> -m "v0.2.0"
git push origin v0.2.0
```

The tag must be a canonical stable `vX.Y.Z` tag. Leading zeroes, prereleases, build metadata, branches, and pull-request refs are rejected. The tag version must equal `package.json.version` exactly (`v0.2.0` ↔ `0.2.0`).

Alternatively, after the tag exists, dispatch the release workflow at that tag:

```bash
gh workflow run release.yml --ref v0.2.0
```

In the GitHub UI, choose **Actions → Release → Run workflow** and select the tag, not `main` or another branch. The workflow checks `github.ref_type == "tag"` and refuses a branch dispatch.

Prepare one release at a time. The concurrency group does not cancel an active publication, but GitHub keeps at most one pending run per group; it is not a durable queue for every intermediate version.

## What the release workflow does

The workflow is split so publication cannot start before the exact tagged source passes every gate.

1. **Preflight** validates the ref, canonical stable tag, `package.json` version, real GitHub repository identity against `github.repository`, non-placeholder repository, changelog heading, and the `scripts/quality.json` Pi pin. It also reads the publication gate. If the gate is enabled, it additionally requires `"private": false`.
2. **Offline check** runs on Node 22 and 24. Each job revalidates the tag identity and runs `npm run check`.
3. **Pi smoke** installs the exact Pi tarball named by the pinned `piVersion` into a temporary prefix outside the checkout, sets `PI_BIN`, and runs `npm run test:e2e` against the source: checkout RPC, headless JSON, and a freshly packed archive. That packed archive is temporary.
4. **Package** runs only after both checks pass. `scripts/release.mjs prepare` calls the package checker once, verifies the npm pack result, computes the archive SHA-512, writes `release/release.json` and `release/notes.md`, and uploads the checked archive as an artifact. It then runs an extra `npm run test:e2e` with `PACKAGE_ARCHIVE` pointing at `release/package.tgz`, so the exact bytes that will be published are extracted and loaded. E2E and offline steps may create temporary packs; only this final release tarball is preserved and published.
5. **Publish** downloads that same artifact, revalidates the tagged source identity and the recorded archive size/integrity, then checks npm:
   - `404` means the version is absent and may be published.
   - `200` with the same package name, version, and SHA-512 integrity means an earlier attempt already published this exact archive; publication is skipped so a missing GitHub Release can be completed.
   - Any other status, identity mismatch, missing integrity, or different integrity fails closed. The workflow never overwrites or guesses.
   It then runs `npm publish <checked-tarball>` with npm OIDC. The project is not installed and no npm token is used.
6. **GitHub Release** runs only after the publish job succeeds. It creates `vX.Y.Z` with the release notes and generated GitHub notes. An existing GitHub Release is left unchanged.

The publish job has `id-token: write`; the GitHub Release job has `contents: write`. These permissions are job-scoped. There is no `NPM_TOKEN`, no `NODE_AUTH_TOKEN`, and no use of `secrets` in the release workflow.

## Verify a release

Check all of these:

- **Actions → Release** has successful preflight, Node 22/24 checks, Pi smoke, package, publish, and GitHub Release jobs.
- npm lists the expected version, for example `npm view pi-extension-template@0.2.0 version`.
- The npm archive integrity matches the checked release record, for example `npm view pi-extension-template@0.2.0 dist.integrity`.
- GitHub Releases has the matching tag and notes.

## Recover from a failure

**Tag or metadata validation failed.** No archive was published. Fix the version, changelog, repository metadata, or Pi pin through a reviewed pull request. Do not move an existing tag and do not dispatch against a branch.

**The variable is disabled or the package is private.** No final release archive was produced or published. E2E or offline checks may still have created temporary packs. Set `ENABLE_NPM_PUBLISH` to exactly `true`, set `"private": false`, and use a new reviewed release. Do not weaken the guard to force a release.

**The Pi smoke or offline check failed.** No final release archive was produced or published. Fix the code or compatibility problem and release from a new reviewed tag.

**npm publication failed without publishing.** Re-run the failed jobs. The workflow rechecks the registry first and publishes only if the version is absent.

**npm published but the GitHub Release failed.** Re-run the failed jobs. The publish job skips npm only when the registry's SHA-512 integrity exactly matches the checked artifact, then the GitHub Release job can complete. An existing release is not modified.

**The registry reports different integrity.** Stop. Do not disable the check or force a retry. Investigate the published version and the original artifact. Publish a new version if the contents genuinely differ.

**The artifact expired.** Artifacts are retained for seven days. Re-run all jobs from the same tag. Repacking must produce the same archive identity; a different archive still fails the integrity check safely.

**OIDC authentication failed.** Verify the exact npm trusted-publisher owner, repository, workflow filename, environment, and allowed action. Confirm the workflow is running on a GitHub-hosted runner with `id-token: write` and npm is at least 11.5.1. `npm whoami` is not a test of OIDC authorization.

**The registry is unavailable or returns an error.** The workflow fails instead of treating an error as an available version. Resolve the outage and rerun.

## Optional future automatic tagging

The starter deliberately has no auto-tag workflow. If a fork later adopts automatic tagging, keep these constraints:

- Only tag a reviewed, merged version-and-changelog change, anchored to the exact pushed commit. Never tag a newer moving branch tip.
- Re-run the same tag identity, Node 22/24, package, and pinned-Pi smoke gates against that exact commit before creating the tag.
- Create the tag once and never move it. Reject a conflicting existing tag.
- Explicitly dispatch the `Release` workflow at the created tag; do not assume an automation-created tag event will publish.
- Keep automatic merging out of the release path. A version bump should still be reviewed, and publication should remain a deliberate maintainer action.

No automatic merge publication or automatic tag creation is included in this template.

## References

External requirements are based on the primary documentation:

- [npm trusted publishing with OIDC](https://docs.npmjs.com/trusted-publishers/) — npm CLI and Node requirements, GitHub-hosted runners, `id-token: write`, workflow filename matching, configuration expiry, and provenance behavior.
- [GitHub Actions OIDC reference](https://docs.github.com/en/actions/reference/security/oidc) — OIDC token permissions and `id-token: write`.
- [GitHub Actions workflow syntax: permissions](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#permissions) — job-scoped `permissions`.
