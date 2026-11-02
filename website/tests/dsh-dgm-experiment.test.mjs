// Focused tests for the visible /app/experiments/dsh-dgm/ integration.
//
// The adapter's own semantics are covered by the 73-test experiment suite in
// experiments/dsh-dgm-adapter/tests; nothing here re-tests them. These tests
// cover what the site integration adds: the administrator-access decision
// around the existing admin.status gate, the shell invariants the static
// policy depends on, and byte identity between the site copies and the
// reviewed experiment source.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolve, relative } from 'node:path';

import {
  decideAdminAccess,
  ACCESS_STATES,
  ADMIN_GRANT_SCOPE,
  ADMIN_ROLES,
  ADMIN_STATUS_ENDPOINT,
  ADMIN_STATUS_SCHEMA
} from '../public/app/experiments/dsh-dgm/admin-gate.mjs';
import { publicFiles } from '../scripts/check.mjs';

const SITE = resolve(import.meta.dirname, '../public');
const EXPERIMENT = resolve(SITE, 'app/experiments/dsh-dgm');
const REVIEWED = resolve(import.meta.dirname, '../../experiments/dsh-dgm-adapter');

// Files that must stay byte-identical to the independently reviewed source.
const REVIEWED_COPIES = [
  'styles.css',
  'fixtures/work-items.mjs',
  'src/adapter.mjs',
  'src/canonical.mjs',
  'src/checks.mjs',
  'src/contract.mjs',
  'src/demo.mjs',
  'src/evaluate.mjs',
  'src/measure.mjs',
  'src/selection.mjs',
  'src/view.mjs'
];

// Everything the integration adds on top of those copies.
const INTEGRATION_FILES = ['admin-gate.mjs', 'dsh-dgm.js', 'index.html', 'site.css'];

async function walk(dir, root = dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(path, root));
    else out.push(relative(root, path).replaceAll('\\', '/'));
  }
  return out.sort();
}

// The exact success envelope of GET /api/admin/v1/status (src/admin/router.mjs).
const statusBody = (overrides = {}) => ({
  schema_version: 'admin.status.v1',
  admin: 'scaffold',
  elevation: 'not_implemented',
  mutations: 'disabled',
  grant: { role: 'operations_observer', scope: 'platform', expires_at: null },
  observed_at: '2026-11-02T07:00:00.000Z',
  ...overrides
});

// The single refusal shape the admin router returns for a signed-in caller
// without a live, recognized platform grant: no grant, wrong role, expired or
// revoked grant, demo session, key caller.
const forbidden = () => ({
  status: 403,
  payload: { error: 'Administration is not authorized for this caller.', code: 'ADMIN_FORBIDDEN' }
});

// A documented envelope with one field absent, as a transport would deliver
// it: deleting the key rather than leaving an `undefined` value.
const without = (key) => {
  const payload = statusBody();
  delete payload[key];
  return { status: 200, payload };
};

test('the site copies are byte-identical to the reviewed experiment', async () => {
  for (const rel of REVIEWED_COPIES) {
    const [site, reviewed] = await Promise.all([
      readFile(resolve(EXPERIMENT, rel)),
      readFile(resolve(REVIEWED, rel))
    ]);
    assert.deepEqual(site, reviewed, `${rel} diverged from experiments/dsh-dgm-adapter/${rel}`);
  }
});

test('the experiment directory holds exactly the reviewed copies plus the integration files', async () => {
  assert.deepEqual(await walk(EXPERIMENT), [...REVIEWED_COPIES, ...INTEGRATION_FILES].sort());
});

test('every experiment file is named in the explicit public allowlist', async () => {
  const listed = new Set(publicFiles);
  for (const rel of await walk(EXPERIMENT)) {
    assert.ok(listed.has(`app/experiments/dsh-dgm/${rel}`), `missing from publicFiles: ${rel}`);
  }
});

