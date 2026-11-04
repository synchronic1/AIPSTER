// RELEASE158: default-off historical allowance for the deploy gate.
// Focused on the new behavior only; the pre-existing deploy-gate suite
// (unchanged) proves the default path.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {evaluateDeployGate, parseAllowancesFile, ALLOWANCE_PATH,
  ALLOWANCE_MARKER} from '../scripts/release-deploy-gate.mjs';

const h = (c) => c.repeat(40);
const LIVE = h('e');
const OLD83 = h('1');
const R97 = h('2');
const R99 = h('3');
const R104 = h('4');
const ALLOW = h('5');
const UNREL = h('6');
const OLD88 = '0d'.repeat(20);
const R98 = '9d'.repeat(20);
const M83 = h('a');
const M97 = h('b');
const M99 = h('c');
const M104 = h('d');
const MALLOW = h('9');
// The release target is exactly the allowance PR's merge onto BASE.
const TARGET = MALLOW;
const BASE = h('f');
const NOW = Date.parse('2026-11-05T00:00:00Z');
const MUNREL = h('8');
const M88 = 'b8'.repeat(20);
const M98 = 'c8'.repeat(20);
const TOUCHES = [h('7'), h('0'), 'ab'.repeat(20)];
const DIGEST = 'c0ffee'.padEnd(64, '0');
const ID = 'RELEASE158-8bcd4c7';
const SITE_SUITE = 900;
const WORKER_SUITE = 901;
const INSTALLER_SUITE = 902;
const REGISTRY = '.github/release-holds.json';

const entry = (over = {}) => ({liveSha: LIVE, mainBase: BASE,
  notAfter: '2026-11-11T23:59:59Z', registryTouches: [...TOUCHES],
  supersededHeads: [{pr: 83, head: OLD83, merge: M83,
    repairedBy: [{pr: 97, head: R97}, {pr: 99, head: R99}, {pr: 104, head: R104}],
    reason: 'Old head had two fail-open defects and no picker; repaired in-range.'},
  {pr: 88, head: OLD88, merge: M88,
    repairedBy: [{pr: 98, head: R98}],
    reason: 'Old head had dark-CSS self-cycles and overflows; repaired in-range by PR 98.'}],
  decision: 'Peter: historical release of the 8bcd4c7..target range only.',
  markerAuthor: 'synchronic1', ...over});
const allowances = (over) => parseAllowancesFile({version: 1, allowances: {[ID]: entry(over)}});

const evidenceBody = (head) => ['RELEASE-EVIDENCE', 'reviewer: 948a', 'author: fixture-author',
  'model: muse-spark-1.3-contributor', 'sha: ' + head, 'verdict: PASS', 'report: R.md',
  'tests: 3/3', 'blocking: none'].join('\n');
const review = (head, body, over = {}) => ({id: Math.floor(Math.random() * 1e9),
  user: {login: 'synchronic1'}, author_association: 'OWNER', state: 'COMMENTED',
  commit_id: head, body, submitted_at: '2026-11-04T00:00:00Z', ...over});
const markerReview = (head, id = ID, digest = DIGEST, over = {}) =>
  review(head, `${ALLOWANCE_MARKER} ${id} ${digest}\nOwner decision.`, over);

const site = (sha) => ({id: 9, name: 'Public site asset and build checks', head_sha: sha,
  status: 'completed', conclusion: 'success', app: {slug: 'github-actions'},
  check_suite: {id: SITE_SUITE}});
const worker = (sha) => ({id: 7, name: 'mock-install', head_sha: sha, status: 'completed',
  conclusion: 'success', app: {slug: 'github-actions'}, check_suite: {id: WORKER_SUITE}});
const installer = (sha) => ({id: 12, name: 'Build and qualify Windows installer', head_sha: sha,
  status: 'completed', conclusion: 'success', app: {slug: 'github-actions'},
  check_suite: {id: INSTALLER_SUITE}});

