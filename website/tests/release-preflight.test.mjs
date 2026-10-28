import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateRelease} from '../scripts/release-preflight.mjs';
const sha = '1'.repeat(40);
const good = () => ({reviewedSha: sha, builtSha: sha, mainSha: sha, ref: 'refs/heads/main',
  checks: [{id: 1, name: 'Public site asset and build checks', head_sha: sha,
    status: 'completed', conclusion: 'success', app: {slug: 'github-actions'}}]});
test('release preflight accepts the exact reviewed current main with passing CI', () => {
  assert.equal(validateRelease(good()).reviewed_sha, sha);
});
for (const [label, change] of [
  ['short SHA', v => {v.reviewedSha = '1111111';}],
  ['changed main', v => {v.mainSha = '2'.repeat(40);}],
  ['different build', v => {v.builtSha = '2'.repeat(40);}],
  ['PR branch', v => {v.ref = 'refs/heads/feature';}],
  ['missing CI', v => {v.checks = [];}],
  ['pending CI', v => {v.checks[0].status = 'in_progress';}],
  ['failed latest rerun', v => {v.checks.push({...v.checks[0], id: 2, conclusion: 'failure'});}],
  ['other revision CI', v => {v.checks[0].head_sha = '2'.repeat(40);}],
]) test(`release preflight rejects ${label}`, () => {const value = good(); change(value); assert.throws(() => validateRelease(value));});
