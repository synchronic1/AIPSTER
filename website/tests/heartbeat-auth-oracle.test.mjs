/* Handoff fix 4 (P3): the revoked state of a key is disclosed only to the
 * holder of its real secret. Forged secrets get the generic 401
 * AUTH_REQUIRED, so a key id alone is not a revocation oracle. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestEnv, readJson } from './d1-shim.mjs';

async function register(t, user, name) {
  const res = await readJson(await t.call('/api/inventory', {
    method: 'POST', headers: { ...t.as(user), ...t.csrf },
    body: { name, kind: 'local', origin: 'lab', cpu: 'x', gpu: 'y' },
  }));
  assert.equal(res.status, 201, res.text);
  return res.json;
}

async function mintHeartbeat(t, user, resourceId) {
  const out = await readJson(await t.call('/api/keys', {
    method: 'POST', headers: { ...t.as(user), ...t.csrf }, body: { name: 'hb', scope: 'heartbeat', resourceId },
  }));
  assert.equal(out.status, 201, out.text);
  return out.json;
}

const beat = (t, secret, id) => t.call(`/api/resources/${id}/heartbeat`, {
  method: 'POST', headers: { Authorization: 'Bearer ' + secret }, body: JSON.stringify({ usable: true }),
});
const forge = (secret) => secret.replace(/_[^_]+$/, '_' + 'A'.repeat(43));

test('forged secret for a revoked key id learns nothing; real secret gets KEY_REVOKED', async () => {
  const t = await createTestEnv();
  const r = await register(t, t.alice, 'box');
  const key = await mintHeartbeat(t, t.alice, r.id);
  const rev = await readJson(await t.call('/api/keys/' + key.id, { method: 'DELETE', headers: { ...t.as(t.alice), ...t.csrf } }));
  assert.equal(rev.status, 200);
  const forged = await readJson(await beat(t, forge(key.secret), r.id));
  assert.equal(forged.status, 401);
  assert.equal(forged.json.code, 'AUTH_REQUIRED');
  const real = await readJson(await beat(t, key.secret, r.id));
  assert.equal(real.status, 401);
  assert.equal(real.json.code, 'KEY_REVOKED');
});

test('forged secrets for live keys and unknown ids stay generic 401s', async () => {
  const t = await createTestEnv();
  const r = await register(t, t.alice, 'box');
  const key = await mintHeartbeat(t, t.alice, r.id);
  const live = await readJson(await beat(t, forge(key.secret), r.id));
  assert.equal(live.status, 401);
  assert.equal(live.json.code, 'AUTH_REQUIRED');
  const ghost = await readJson(await beat(t, 'aip_live_k_ffffffffffffffff_' + 'A'.repeat(43), r.id));
  assert.equal(ghost.status, 401);
  assert.equal(ghost.json.code, 'AUTH_REQUIRED');
});