// PR table: number -> {head, merge, reviews, files}
function prTable(over = {}) {
  const t = {
    83: {head: OLD83, merge: M83, reviews: [], files: ['website/public/app/app.js']},
    88: {head: OLD88, merge: M88, reviews: [], files: ['website/public/app/styles.css']},
    97: {head: R97, merge: M97, reviews: [review(R97, evidenceBody(R97))], files: ['website/public/a.js']},
    98: {head: R98, merge: M98, reviews: [review(R98, evidenceBody(R98))], files: ['website/public/app/styles.css']},
    99: {head: R99, merge: M99, reviews: [review(R99, evidenceBody(R99))], files: ['website/public/b.js']},
    104: {head: R104, merge: M104, reviews: [review(R104, evidenceBody(R104))], files: ['website/public/c.js']},
    150: {head: ALLOW, merge: MALLOW,
      reviews: [review(ALLOW, evidenceBody(ALLOW)), markerReview(ALLOW)],
      files: [ALLOWANCE_PATH, 'website/scripts/release-deploy-gate.mjs']},
  };
  return {...t, ...over};
}

function harness({table = prTable(), order = [MALLOW, M104, M99, M98, M97, M88, M83],
  touches = TOUCHES, changed = ['website/public/x.html', REGISTRY], headBlob = 'blob1',
  targetBlob = 'blob1', headChecks = null, suitesFor = null,
  firstParent = (sha) => (sha === MALLOW ? BASE : null), registryBlobs = {}} = {}) {
  const byMerge = Object.fromEntries(Object.entries(table).map(([n, p]) => [p.merge, {n: Number(n), ...p}]));
  const byNum = Object.fromEntries(Object.entries(table).map(([n, p]) => [Number(n), p]));
  const request = async (path) => {
    const [base, query] = path.split('?');
    let m;
    if ((m = base.match(/^commits\/([0-9a-f]{40})\/pulls$/))) {
      const p = byMerge[m[1]];
      return p ? [{number: p.n, merged_at: 'x', merge_commit_sha: p.merge,
        base: {ref: 'main', repo: {full_name: 'synchronic1/AIPSTER'}}}] : [];
    }
    if ((m = base.match(/^pulls\/(\d+)$/))) {
      const p = byNum[Number(m[1])];
      return {number: Number(m[1]), head: {sha: p.head, ref: 'x',
        repo: {full_name: Number(m[1]) === 83 ? 'Ajay-Ankam/AIPSTER' : 'synchronic1/AIPSTER'}},
      base: {ref: 'main', repo: {full_name: 'synchronic1/AIPSTER'}}, user: {login: 'author1'},
      state: 'closed', merged: true, merge_commit_sha: p.merge};
    }
    if ((m = base.match(/^pulls\/(\d+)\/reviews$/))) return byNum[Number(m[1])].reviews;
    if ((m = base.match(/^pulls\/(\d+)\/files$/))) {
      return byNum[Number(m[1])].files.map((filename) => ({filename}));
    }
    if (/^collaborators\/[^/]+\/permission$/.test(base)) return {permission: 'read'};
    if (/^actions\/workflows\/[^/]+\/runs$/.test(base)) {
      const sha = (query.match(/head_sha=([0-9a-f]{40})/) || [])[1];
      const ids = suitesFor ? suitesFor(sha) : [SITE_SUITE, WORKER_SUITE, INSTALLER_SUITE];
      return {workflow_runs: ids.map((id) => ({id: 5000 + id, head_sha: sha, check_suite_id: id}))};
    }
    throw new Error('unexpected API path ' + path);
  };
  const git = {
    commitsInRange: () => order,
    firstParent,
    secondParent: (merge) => (byMerge[merge] ? byMerge[merge].head : null),
    isAncestor: () => false,
    changedFiles: () => changed,
    registryTouches: () => touches,
    blobAt: (sha, path) => (path === REGISTRY ? (sha in registryBlobs ? registryBlobs[sha] : 'reg1')
      : sha === ALLOW ? headBlob : targetBlob),
  };
  return {git, request, fetchChecks: async (sha) => [site(sha)],
    fetchHeadChecks: async (sha) => (headChecks ? headChecks(sha) : [site(sha)]),
    liveSha: LIVE, targetSha: TARGET, mode: 'manual', dispatchActor: 'synchronic1',
    dispatchActorAssociation: null, holds: {}, permissions: {}, now: NOW};
}

const run = (input, over = {}) => evaluateDeployGate({...input, ...over});