test('the page carries the required labels, the return link and a single approved script', async () => {
  const html = await readFile(resolve(EXPERIMENT, 'index.html'), 'utf8');
  assert.ok(html.includes('Experimental: synthetic fixtures, shadow-only, no model calls, no applied changes'));
  assert.ok(html.includes('Measured fixture results are not real model performance'));
  assert.ok(html.includes('Administrator-only view'));
  assert.ok(html.includes('href="/app/"'), 'the page must link back to the control panel');
  assert.ok(html.includes('GET /api/admin/v1/status'), 'the page must name the gate it relies on');
  assert.ok(!/https?:\/\//i.test(html), 'the experiment page must not reference an external origin');
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'no inline event handlers');
  assert.ok(!/<style[\s>]/i.test(html), 'the CSP allows style-src self only');

  const scripts = html.match(/<script\b[^>]*>/gi) || [];
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0], '<script src="/app/experiments/dsh-dgm/dsh-dgm.js">');
});

test('the experiment container fails closed until the gate answers, and the static page claims no authority', async () => {
  const html = await readFile(resolve(EXPERIMENT, 'index.html'), 'utf8');
  const match = html.match(/<div id="experiment"([^>]*)>/);
  assert.ok(match, 'the experiment container must exist');
  assert.match(match[1], /\bhidden\b/, 'the experiment must start hidden');
  assert.ok(html.includes('id="access-gate"'), 'the access gate region must exist');
  assert.ok(html.includes('data-state="checking"'), 'the default access state is a pending check');
  assert.ok(html.includes('public static files'), 'the page must say the assets are public, not secret');
  assert.ok(html.includes('does not decide who is an administrator'), 'the client must not claim to authorize');
});

test('the control panel links to the admin experiment from the Overview tab, not a new tab', async () => {
  const html = await readFile(resolve(SITE, 'app/index.html'), 'utf8');
  const link = 'href="/app/experiments/dsh-dgm/index.html"';
  assert.ok(html.includes(link));
  assert.ok(html.includes('admin-only'), 'the entry must be labelled as admin-only');
  assert.ok(html.includes('Administrator access required'), 'the entry must say a grant is required');
  assert.ok(html.indexOf('id="experiments-panel"') > html.indexOf('id="ov-note"'), 'card follows the overview content');
  assert.ok(html.indexOf('id="experiments-panel"') < html.indexOf('id="tab-compute"'), 'card stays inside the overview tab');
  assert.equal((html.match(/data-tab=/g) || []).length, 10, 'no tab was added');
});

