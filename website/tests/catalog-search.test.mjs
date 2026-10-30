/* Built with Meta Muse. */
// Catalog search/detail (Phase 1): AC01 (browsing moves no weights),
// AC03 (truthful pagination/empty/error states), filters, auth boundaries.
// Fixture mode only: live Hub calls never run in tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword } from 'better-auth/crypto';
import { createTestEnv, readJson } from './d1-shim.mjs';
import { assertHubUrl, normalizeHubModel } from '../src/lib/catalog/hub.mjs';

const fx = () => createTestEnv({ CATALOG_FIXTURES: '1' });

async function seedDemo(t) {
  const now = new Date().toISOString();
  await t.DB.prepare('INSERT INTO "user" (id, name, email, emailVerified, image, username, displayUsername, demo, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind('u_demo_cat', 'Demo', 'democat@example.com', 0, null, 'democat', 'democat', 1, now, now).run();
  const hash = await hashPassword('demo-cat-password-01');
  await t.DB.prepare('INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind('acc_demo_cat', 'u_demo_cat', 'credential', 'u_demo_cat', hash, now, now).run();
  const res = await t.call('/api/auth/sign-in/username', { method: 'POST', body: { username: 'democat', password: 'demo-cat-password-01' } });
  assert.equal(res.status, 200);
  return { Cookie: res.headers.getSetCookie().find((c) => c.startsWith('better-auth.session_token=')).split(';')[0] };
}

test('AC01: search and detail issue zero weight downloads', async () => {
  const t = await fx();
  const s = await readJson(await t.call('/api/catalog/search?limit=20', { headers: t.as(t.alice) }));
  assert.equal(s.status, 200, s.text);
  assert.equal(s.json.upstream, 'fixture');
  assert.deepEqual(s.json.calls, { metadata: 1, weights: 0 });
  for (const item of s.json.items) {
    // Card text may quote URLs as inert content (AC04); the payload must
    // carry no download affordance: no URL-valued fields, no snapshot or
    // resolve-download paths.
    assert.ok(!/download|snapshot\/|resolve\//i.test(JSON.stringify(item)), 'no download affordance in search items');
    assert.ok(!('downloadUrl' in item || 'url' in item || 'downloads' in item), 'no URL-valued fields');
  }
  const d = await readJson(await t.call('/api/catalog/assets/' + encodeURIComponent('fixture-org/tiny-instruct-gguf'), { headers: t.as(t.alice) }));
  assert.equal(d.status, 200, d.text);
  assert.deepEqual(d.json.calls, { metadata: 1, weights: 0 });
  assert.ok(Array.isArray(d.json.files) && d.json.files.length > 0, 'manifest lists files without fetching them');
  assert.ok(d.json.files.every((f) => f.sha256 === null), 'digests stay null until a pinned resolve');
});

test('AC03: pagination, empty results, and errors are distinct states', async () => {
  const t = await fx();
  const p1 = await readJson(await t.call('/api/catalog/search?limit=2&offset=0', { headers: t.as(t.alice) }));
  assert.equal(p1.status, 200);
  assert.equal(p1.json.items.length, 2);
  assert.equal(p1.json.total, 4);
  const p2 = await readJson(await t.call('/api/catalog/search?limit=2&offset=2', { headers: t.as(t.alice) }));
  assert.equal(p2.json.items.length, 2);
  assert.notDeepEqual(p1.json.items.map((i) => i.id), p2.json.items.map((i) => i.id));
  const empty = await readJson(await t.call('/api/catalog/search?q=zzz-no-such-model', { headers: t.as(t.alice) }));
  assert.equal(empty.status, 200, 'empty is 200 with items:[], never an error');
  assert.deepEqual(empty.json.items, []);
  assert.equal(empty.json.total, 0);
  const bad = await readJson(await t.call('/api/catalog/search?kind=nope', { headers: t.as(t.alice) }));
  assert.equal(bad.status, 400);
  assert.equal(bad.json.code, 'BAD_FILTER');
});

test('search filters narrow honestly', async () => {
  const t = await fx();
  const headers = t.as(t.alice);
  const q = async (qs) => readJson(await t.call('/api/catalog/search?' + qs, { headers }));
  assert.equal((await q('kind=adapter')).json.items.length, 1);
  assert.equal((await q('format=gguf')).json.items.length, 1);
  assert.equal((await q('task=text-generation')).json.items.length, 4);
  assert.equal((await q('license=mit')).json.items.length, 1);
  assert.equal((await q('q=tiny-lora')).json.items.length, 1);
  assert.equal((await q('quant=Q4_K_M')).json.items.length, 1);
});

test('detail validates ids and reports missing assets', async () => {
  const t = await fx();
  const headers = t.as(t.alice);
  const bad = await readJson(await t.call('/api/catalog/assets/not-a-repo', { headers }));
  assert.equal(bad.status, 400);
  assert.equal(bad.json.code, 'BAD_REPO');
  const missing = await readJson(await t.call('/api/catalog/assets/' + encodeURIComponent('fixture-org/nope'), { headers }));
  assert.equal(missing.status, 404);
  assert.equal(missing.json.code, 'ASSET_NOT_FOUND');
  const priv = await readJson(await t.call('/api/catalog/assets/priv%3Aabc', { headers }));
  assert.equal(priv.status, 404, 'private ids name nothing in Phase 1');
  const ok = await readJson(await t.call('/api/catalog/assets/' + encodeURIComponent('hub:fixture-org/tiny-base'), { headers }));
  assert.equal(ok.status, 200, 'hub:-prefixed ids resolve');
  assert.equal(ok.json.repo, 'fixture-org/tiny-base');
  assert.match(ok.json.revision, /^[a-f0-9]{40}$/);
});

test('search/detail auth: anonymous denied, heartbeat keys refused, demo browses fixtures', async () => {
  const t = await fx();
  const anon = await readJson(await t.call('/api/catalog/search'));
  assert.equal(anon.status, 401);
  // Heartbeat-scoped key: mint one, then prove it cannot browse.
  const reg = await readJson(await t.call('/api/inventory', { method: 'POST', headers: { ...t.as(t.alice), ...t.csrf }, body: { name: 'b' } }));
  const mint = await readJson(await t.call('/api/keys', { method: 'POST', headers: { ...t.as(t.alice), ...t.csrf }, body: { name: 'hb', scope: 'heartbeat', resourceId: reg.json.id } }));
  const hb = await readJson(await t.call('/api/catalog/search', { headers: { Authorization: 'Bearer ' + mint.json.secret } }));
  assert.equal(hb.status, 403);
  assert.equal(hb.json.code, 'KEY_SCOPE');
  const read = await readJson(await t.call('/api/keys', { method: 'POST', headers: { ...t.as(t.alice), ...t.csrf }, body: { name: 'r', scope: 'read' } }));
  const rk = await readJson(await t.call('/api/catalog/search?limit=1', { headers: { Authorization: 'Bearer ' + read.json.secret } }));
  assert.equal(rk.status, 200, 'read keys may browse');
  const demoCookie = await seedDemo(t);
  const demo = await readJson(await t.call('/api/catalog/search?limit=1', { headers: demoCookie }));
  assert.equal(demo.status, 200, 'demo may browse');
  assert.equal(demo.json.fixture, true, 'demo always sees fixtures');
});

test('compat filter needs a node and evaluates per item without combining nodes', async () => {
  const t = await fx();
  const headers = t.as(t.alice);
  const noNode = await readJson(await t.call('/api/catalog/search?compat=blocked', { headers }));
  assert.equal(noNode.status, 400);
  const badState = await readJson(await t.call('/api/catalog/search?compat=ready&nodeId=r_x', { headers }));
  assert.equal(badState.status, 400);
  const reg = await readJson(await t.call('/api/inventory', { method: 'POST', headers: { ...t.as(t.alice), ...t.csrf }, body: { name: 'n1' } }));
  const ghost = await readJson(await t.call('/api/catalog/search?compat=unknown&nodeId=r_nope', { headers }));
  assert.equal(ghost.status, 404);
  const unk = await readJson(await t.call(`/api/catalog/search?compat=unknown&nodeId=${reg.json.id}`, { headers }));
  assert.equal(unk.status, 200, unk.text);
  assert.equal(unk.json.compatFiltered, true);
  assert.ok(unk.json.items.length > 0, 'no snapshot means every item is unknown');
  const bobs = await readJson(await t.call('/api/inventory', { method: 'POST', headers: { ...t.as(t.bob), ...t.csrf }, body: { name: 'n2' } }));
  const cross = await readJson(await t.call(`/api/catalog/search?compat=unknown&nodeId=${bobs.json.id}`, { headers }));
  assert.equal(cross.status, 404, 'cannot filter on another tenant node');
});

test('Hub URL policy refuses SSRF shapes (T2)', async () => {
  const bad = (url) => assert.throws(() => assertHubUrl(url), (e) => e.code === 'BAD_HUB_URL');
  bad('http://huggingface.co/api/models');
  bad('https://evil.invalid/api/models');
  bad('https://huggingface.co:8443/api/models');
  bad('https://user:huggingface.co/api/models');
  bad('https://169.254.169.254/latest');
  bad('not a url %%');
  const ok = assertHubUrl('https://huggingface.co/api/models?limit=1');
  assert.equal(ok.hostname, 'huggingface.co');
});

test('Hub normalization never invents identity', async () => {
  assert.throws(() => normalizeHubModel(null), (e) => e.code === 'HUB_BAD_SHAPE');
  assert.throws(() => normalizeHubModel({ id: 'no-slash' }), (e) => e.code === 'HUB_BAD_SHAPE');
  const a = normalizeHubModel({ id: 'o/m', tags: ['license:apache-2.0'], siblings: [{ rfilename: 'x.gguf', size: 10 }] });
  assert.equal(a.revision, '', 'missing sha stays unpinned, never synthesized');
  assert.equal(a.format, 'gguf');
  assert.equal(a.files[0].sha256, null);
});