test('default off: no allowance keeps both original refusals', async () => {
  // No allowance entry names this head, so nothing is deferred: the
  // original per-PR refusal is thrown immediately, naming the refused head.
  await assert.rejects(run(harness()), /No independent review evidence bound to the current head/);
  await assert.rejects(run(harness()), /PR 88 head .*No independent review evidence/);
  const noOld = harness({table: (() => { const t = prTable(); t[83].reviews = [review(OLD83, evidenceBody(OLD83))]; t[88].reviews = [review(OLD88, evidenceBody(OLD88))]; return t; })()});
  await assert.rejects(run(noOld), /touches the hold registry .*no allowance pinned to this live SHA/);
});

test('intended historical chain releases and is fully recorded', async () => {
  const out = await run(harness(), {allowances: allowances(), allowanceDigest: DIGEST});
  assert.equal(out.ok, true);
  assert.deepEqual(out.historicalAllowances.map((u) => Object.keys(u).sort()),
    [['allowance', 'registryTouches'], ['allowance', 'supersededHead'], ['allowance', 'supersededHead']]);
  assert.deepEqual(out.historicalAllowances.slice(1).map((u) => u.supersededHead.pr).sort(), [83, 88]);
  assert.equal(out.prs.find((p) => p.number === 83).evidence, 0, 'old head is never called PASS');
  assert.equal(out.prs.find((p) => p.number === 88).evidence, 0, 'old head is never called PASS');
});

test('wrong or missing repair head refuses', async () => {
  const wrong = allowances({supersededHeads: [{...entry().supersededHeads[0],
    repairedBy: [{pr: 97, head: h('2').replace(/2$/, '3')}, {pr: 99, head: R99}, {pr: 104, head: R104}]},
    entry().supersededHeads[1]]});
  await assert.rejects(run(harness(), {allowances: wrong, allowanceDigest: DIGEST}),
    /repair PR 97 head .* is not merged in this range/);
  // Repair PR absent from the range.
  await assert.rejects(run(harness({order: [MALLOW, M104, M98, M97, M88, M83]}),
    {allowances: allowances(), allowanceDigest: DIGEST}), /repair PR 99 head/);
});

test('PR88 wrong or missing repair head refuses', async () => {
  const wrong = allowances({supersededHeads: [...entry().supersededHeads.slice(0, 1),
    {...entry().supersededHeads[1], repairedBy: [{pr: 98, head: R98.replace(/d$/, 'e')}]}]});
  await assert.rejects(run(harness(), {allowances: wrong, allowanceDigest: DIGEST}),
    /repair PR 98 head .* is not merged in this range/);
  // Repair PR absent from the range (PR98 merge missing, PR88 chain unsatisfied).
  await assert.rejects(run(harness({order: [MALLOW, M104, M99, M97, M88, M83]}),
    {allowances: allowances(), allowanceDigest: DIGEST}), /repair PR 98 head/);
});

test('PR88 repair without its own evidence refuses (no transitive pass)', async () => {
  const t = prTable(); t[98].reviews = [];
  await assert.rejects(run(harness({table: t}), {allowances: allowances(), allowanceDigest: DIGEST}),
    /PR 98 head|No independent review evidence/);
});

test('PR88 keeps its blocking-review requirement', async () => {
  const blocked = prTable({88: {...prTable()[88], reviews: [review(OLD88, 'Needs fix.',
    {state: 'CHANGES_REQUESTED'})]}});
  await assert.rejects(run(harness({table: blocked}), {allowances: allowances(), allowanceDigest: DIGEST}),
    /PR 88 has unresolved/);
});

test('repair head without its own evidence refuses (no transitive pass)', async () => {
  const t = prTable(); t[99].reviews = [];
  await assert.rejects(run(harness({table: t}), {allowances: allowances(), allowanceDigest: DIGEST}),
    /PR 99 head|No independent review evidence/);
});