test('the loader checks the admin gate before importing the reviewed modules', async () => {
  const source = await readFile(resolve(EXPERIMENT, 'dsh-dgm.js'), 'utf8');
  assert.ok(!/^\s*(?:import|export)\s/m.test(source), 'the shell policy allows a classic script only');
  assert.ok(!/https?:\/\//i.test(source), 'no external origin');
  assert.ok(!/auth\/get-session/.test(source), 'the interactive view must not be gated on session alone');
  assert.ok(source.includes(ADMIN_STATUS_ENDPOINT));
  assert.ok(source.includes('/app/experiments/dsh-dgm/admin-gate.mjs'));
  assert.ok(source.includes('/app/experiments/dsh-dgm/src/demo.mjs'));
  const decision = source.indexOf('decideAdminAccess({');
  const demo = source.indexOf('await import(DEMO_MODULE)');
  assert.ok(decision > -1 && demo > decision, 'the demo module load must follow the decision');
  assert.ok(source.indexOf('if (!decision.load)') < demo, 'a refused decision must return before loading');
});

test('the gate contract matches the admin router route and envelope', async () => {
  assert.equal(ADMIN_STATUS_ENDPOINT, '/api/admin/v1/status');
  assert.equal(ADMIN_STATUS_SCHEMA, 'admin.status.v1');
  assert.equal(ADMIN_GRANT_SCOPE, 'platform');
  // The route is the one the router mounts, with the permission every admin
  // role holds; a rename on either side fails here rather than at runtime.
  const router = await readFile(resolve(import.meta.dirname, '../src/admin/router.mjs'), 'utf8');
  assert.ok(router.includes(`path === '${ADMIN_STATUS_ENDPOINT}'`));
  assert.ok(router.includes("requireAdmin(ctx, 'admin.status')"));
  assert.ok(router.includes(`schema_version: '${ADMIN_STATUS_SCHEMA}'`));
  assert.ok(router.includes(`export const ADMIN_SCOPE = '${ADMIN_GRANT_SCOPE}'`));
  // The client refuses a role the server would not have issued. The list is
  // read out of the router source so a role added or removed there fails here.
  const listed = [...router.match(/export const ADMIN_ROLES = \[([\s\S]*?)\];/)[1].matchAll(/'([^']+)'/g)]
    .map((match) => match[1]);
  assert.deepEqual(ADMIN_ROLES, listed);
});

const CASES = [
  ['an authorized platform grant', { status: 200, payload: statusBody() }, ACCESS_STATES.AUTHORIZED, true],
  ['a second recognized role', { status: 200, payload: statusBody({ grant: { role: 'role_grant_authority', scope: 'platform', expires_at: null } }) }, ACCESS_STATES.AUTHORIZED, true],
  ['an anonymous caller (401 AUTH_REQUIRED)', { status: 401, payload: { error: 'Sign-in required.', code: 'AUTH_REQUIRED' } }, ACCESS_STATES.ANONYMOUS, false],
  ['an ordinary signed-in non-admin', forbidden(), ACCESS_STATES.DENIED, false],
  ['a demo account', forbidden(), ACCESS_STATES.DENIED, false],
  ['a revoked admin grant', forbidden(), ACCESS_STATES.DENIED, false],
  ['an expired admin grant', forbidden(), ACCESS_STATES.DENIED, false],
  ['an API-key caller', forbidden(), ACCESS_STATES.DENIED, false],
  ['an unavailable gate (503)', { status: 503, payload: { error: 'unavailable' } }, ACCESS_STATES.UNAVAILABLE, false],
  ['a failed request', { status: 0, error: 'request failed' }, ACCESS_STATES.UNAVAILABLE, false],
  ['an unreadable body', { status: 200, payload: null, error: 'unreadable response' }, ACCESS_STATES.UNAVAILABLE, false],
  ['no response at all', {}, ACCESS_STATES.UNAVAILABLE, false],
  ['an unknown route (404)', { status: 404, payload: { code: 'NOT_FOUND' } }, ACCESS_STATES.UNAVAILABLE, false],
  ['a 200 from some other route', { status: 200, payload: { schema_version: 'something.else.v1', grant: { role: 'operations_observer', scope: 'platform' } } }, ACCESS_STATES.UNAVAILABLE, false],
  ['a 200 array payload', { status: 200, payload: [statusBody()] }, ACCESS_STATES.UNAVAILABLE, false],
  ['a 200 status envelope with no grant', { status: 200, payload: statusBody({ grant: null }) }, ACCESS_STATES.DENIED, false],
  ['a grant with a non-string role', { status: 200, payload: statusBody({ grant: { role: 7, scope: 'platform' } }) }, ACCESS_STATES.DENIED, false],
  ['a grant with an unrecognized scope', { status: 200, payload: statusBody({ grant: { role: 'operations_observer', scope: 'fabric:one' } }) }, ACCESS_STATES.DENIED, false],
  // The server refuses unknown roles (ADMIN_ROLES has no catch-all), a grant
  // that lapsed before the response was observed, and a non-canonical or
  // unparseable expiry. The view gate must refuse them too.
  ['a grant for an unrecognized role', { status: 200, payload: statusBody({ grant: { role: 'root', scope: 'platform', expires_at: null } }) }, ACCESS_STATES.DENIED, false],
  ['a grant for a role-shaped unknown value', { status: 200, payload: statusBody({ grant: { role: 'operations_observer ', scope: 'platform', expires_at: null } }) }, ACCESS_STATES.DENIED, false],
  ['a grant expired before the observation', { status: 200, payload: statusBody({ grant: { role: 'operations_observer', scope: 'platform', expires_at: '2026-11-01T00:00:00.000Z' } }) }, ACCESS_STATES.DENIED, false],
  ['a grant expiring exactly at the observation', { status: 200, payload: statusBody({ grant: { role: 'operations_observer', scope: 'platform', expires_at: '2026-11-02T07:00:00.000Z' } }) }, ACCESS_STATES.DENIED, false],
  ['a malformed grant expiry', { status: 200, payload: statusBody({ grant: { role: 'operations_observer', scope: 'platform', expires_at: 'soon' } }) }, ACCESS_STATES.DENIED, false],
  ['a grant expiry that matches the shape but names no instant', { status: 200, payload: statusBody({ grant: { role: 'operations_observer', scope: 'platform', expires_at: '2026-13-01T00:00:00.000Z' } }) }, ACCESS_STATES.DENIED, false],
  ['a grant missing its expiry field', { status: 200, payload: statusBody({ grant: { role: 'operations_observer', scope: 'platform' } }) }, ACCESS_STATES.UNAVAILABLE, false],
  ['a grant with a live expiry', { status: 200, payload: statusBody({ grant: { role: 'operations_observer', scope: 'platform', expires_at: '2026-11-03T00:00:00.000Z' } }) }, ACCESS_STATES.AUTHORIZED, true],
  // Promise: a malformed 200 refuses. A documented envelope missing a field,
  // or naming a different admin/elevation/mutation state, is not the route's
  // answer and leaves the page closed.
  ['a 200 with the admin state missing', without('admin'), ACCESS_STATES.UNAVAILABLE, false],
  ['a 200 with the elevation field missing', without('elevation'), ACCESS_STATES.UNAVAILABLE, false],
  ['a 200 with the mutation state missing', without('mutations'), ACCESS_STATES.UNAVAILABLE, false],
  ['a 200 with the observation time missing', without('observed_at'), ACCESS_STATES.UNAVAILABLE, false],
  ['a 200 whose admin state is not the scaffold', { status: 200, payload: statusBody({ admin: 'live' }) }, ACCESS_STATES.UNAVAILABLE, false],
  ['a 200 whose elevation is implemented', { status: 200, payload: statusBody({ elevation: 'implemented' }) }, ACCESS_STATES.UNAVAILABLE, false],
  ['a 200 whose mutations are enabled', { status: 200, payload: statusBody({ mutations: 'enabled' }) }, ACCESS_STATES.UNAVAILABLE, false],
  ['a 200 whose observation time is unparseable', { status: 200, payload: statusBody({ observed_at: 'yesterday' }) }, ACCESS_STATES.UNAVAILABLE, false]
];

for (const [name, input, state, load] of CASES) {
  test(`admin gate: ${name} → ${state}`, () => {
    const decision = decideAdminAccess(input);
    assert.equal(decision.state, state);
    assert.equal(decision.load, load);
    assert.equal(typeof decision.message, 'string');
    assert.ok(decision.message.length > 0);
  });
}

test('admin gate: nothing loads without the authorized status envelope', () => {
  for (const [name, input, state] of CASES) {
    const decision = decideAdminAccess(input);
    assert.equal(decision.load, state === ACCESS_STATES.AUTHORIZED, `load flag disagrees with state for ${name}`);
    if (decision.load) assert.equal(state, ACCESS_STATES.AUTHORIZED, `unexpected load for ${name}`);
  }
});

test('admin gate: only the authorized decision carries a role, and refusals never echo the payload', () => {
  const authorized = decideAdminAccess({ status: 200, payload: statusBody() });
  assert.equal(authorized.role, 'operations_observer');
  assert.match(authorized.message, /operations_observer/);

  const marked = 'role-should-not-be-echoed';
  const smuggled = decideAdminAccess({ status: 403, payload: { grant: { role: marked, scope: 'platform' } } });
  assert.equal(smuggled.load, false);
  assert.ok(!smuggled.message.includes(marked));
  for (const [name, input] of CASES) {
    const decision = decideAdminAccess(input);
    if (decision.load) continue;
    assert.equal(decision.role, null, `refusal exposed a role for ${name}`);
    assert.ok(!decision.message.includes(marked), `refusal echoed payload material for ${name}`);
  }
});

test('admin gate: every refusal explains the server-side rule', () => {
  assert.match(decideAdminAccess({ status: 401 }).message, /not signed in/i);
  assert.match(decideAdminAccess({ status: 403 }).message, /not authorized/i);
  assert.match(decideAdminAccess({ status: 403 }).message, /demo|revoked/i);
  assert.match(decideAdminAccess({ status: 503 }).message, /did not complete/i);
});
