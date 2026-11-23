import test from 'node:test';
import assert from 'node:assert/strict';
import { versionChange, verifyEvidence, completeRelease } from '../scripts/auto-release.mjs';

const commit = 'a'.repeat(40);
const smoke = { schemaVersion:1, outcome: 'pass', piBaseline:'1.6.0', piVersion: '1.6.0', piExpected: '1.6.0', cleanup: 'clean', checks: ['pi-version','checkout','headless-json','packed-archive'].map(name => ({ name, status:'pass', cleanup:'clean' })) };
const evidence = { commit, offline22:true, offline24:true, smoke };
const candidate = { commit, tag:'v1.0.0', evidence, piVersion:'1.6.0' };
test('canonical version comparison skips unchanged and rejects invalid or decreased versions', () => {
  assert.equal(versionChange('1.0.0', '1.0.0'), 'skip');
  for (const next of ['1.0.1','1.1.0','2.0.0','999999999999999999999.0.0']) assert.equal(versionChange('1.0.0',next),'release');
  for (const next of ['0.9.9','01.0.0','1.0.0-rc.1','1.0.0+build','1.0.0\n']) assert.throws(() => versionChange('1.0.0',next));
  assert.throws(() => versionChange('invalid','1.0.0'));
});
test('evidence must prove exact commit, both offline runtimes, pinned Pi and clean successful checks', () => {
  verifyEvidence(evidence, commit, '1.6.0');
  for (const patch of [{commit:'b'.repeat(40)}, {offline22:false}, {offline24:false}, {smoke:{...smoke,piVersion:'1.5.2'}}, {smoke:{...smoke,outcome:'fail'}}, {smoke:{...smoke,cleanup:'failed'}}, {smoke:{...smoke,checks:[]}}])
    assert.throws(() => verifyEvidence({...evidence,...patch},commit,'1.6.0'));
});
test('dispatch failure retries an exact existing tag without recreating it', async () => {
  let target = null, creates = 0, dispatches = 0;
  const ports = { onMain:async () => true, tagCommit:async () => target,
    createTag:async (_tag, sha) => { creates++; target = sha; },
    dispatch:async tag => { assert.equal(tag,'v1.0.0'); if (++dispatches === 1) throw new Error('dispatch failed'); } };
  await assert.rejects(completeRelease(candidate,ports), /dispatch failed/);
  await completeRelease(candidate,ports);
  assert.equal(creates,1); assert.equal(dispatches,2);
});
test('conflicting tags, removed commits, failed evidence and push failures never dispatch', async () => {
  for (const failure of ['conflict','main','evidence','push']) {
    let dispatches = 0;
    const ports = { onMain:async () => failure !== 'main', tagCommit:async () => failure === 'conflict' ? 'b'.repeat(40) : null,
      createTag:async () => { throw new Error('push failed'); }, dispatch:async () => {dispatches++;} };
    await assert.rejects(completeRelease(failure === 'evidence' ? {...candidate,evidence:{}} : candidate, ports));
    assert.equal(dispatches,0);
  }
});