test('activation requires the exact maintainer marker on the allowance PR head', async () => {
  const cases = {
    'no marker': prTable({150: {...prTable()[150], reviews: [review(ALLOW, evidenceBody(ALLOW))]}}),
    'wrong digest': prTable({150: {...prTable()[150], reviews: [review(ALLOW, evidenceBody(ALLOW)), markerReview(ALLOW, ID, 'f'.repeat(64))]}}),
    'stale head': prTable({150: {...prTable()[150], reviews: [review(ALLOW, evidenceBody(ALLOW)), markerReview(h('6'))]}}),
    'non-maintainer': prTable({150: {...prTable()[150], reviews: [review(ALLOW, evidenceBody(ALLOW)),
      markerReview(ALLOW, ID, DIGEST, {user: {login: 'helper'}, author_association: 'CONTRIBUTOR'})]}}),
  };
  for (const [label, table] of Object.entries(cases)) {
    await assert.rejects(run(harness({table}), {allowances: allowances(), allowanceDigest: DIGEST}),
      /allowance inactive: PR 150 lacks a maintainer review/, label);
  }
});

test('auto mode, non-owner dispatch, stale live and blob drift all refuse', async () => {
  const a = {allowances: allowances(), allowanceDigest: DIGEST};
  await assert.rejects(run(harness(), {...a, mode: 'auto'}), /manual dispatch only/);
  // A non-owner dispatcher is refused before the allowance is consulted
  // (no maintainer acceptance); either refusal is acceptable, never a pass.
  await assert.rejects(run(harness(), {...a, dispatchActor: 'someone'}),
    /No maintainer acceptance|not the pinned owner/);
  await assert.rejects(run(harness(), {...a, liveSha: h('9').replace(/9$/, '8')}),
    /no allowance pinned to this live SHA/);
  await assert.rejects(run(harness({headBlob: 'blob2'}), a), /head blob .* differs from the target/);
  await assert.rejects(run(harness(), {...a, allowanceDigest: null}), /digest unavailable/);
});

test('an active hold still refuses with the allowance active', async () => {
  const holds = {[h('7')]: {sha: h('7'), active: true, reason: 'held', setBy: 'synchronic1',
    blockMerges: true}};
  await assert.rejects(run(harness(), {allowances: allowances(), allowanceDigest: DIGEST, holds}),
    /Release HOLD active/);
});

test('an additional registry touch refuses', async () => {
  await assert.rejects(run(harness({touches: [...TOUCHES, h('6')]}),
    {allowances: allowances(), allowanceDigest: DIGEST}), /pins 3 touch\(es\); range has 4/);
  await assert.rejects(run(harness({touches: TOUCHES.slice(0, 2)}),
    {allowances: allowances(), allowanceDigest: DIGEST}), /range has 2/);
});

test('unrelated PR still needs its own evidence and CI', async () => {
  const t = prTable({160: {head: UNREL, merge: MUNREL, reviews: [], files: ['website/public/z.js']}});
  await assert.rejects(run(harness({table: t, order: [MUNREL, MALLOW, M104, M99, M98, M97, M88, M83]}),
    {allowances: allowances(), allowanceDigest: DIGEST}), /No independent review evidence/);
  const t2 = prTable({160: {head: UNREL, merge: MUNREL, reviews: [review(UNREL, evidenceBody(UNREL))],
    files: ['website/public/z.js']}});
  await assert.rejects(run(harness({table: t2, order: [MUNREL, MALLOW, M104, M99, M98, M97, M88, M83],
    headChecks: (sha) => (sha === UNREL ? [] : [site(sha)])}),
  {allowances: allowances(), allowanceDigest: DIGEST}), /PR 160 head lacks a passing/);
});

test('superseded head keeps its blocking-review and installer requirements', async () => {
  const blocked = prTable({83: {...prTable()[83], reviews: [review(OLD83, 'Picker missing.',
    {state: 'CHANGES_REQUESTED'})]}});
  await assert.rejects(run(harness({table: blocked}), {allowances: allowances(), allowanceDigest: DIGEST}),
    /PR 83 has unresolved/);
  const workerish = prTable({83: {...prTable()[83], files: ['local-worker/pairing.py']}});
  await assert.rejects(run(harness({table: workerish,
    headChecks: (sha) => (sha === OLD83 ? [site(sha), worker(sha)] : [site(sha)])}),
  {allowances: allowances(), allowanceDigest: DIGEST}), /PR 83 head .* installer|Build and qualify Windows installer/);
  // With installer evidence present it passes.
  const ok = await run(harness({table: workerish,
    headChecks: (sha) => (sha === OLD83 ? [site(sha), worker(sha), installer(sha)] : [site(sha)])}),
  {allowances: allowances(), allowanceDigest: DIGEST});
  assert.equal(ok.ok, true);
});

