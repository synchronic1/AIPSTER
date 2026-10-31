/* Built with Meta Muse. */
// Latency-first routing, Milestone A: one shared authoritative eligibility
// path plus a versioned deterministic decision engine. No provider calls,
// no dispatch (POST /api/jobs stays 501); ranking only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestEnv } from './d1-shim.mjs';
import { canUseResource } from '../src/lib/access.js';
import { listEligible } from '../src/routing/eligibility.mjs';
import {
  ROUTING_POLICY_VERSION, scoreCandidates, toEnvelopeCandidate,
  routingDigests, ROUTING_CANDIDATE_MAX, newRoutingRequest,
} from '../src/routing/policy.mjs';

async function seed(t) {
  const now = new Date().toISOString();
  const old = new Date(Date.now() - 3600 * 1000).toISOString();
  const rows = [
    // id, owner, name, kind, caps, cfg, authed, online, usable, hb
    ['r_alice1', 'u_alice', 'Alice One', 'local', '["text-generation"]', 1, 1, 1, 1, now],
    ['r_alice2', 'u_alice', 'Alice Two', 'cluster', '["text-generation","embeddings"]', 1, 1, 1, 1, old],
    ['r_alice_off', 'u_alice', 'Alice Off', 'local', '[]', 1, 1, 0, 0, null],
    ['r_alice_nous', 'u_alice', 'Alice Hold', 'local', '[]', 1, 1, 1, 0, now],
    ['r_bob1', 'u_bob', 'Bob Box', 'local', '["text-generation"]', 1, 1, 1, 1, now],
  ];
  for (const [id, owner, name, kind, caps, cfg, authed, online, usable, hb] of rows) {
    await t.DB.prepare('INSERT INTO resources (id, owner_id, name, kind, origin, cpu, gpu, capabilities_json, configured, authenticated, online, usable, heartbeat_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .bind(id, owner, name, kind, 'rack', 'cpu', '', caps, cfg, authed, online, usable, hb, now).run();
  }
  // Active grant: bob -> alice on r_bob1 with quota headroom.
  await t.DB.prepare('INSERT INTO grants (id, resource_id, owner_id, grantee_id, max_jobs, max_tokens, used_jobs, used_tokens, inference_only, created_at, revoked_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .bind('g_live', 'r_bob1', 'u_bob', 'u_alice', 10, 50000, 2, 1000, 1, now, null).run();
  // Exhausted grant on a second bob resource.
  await t.DB.prepare('INSERT INTO resources (id, owner_id, name, kind, origin, cpu, gpu, capabilities_json, configured, authenticated, online, usable, heartbeat_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .bind('r_bob2', 'u_bob', 'Bob Spent', 'local', 'rack', 'cpu', '', '[]', 1, 1, 1, 1, now, now).run();
  await t.DB.prepare('INSERT INTO grants (id, resource_id, owner_id, grantee_id, max_jobs, max_tokens, used_jobs, used_tokens, inference_only, created_at, revoked_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .bind('g_spent', 'r_bob2', 'u_bob', 'u_alice', 1, 100, 1, 100, 1, now, null).run();
  // Revoked grant on a third bob resource.
  await t.DB.prepare('INSERT INTO resources (id, owner_id, name, kind, origin, cpu, gpu, capabilities_json, configured, authenticated, online, usable, heartbeat_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .bind('r_bob3', 'u_bob', 'Bob Cut', 'local', 'rack', 'cpu', '', '[]', 1, 1, 1, 1, now, now).run();
  await t.DB.prepare('INSERT INTO grants (id, resource_id, owner_id, grantee_id, max_jobs, max_tokens, used_jobs, used_tokens, inference_only, created_at, revoked_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .bind('g_cut', 'r_bob3', 'u_bob', 'u_alice', 10, 50000, 0, 0, 1, now, now).run();
  // Fourth bob resource with no grant at all: purely foreign to alice.
  await t.DB.prepare('INSERT INTO resources (id, owner_id, name, kind, origin, cpu, gpu, capabilities_json, configured, authenticated, online, usable, heartbeat_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .bind('r_bob4', 'u_bob', 'Bob Far', 'local', 'rack', 'cpu', '', '[]', 1, 1, 1, 1, now, now).run();
}

// ---------- shared access path (extracted, behavior preserved) ----------

test('routing access: owner, grant, revoked, quota, foreign', async () => {
  const t = await createTestEnv({});
  await seed(t);
  const row = async (id) => t.DB.prepare('SELECT * FROM resources WHERE id = ?').bind(id).first();
  assert.deepEqual((await canUseResource(t.DB, 'u_alice', await row('r_alice1'))).ok, true);
  const via = await canUseResource(t.DB, 'u_alice', await row('r_bob1'));
  assert.equal(via.ok, true);
  assert.equal(via.grantId, 'g_live');
  assert.equal((await canUseResource(t.DB, 'u_alice', await row('r_bob2'))).ok, false);
  assert.equal((await canUseResource(t.DB, 'u_alice', await row('r_bob3'))).ok, false);
  assert.equal((await canUseResource(t.DB, 'u_bob', await row('r_alice1'))).ok, false);
});

// ---------- eligibility: one authoritative path ----------

test('routing eligibility: owned plus usable grants, nothing else', async () => {
  const t = await createTestEnv({});
  await seed(t);
  const out = await listEligible(t.DB, 'u_alice', { nowMs: Date.now() });
  const ids = out.eligible.map((c) => c.resourceId).sort();
  assert.deepEqual(ids, ['r_alice1', 'r_alice2', 'r_bob1']);
  const reasons = new Map(out.rejected.map((r) => [r.resourceId, r.reason]));
  assert.equal(reasons.get('r_alice_off'), 'UNREACHABLE');
  assert.equal(reasons.get('r_alice_nous'), 'NOT_USABLE');
  assert.equal(reasons.get('r_bob2'), 'QUOTA_EXHAUSTED');
  // Revoked and never-granted rows are absent everywhere: no oracle
  // distinguishes "revoked" from "foreign".
  for (const absent of ['r_bob3', 'r_bob4']) {
    assert.ok(!out.eligible.some((c) => c.resourceId === absent), absent);
    assert.equal(reasons.get(absent), undefined, absent);
  }
  // Bob sees only his own rows: alice's resources are absent, not denied.
  const bob = await listEligible(t.DB, 'u_bob', { nowMs: Date.now() });
  assert.ok(bob.eligible.every((c) => c.ownerId === 'u_bob'));
  assert.ok(!JSON.stringify(bob).includes('r_alice1'));
});

test('routing eligibility: kind filter and token-fit are hard constraints', async () => {
  const t = await createTestEnv({});
  await seed(t);
  const local = await listEligible(t.DB, 'u_alice', { nowMs: Date.now(), kinds: ['local'] });
  assert.ok(local.eligible.length > 0);
  assert.ok(local.eligible.every((c) => c.kind === 'local'));
  assert.equal(local.rejected.find((r) => r.resourceId === 'r_alice2').reason, 'KIND_EXCLUDED');
  const fit = await listEligible(t.DB, 'u_alice', { nowMs: Date.now(), maxTokens: 49000 });
  assert.ok(fit.eligible.some((c) => c.resourceId === 'r_bob1'));
  const nofit = await listEligible(t.DB, 'u_alice', { nowMs: Date.now(), maxTokens: 49500 });
  assert.equal(nofit.rejected.find((r) => r.resourceId === 'r_bob1').reason, 'CAPACITY_INSUFFICIENT');
  // Owned rows have no quota counters: capacity unknown, never excluded.
  assert.ok(nofit.eligible.some((c) => c.resourceId === 'r_alice1'));
});

test('routing eligibility: model compatibility stays unverified without a registry', async () => {
  const t = await createTestEnv({});
  await seed(t);
  const out = await listEligible(t.DB, 'u_alice', { nowMs: Date.now(), model: 'llama-3-8b' });
  for (const c of out.eligible) assert.equal(c.modelCompat, 'unverified');
  // An exact capability-token match is a labeled soft signal, not proof.
  const tok = await listEligible(t.DB, 'u_alice', { nowMs: Date.now(), model: 'text-generation' });
  const hit = tok.eligible.find((c) => c.resourceId === 'r_alice1');
  assert.equal(hit.exactTokenMatch, true);
  assert.equal(hit.modelCompat, 'unverified');
});

// ---------- deterministic scoring ----------

test('routing policy: pinned version, stable order, contributions add up', async () => {
  const t = await createTestEnv({});
  await seed(t);
  assert.equal(ROUTING_POLICY_VERSION, 'route/v1');
  const out = await listEligible(t.DB, 'u_alice', { nowMs: 1760000000000 });
  const a = scoreCandidates(out.eligible, { model: 'text-generation', maxTokens: 100 });
  const b = scoreCandidates(out.eligible, { model: 'text-generation', maxTokens: 100 });
  assert.deepEqual(a.ranked.map((r) => r.alias), b.ranked.map((r) => r.alias));
  assert.ok(a.ranked.every((r) => r.policyVersion === 'route/v1'));
  for (const r of a.ranked) {
    assert.equal(r.score, r.contributions.reduce((s, c) => s + c.points, 0));
  }
  // Fresh + owned + exact-token outranks stale; scores are ordered.
  const scores = a.ranked.map((r) => r.score);
  assert.deepEqual([...scores].sort((x, y) => y - x), scores);
  assert.equal(a.ranked[0].resourceId, 'r_alice1');
  // Identical twins tie-break by alias order, deterministically.
  const twin = scoreCandidates([a.ranked[0].candidate, a.ranked[0].candidate], {});
  assert.deepEqual(twin.ranked.map((r) => r.alias), ['r1', 'r1']);
});

test('routing policy: envelope carries only eligible aliases, no server facts', async () => {
  const t = await createTestEnv({});
  await seed(t);
  const out = await listEligible(t.DB, 'u_alice', { nowMs: Date.now() });
  const ranked = scoreCandidates(out.eligible, {});
  const env = ranked.ranked.map(toEnvelopeCandidate);
  const text = JSON.stringify(env);
  for (const leak of ['r_alice1', 'Alice One', 'u_alice', 'u_bob', 'g_live', 'rack', 'cpu', 'host']) {
    assert.ok(!text.includes(leak), `leaked: ${leak}`);
  }
  assert.ok(env.every((e) => /^r[0-9]+$/.test(e.id)));
  // Forbidden candidates cannot enter the envelope: it is built from the
  // eligible list only, and every id resolves back server-side.
  const aliases = new Set(env.map((e) => e.id));
  assert.equal(aliases.size, out.eligible.length);
});

test('routing policy: digests pin features and snapshot; changes force re-evaluation', async () => {
  const t = await createTestEnv({});
  await seed(t);
  const out = await listEligible(t.DB, 'u_alice', { nowMs: Date.now() });
  const ranked = scoreCandidates(out.eligible, { model: 'm', maxTokens: 10 });
  const d1 = await routingDigests({ model: 'm', maxTokens: 10 }, ranked.ranked);
  const d2 = await routingDigests({ model: 'm', maxTokens: 10 }, ranked.ranked);
  assert.deepEqual(d1, d2);
  const d3 = await routingDigests({ model: 'm', maxTokens: 11 }, ranked.ranked);
  assert.notEqual(d1.featureDigest, d3.featureDigest);
  const d4 = await routingDigests({ model: 'm', maxTokens: 10 }, ranked.ranked.slice(1));
  assert.notEqual(d1.candidateDigest, d4.candidateDigest);
});

test('routing policy: request identity is immutable with a future deadline', () => {
  const r = newRoutingRequest({ model: 'm', maxTokens: 100, kinds: ['local'], nowMs: 1760000000000 });
  assert.equal(r.policyVersion, 'route/v1');
  assert.match(r.requestId, /^route_/);
  assert.ok(r.deadlineMs > 1760000000000);
  assert.ok(Object.isFrozen(r));
  assert.throws(() => newRoutingRequest({ deadlineMs: 1000, nowMs: 1760000000000 }), /deadline/);
});

test('routing policy: candidate count is bounded deterministically', async () => {
  const t = await createTestEnv({});
  await seed(t);
  const out = await listEligible(t.DB, 'u_alice', { nowMs: Date.now() });
  const many = [];
  for (let i = 0; i < ROUTING_CANDIDATE_MAX + 50; i++) {
    many.push({ ...out.eligible[0], alias: `r${i + 1}`, resourceId: `r_x${i}` });
  }
  const ranked = scoreCandidates(many, {});
  assert.equal(ranked.ranked.length, ROUTING_CANDIDATE_MAX);
  assert.equal(ranked.truncated, true);
  const small = scoreCandidates(out.eligible, {});
  assert.equal(small.truncated, false);
});
