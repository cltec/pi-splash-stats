import { execFileSync } from 'node:child_process';
import { readFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePiVersion, readReleaseMetadata } from './release.mjs';

export function versionChange(before, after) {
  validatePiVersion(before);
  validatePiVersion(after);
  const a = before.split('.').map(BigInt), b = after.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) {
    if (b[i] > a[i]) return 'release';
    if (b[i] < a[i]) throw new Error('Version decreased');
  }
  return 'skip';
}

export function verifyEvidence(evidence, commit, piVersion) {
  if (evidence.commit !== commit || evidence.offline22 !== true || evidence.offline24 !== true)
    throw new Error('Offline evidence identity mismatch');
  const smoke = evidence.smoke;
  if (smoke?.outcome !== 'pass' || smoke.piVersion !== piVersion || smoke.piExpected !== piVersion ||
      smoke.schemaVersion !== 1 || smoke.piBaseline !== piVersion ||
      smoke.cleanup !== 'clean' ||
      JSON.stringify(smoke.checks?.map(check => check.name).sort()) !== JSON.stringify(['checkout', 'headless-json', 'packed-archive', 'pi-version']) ||
      smoke.checks.some(check => check.status !== 'pass' || check.cleanup !== 'clean'))
    throw new Error('Pinned Pi evidence failed');
}

// Ports are injectable: deterministic tests never contact GitHub or mutate tags.
export async function completeRelease({ commit, tag, evidence, piVersion }, ports) {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('Invalid commit');
  validatePiVersion(tag?.slice(1));
  if (tag !== `v${tag.slice(1)}`) throw new Error('Invalid tag');
  verifyEvidence(evidence, commit, piVersion);
  if (!await ports.onMain(commit)) throw new Error('Verified commit is no longer on main');
  const existing = await ports.tagCommit(tag);
  if (existing && existing !== commit) throw new Error('Tag conflict; never move a release tag');
  if (!existing) await ports.createTag(tag, commit);
  if (await ports.tagCommit(tag) !== commit) throw new Error('Tag identity changed');
  await ports.dispatch(tag); // Always dispatch on retry, including an already-created tag.
}

const run = (command, args) => execFileSync(command, args, { encoding: 'utf8', timeout: 120000 }).trim();
const git = (...args) => run('git', args);
const json = path => JSON.parse(readFileSync(path, 'utf8'));
function plan() {
  const commit = process.env.GITHUB_SHA, before = process.env.BEFORE_SHA;
  if (![commit, before].every(value => /^[0-9a-f]{40}$/.test(value) && !/^0+$/.test(value)))
    throw new Error('A real before/after push range is required');
  if (git('rev-parse', 'HEAD') !== commit) throw new Error('Checkout identity mismatch');
  git('merge-base', '--is-ancestor', before, commit); // Fail closed on rewritten main history.
  const manifest = json('package.json');
  const action = versionChange(JSON.parse(git('show', `${before}:package.json`)).version, manifest.version);
  if (action === 'skip') return { action };
  const tag = `v${manifest.version}`;
  const metadata = readReleaseMetadata({ refType: 'tag', tag, manifest,
    changelog: readFileSync('CHANGELOG.md', 'utf8'), githubRepository: process.env.GITHUB_REPOSITORY,
    piVersion: json('scripts/quality.json').piVersion });
  return { action, tag, commit, piVersion: metadata.piVersion };
}
async function main() {
  const candidate = plan();
  if (process.argv[2] === 'plan') {
    appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(candidate).map(([k,v]) => `${k}=${v}\n`).join(''));
  } else if (process.argv[2] === 'complete' && candidate.action === 'release') {
    await completeRelease({ ...candidate, evidence: json('artifacts/auto-release.json') }, {
      onMain: commit => {
        git('fetch', 'origin', 'main');
        try { git('merge-base', '--is-ancestor', commit, 'origin/main'); return true; } catch { return false; }
      },
      tagCommit: tag => {
        const refs = git('ls-remote', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`).split('\n');
        return (refs.find(line => line.endsWith('^{}')) || refs.find(line => line.includes('\t')) || '').split('\t')[0] || null;
      },
      createTag: (tag, commit) => git('push', 'origin', `${commit}:refs/tags/${tag}`),
      dispatch: tag => run('gh', ['workflow', 'run', 'release.yml', '--ref', tag]),
    });
  } else throw new Error('Expected plan or complete');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
