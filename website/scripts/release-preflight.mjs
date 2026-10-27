import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

export function validateRelease({reviewedSha, builtSha, mainSha, ref, checks}) {
  assert.equal(ref, 'refs/heads/main', 'Only main may be deployed');
  assert(/^[a-f0-9]{40}$/.test(reviewedSha || ''), 'An exact reviewed SHA is required');
  assert.equal(builtSha, reviewedSha, 'Built commit differs from the reviewed commit');
  assert.equal(mainSha, reviewedSha, 'Main changed after the release was selected');
  const expected = checks.filter(c => c.name === 'Public site asset and build checks'
    && c.head_sha === reviewedSha && c.app?.slug === 'github-actions').sort((a,b) => b.id - a.id)[0];
  assert(expected && expected.status === 'completed' && expected.conclusion === 'success',
    'The reviewed main revision must have successful Public site asset and build checks');
  return {verified: true, reviewed_sha: reviewedSha, check_run_id: expected.id};
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert.equal(process.env.GITHUB_REPOSITORY, 'synchronic1/AIPSTER');
  assert(process.env.GH_TOKEN, 'GitHub read credential is required');
  assert(/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA || ''));
  async function api(path) {
    const response = await fetch('https://api.github.com/repos/synchronic1/AIPSTER/' + path, {
      headers: {Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'}, signal: AbortSignal.timeout(15000), redirect: 'error',
    });
    assert(response.ok, `Release verification API returned HTTP ${response.status}`);
    return response.json();
  }
  const [main, checks] = await Promise.all([api('commits/main'), api(`commits/${process.env.GITHUB_SHA}/check-runs?per_page=100`)]);
  console.log(JSON.stringify(validateRelease({reviewedSha: process.env.REVIEWED_SHA,
    builtSha: process.env.GITHUB_SHA, mainSha: main.sha, ref: process.env.GITHUB_REF, checks: checks.check_runs})));
}