test('realGit registryTouches lists every touching commit on any parent; blobAt reads exact blobs', async () => {
  const {realGit} = await import('../scripts/release-deploy-gate.mjs');
  const {execFileSync} = await import('node:child_process');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r158-'));
  const g = (...a) => execFileSync('git', a, {cwd: dir, encoding: 'utf8'}).trim();
  try {
    g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
    fs.writeFileSync(path.join(dir, 'a.txt'), '1'); g('add', '.'); g('commit', '-qm', 'live');
    const live = g('rev-parse', 'HEAD');
    g('checkout', '-qb', 'side');
    fs.mkdirSync(path.join(dir, '.github'));
    fs.writeFileSync(path.join(dir, REGISTRY), '{"version":1,"holds":{}}');
    g('add', '.'); g('commit', '-qm', 'side touch');
    const sideTouch = g('rev-parse', 'HEAD');
    g('checkout', '-q', 'main'); g('merge', '-q', '--no-ff', 'side', '-m', 'merge side');
    fs.writeFileSync(path.join(dir, 'a.txt'), '2'); g('commit', '-qam', 'unrelated');
    fs.writeFileSync(path.join(dir, REGISTRY), '{"version":1,"holds":{"x":1}}');
    g('commit', '-qam', 'main touch');
    const mainTouch = g('rev-parse', 'HEAD');
    const target = mainTouch;
    const rg = realGit(dir);
    assert.deepEqual(rg.registryTouches(live, target, REGISTRY).sort(), [sideTouch, mainTouch].sort());
    assert.equal(rg.blobAt(target, REGISTRY), g('rev-parse', `${target}:${REGISTRY}`));
    assert.equal(rg.blobAt(live, REGISTRY), null);
    assert.equal(rg.firstParent(mainTouch), g('rev-parse', `${mainTouch}^1`));
    assert.equal(rg.firstParent(live), null);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('parser rejects wildcards, short SHAs, unknown keys and empty entries', () => {
  const bad = [
    {version: 1, allowances: {[ID]: entry({liveSha: '*'})}},
    {version: 1, allowances: {[ID]: entry({registryTouches: ['00c7d84']})}},
    {version: 1, allowances: {[ID]: {...entry(), extra: true}}},
    {version: 1, allowances: {[ID]: entry({markerAuthor: 'someone'})}},
    {version: 1, allowances: {[ID]: entry({mainBase: '0e6b608'})}},
    {version: 1, allowances: {[ID]: entry({notAfter: 'next week'})}},
    {version: 1, allowances: {[ID]: (() => { const e = entry(); delete e.mainBase; return e; })()}},
    {version: 1, allowances: {[ID]: (() => { const e = {...entry(), approvedBy: 'synchronic1'}; delete e.markerAuthor; return e; })()}},
    {version: 1, allowances: {[ID]: entry({registryTouches: [], supersededHeads: []})}},
    {version: 1, allowances: {[ID]: entry({supersededHeads: [{...entry().supersededHeads[0], repairedBy: []}]})}},
    {version: 2, allowances: {}},
  ];
  for (const b of bad) assert.throws(() => parseAllowancesFile(b));
  assert.deepEqual(parseAllowancesFile(null), {});
  assert.deepEqual(parseAllowancesFile({version: 1, allowances: {}}), {});
});

// ---- Final-head regressions for review 5776791336 (exact target binding,
// rollback re-arm bound, owner-only marker, activation edge cases).
const A = () => ({allowances: allowances(), allowanceDigest: DIGEST});

test('F1: a later tip with its own evidence never activates the allowance', async () => {
  const t = prTable({160: {head: UNREL, merge: MUNREL, reviews: [review(UNREL, evidenceBody(UNREL))],
    files: ['website/public/z.js']}});
  await assert.rejects(run(harness({table: t, order: [MUNREL, MALLOW, M104, M99, M98, M97, M88, M83]}),
    {...A(), targetSha: MUNREL}), /allowance inactive: target .* is not PR 150 merge/);
});

test('F1: the target must sit on the pinned mainBase and integrate the PR head', async () => {
  await assert.rejects(run(harness({firstParent: () => h('3')}), A()),
    /allowance inactive: target first parent is not the pinned mainBase/);
  await assert.rejects(run(harness({firstParent: () => null}), A()),
    /target first parent is not the pinned mainBase/);
  // mainBase pinned to another tip (main moved before merge): refuses.
  await assert.rejects(run(harness(), {allowances: allowances({mainBase: h('2')}), allowanceDigest: DIGEST}),
    /not the pinned mainBase/);
});

test('rollback re-arm: after notAfter the allowance is inert even for the exact target', async () => {
  await assert.rejects(run(harness(), {...A(), now: Date.parse('2026-11-12T00:00:00Z')}),
    /allowance inactive: allowance .* expired/);
  await assert.rejects(run(harness(), {...A(), now: NaN}), /expired .*clock unavailable/);
  // Exactly at notAfter is still inside the window.
  const edge = await run(harness(), {...A(), now: Date.parse('2026-11-11T23:59:59Z')});
  assert.equal(edge.ok, true);
});

test('marker: a different maintainer (even admin) never activates; owner only', async () => {
  const t = prTable({150: {...prTable()[150], reviews: [review(ALLOW, evidenceBody(ALLOW)),
    markerReview(ALLOW, ID, DIGEST, {user: {login: 'helper'}, author_association: 'MEMBER'})]}});
  await assert.rejects(run(harness({table: t}), {...A(), permissions: {helper: 'admin'}}),
    /allowance inactive: PR 150 lacks a maintainer review by synchronic1/);
});

test('marker: a DISMISSED owner marker never activates', async () => {
  const t = prTable({150: {...prTable()[150], reviews: [review(ALLOW, evidenceBody(ALLOW)),
    markerReview(ALLOW, ID, DIGEST, {state: 'DISMISSED'})]}});
  await assert.rejects(run(harness({table: t}), A()), /allowance inactive: PR 150 lacks a maintainer review/);
});

test('two PRs touching the allowance file refuse', async () => {
  const t = prTable({160: {head: UNREL, merge: MUNREL, reviews: [review(UNREL, evidenceBody(UNREL))],
    files: [ALLOWANCE_PATH]}});
  await assert.rejects(run(harness({table: t, order: [MALLOW, MUNREL, M104, M99, M98, M97, M88, M83]}), A()),
    /exactly one PR in range must introduce .*found 2/);
});

test('two allowance entries on one live SHA fail closed', async () => {
  const two = parseAllowancesFile({version: 1, allowances: {[ID]: entry(), 'OTHER-1': entry()}});
  await assert.rejects(run(harness(), {allowances: two, allowanceDigest: DIGEST}),
    /More than one allowance pinned to this live SHA/);
});

test('superseded entry with a different head or merge does not cover the real head', async () => {
  for (const over of [{head: h('2').replace(/2$/, '4')}, {merge: h('b').replace(/b$/, 'c')}]) {
    const a = allowances({supersededHeads: [{...entry().supersededHeads[0], ...over},
      entry().supersededHeads[1]]});
    await assert.rejects(run(harness(), {allowances: a, allowanceDigest: DIGEST}),
      /PR 83 head .*No independent review evidence/);
  }
});

test('the allowance PR merge itself must not change the hold registry', async () => {
  await assert.rejects(run(harness({registryBlobs: {[MALLOW]: 'reg2'}}), A()),
    /allowance inactive: target .*release-holds.json differs from mainBase/);
  await assert.rejects(run(harness({registryBlobs: {[BASE]: null}}), A()),
    /differs from mainBase/);
});

// PR83 owner review 5755949055 (CHANGES_REQUESTED at the superseded head).
// Diagnosis regression: the allowance defers only evidence binding, never a
// same-head blocking review. Fixtures mirror the real review's shape; the
// DISMISSED case models what a working dismissal would return (GitHub
// replaces the object's state) and is NOT a claim about production.
const PR83_OWNER_CR = 5755949055;
const ownerCr = (over = {}) => review(OLD83, 'Blocking: dashboard file picker.',
  {id: PR83_OWNER_CR, state: 'CHANGES_REQUESTED', submitted_at: '2026-11-03T16:34:12Z', ...over});
const with83 = (reviews) => prTable({83: {...prTable()[83], reviews}});
const active = {allowances: allowances(), allowanceDigest: DIGEST};

test('PR83 owner CR 5755949055 refuses even with the allowance active, naming the review', async () => {
  await assert.rejects(run(harness({table: with83([ownerCr()])}), active),
    new RegExp(`PR 83 has unresolved changes-requested by synchronic1 at head ${OLD83} \\(review ${PR83_OWNER_CR}\\)`));
});

test('PR83: only a dismissal of that exact object or a later same-author same-head APPROVED clears it', async () => {
  const dismissed = await run(harness({table: with83([ownerCr({state: 'DISMISSED'})])}), active);
  assert.equal(dismissed.ok, true);
  const approved = await run(harness({table: with83([ownerCr(),
    review(OLD83, 'Clears my picker request only (landed in PR 104); this head is not a PASS.',
      {state: 'APPROVED', submitted_at: '2026-11-05T00:00:00Z'})])}), active);
  assert.equal(approved.ok, true);
  assert.equal(approved.prs.find((p) => p.number === 83).evidence, 0, 'clearing the CR never makes the old head a PASS');
  assert(approved.historicalAllowances.some((u) => u.supersededHead?.pr === 83), 'repair chain still applied');
});

test('PR83: nothing else clears the owner CR', async () => {
  const later = {submitted_at: '2026-11-05T00:00:00Z'};
  for (const [label, extra] of [
    ['comment by the same author', review(OLD83, 'Picker landed in PR 104.', later)],
    ['approval at a different head', review(R104, 'ok', {state: 'APPROVED', ...later})],
    ['dismissal of a different object', review(OLD83, 'x', {id: 1, state: 'DISMISSED', ...later})],
  ]) {
    await assert.rejects(run(harness({table: with83([ownerCr(), extra])}), active),
      /PR 83 has unresolved changes-requested/, label);
  }
});

test('PR83: clearing the CR does not waive the repair chain evidence', async () => {
  const t = with83([ownerCr(), review(OLD83, 'Clears picker request.',
    {state: 'APPROVED', submitted_at: '2026-11-05T00:00:00Z'})]);
  t[104] = {...t[104], reviews: []};
  await assert.rejects(run(harness({table: t}), active), /PR 104|repair PR 104/);
});

// Replacement-allowance remedy (fixtures only): exact named review deferral
// plus an exact prior-allowance-toucher list. Both optional fields are off
// by default; every test above runs without them unchanged.
const PRIOR_H = '7e'.repeat(20);
const PRIOR_M = '7f'.repeat(20);
const named83 = (over = {}) => ({...entry().supersededHeads[0],
  reason: `Owner review ${PR83_OWNER_CR} required the picker; repaired in-range by PR 104.`,
  blockingReviews: [{id: PR83_OWNER_CR, by: 'synchronic1'}], ...over});
const replacement = (s83 = named83(), over = {}) => allowances({
  supersededHeads: [s83, entry().supersededHeads[1]], ...over});
const activeR = (s83, over) => ({allowances: replacement(s83, over), allowanceDigest: DIGEST});

test('named owner CR at the superseded head defers only with the allowance active and records it', async () => {
  const out = await run(harness({table: with83([ownerCr()])}), activeR());
  assert.equal(out.ok, true);
  const u = out.historicalAllowances.find((x) => x.supersededHead?.pr === 83);
  assert.deepEqual(u.supersededHead.deferredBlockingReview, {id: PR83_OWNER_CR, by: 'synchronic1'});
  assert.equal(out.prs.find((p) => p.number === 83).evidence, 0, 'old head is never called PASS');
  await assert.rejects(run(harness({table: with83([ownerCr()])}), {...activeR(), now: Date.parse('2026-12-01T00:00:00Z')}),
    /allowance inactive: allowance RELEASE158-8bcd4c7 expired/);
  const auto = harness({table: with83([ownerCr()])}); auto.mode = 'auto';
  await assert.rejects(run(auto, activeR()), /allowance inactive: allowances apply to manual dispatch only/);
});

test('named deferral is exact: other ids, other blockers and missing repair evidence still refuse', async () => {
  await assert.rejects(run(harness({table: with83([ownerCr({id: 42})])}), activeR()), /PR 83 has unresolved changes-requested/);
  // A later, unnamed CR object by the same owner is the live block: it refuses.
  const second = review(OLD83, 'Also blocking.', {id: 77, state: 'CHANGES_REQUESTED',
    submitted_at: '2026-11-03T17:00:00Z'});
  await assert.rejects(run(harness({table: with83([ownerCr(), second])}), activeR()), /PR 83 has unresolved/);
  const t = with83([ownerCr()]); t[104] = {...t[104], reviews: []};
  await assert.rejects(run(harness({table: t}), activeR()), /104/);
  const t88 = prTable({88: {...prTable()[88], reviews: [review(OLD88, 'x', {id: PR83_OWNER_CR + 1, state: 'CHANGES_REQUESTED'})]}});
  await assert.rejects(run(harness({table: t88}), activeR()), /PR 88 has unresolved/, 'naming is per superseded head');
});

test('blockingReviews parsing is strict', () => {
  assert.throws(() => replacement(named83({blockingReviews: [{id: PR83_OWNER_CR, by: 'someone'}]})), /marker author's own reviews/);
  assert.throws(() => replacement(named83({reason: 'Repaired in-range by PR 104 and others, long enough.'})), /must name every blocking review id/);
  assert.throws(() => replacement(named83({blockingReviews: []})), /non-empty/);
  assert.throws(() => replacement(named83({blockingReviews: [{id: PR83_OWNER_CR, by: 'synchronic1', note: 'x'}]})), /unknown keys/);
  assert.throws(() => replacement(named83({waive: true})), /unknown keys/);
});

test('replacement allowance needs the exact prior-toucher list; default stays exactly-one', async () => {
  const prior = {112: {head: PRIOR_H, merge: PRIOR_M, reviews: [review(PRIOR_H, evidenceBody(PRIOR_H))],
    files: [ALLOWANCE_PATH, 'website/scripts/release-deploy-gate.mjs']}};
  const order = [MALLOW, PRIOR_M, M104, M99, M98, M97, M88, M83];
  const h2 = () => harness({table: {...with83([ownerCr()]), ...prior}, order});
  await assert.rejects(run(h2(), activeR()), /exactly one PR in range must introduce .*found 2/);
  const ok = await run(h2(), activeR(undefined, {priorAllowanceMerges: [PRIOR_M]}));
  assert.equal(ok.ok, true);
  await assert.rejects(run(h2(), activeR(undefined, {priorAllowanceMerges: [h('1')]})), /touchers must be the target PR plus exactly/);
  assert.throws(() => replacement(named83(), {priorAllowanceMerges: []}), /non-empty/);
});

test('repository replacement allowance file is the exact proposed RELEASE158R entry', async () => {
  const {readFile} = await import('node:fs/promises');
  const raw = await readFile(new URL('../../.github/release-historical-allowances.json', import.meta.url), 'utf8');
  const parsed = parseAllowancesFile(JSON.parse(raw));
  assert.deepEqual(Object.keys(parsed), ['RELEASE158R-8bcd4c7'], 'exactly one entry: the replacement (never two on one live SHA)');
  const e = parsed['RELEASE158R-8bcd4c7'];
  assert.equal(e.liveSha, '8bcd4c7a054e8fa6dda8e4d087be490d15b8f923');
  assert.equal(e.mainBase, '2dd1f79c1c1aea1acf86ae6e8f3a549b57018b36');
  assert.deepEqual(e.priorAllowanceMerges, ['2dd1f79c1c1aea1acf86ae6e8f3a549b57018b36']);
  assert.deepEqual(e.registryTouches, ['00c7d848cf3329d32e4d4d286b0a042a37fb4f5d',
    'ff82c051c45a51521f8c5b6e7053bda7df97c15a', '3bad6d97dee628986a052a5edffa718b3784a0a5']);
  const [s83, s88] = e.supersededHeads;
  assert.deepEqual([s83.pr, s83.head, s83.merge], [83, '01fce781f6926db9023964acddfb2ddc1b570293', '851f9e46d95686cb54fcc2d53fabbd89f7de9229']);
  assert.deepEqual(s83.blockingReviews, [{id: 5755949055, by: 'synchronic1'}]);
  assert.deepEqual(s83.repairedBy.map((r) => r.pr), [97, 99, 104]);
  assert.equal(s88.pr, 88); assert(!('blockingReviews' in s88), 'PR 88 keeps its full blocking-review requirement');
  assert.match(e.decision, /^PROPOSED, NOT YET APPROVED/);
});
