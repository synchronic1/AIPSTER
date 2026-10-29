/* Built with Meta Muse. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { canonicalize, sha256Hex, digestJson } from '../src/fabric/canonical.mjs';
import { evaluate, selectWitness, REASONS } from '../src/fabric/policy.mjs';

const FIX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fabric');
const load = (n) => JSON.parse(readFileSync(path.join(FIX, n), 'utf8'));

test('canonicalization is key-ordered and stable (vectors)', () => {
  assert.equal(canonicalize({ b: 1, a: [3, { z: 1, y: 2 }] }), '{"a":[3,{"y":2,"z":1}],"b":1}');
  assert.equal(canonicalize({ a: 1 }), canonicalize(JSON.parse('{"a":1}')));
});

test('sha256 sanity vector', async () => {
  assert.equal(await sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('preview digest is stable and tamper-evident', async () => {
  const { preview, expectedDigest } = load('preview-a-b.json');
  assert.equal(await digestJson(preview), expectedDigest, 'digest stability');
  const tampered = JSON.parse(JSON.stringify(preview));
  tampered.snapshot.push({ resourceId: 'r3-future', incarnation: 'gen1', capabilities: ['infer'], models: ['cpu-echo-1'] });
  assert.notEqual(await digestJson(tampered), expectedDigest, 'snapshot widening changes the digest');
  const swapped = JSON.parse(JSON.stringify(preview));
  swapped.consumers = ['u_mallory'];
  assert.notEqual(await digestJson(swapped), expectedDigest, 'consumer swap changes the digest');
});

test('approval binds the exact preview digest', async () => {
  const { preview, expectedDigest } = load('preview-a-b.json');
  const { approval } = load('approval-a-b.json');
  assert.equal(approval.previewDigest, expectedDigest);
  assert.equal(approval.previewDigest, await digestJson(preview));
});

function ctx() {
  const { grants, denies } = load('grants-a-b.json');
  const reqs = load('requests-a-b.json');
  const at = (r) => ({ ...r, at: reqs.at });
  return { grants, denies, reqs, at };
}

test('valid request allows with the earliest-expiry witness', () => {
  const { grants, denies, reqs, at } = ctx();
  const out = evaluate(at(reqs.valid), { grants, denies });
  assert.equal(out.decision, 'allow');
  assert.equal(out.witness, 'g1', 'earliest expiry wins over g1late');
  assert.equal(selectWitness(at(reqs.valid), grants).id, 'g1');
});

test('combined request fails: no single grant covers model plus quota (A06)', () => {
  const { grants, denies, reqs, at } = ctx();
  const out = evaluate(at(reqs.combinedNeedsTwoGrants), { grants, denies });
  assert.equal(out.decision, 'deny');
  assert.equal(out.code, REASONS.NO_MATCHING_GRANT);
});

test('wrong recipient, changed incarnation, and stale revision deny', () => {
  const { grants, denies, reqs, at } = ctx();
  assert.equal(evaluate(at(reqs.wrongRecipient), { grants, denies }).code, REASONS.NO_MATCHING_GRANT);
  assert.equal(evaluate(at(reqs.incarnationChanged), { grants, denies }).code, REASONS.NO_MATCHING_GRANT);
  const stale = evaluate(at(reqs.staleRevision), { grants, denies });
  assert.equal(stale.code, REASONS.NO_MATCHING_GRANT);
  assert.ok(stale.details.some((d) => d.reasons.includes(REASONS.STALE_REVISION)), 'stale revision diagnosed');
});

test('explicit deny wins over matching allows', () => {
  const { grants, denies, reqs, at } = ctx();
  const mallory = { ...at(reqs.deniedActor), consumer: 'u_bob' };
  assert.equal(evaluate(mallory, { grants, denies }).decision, 'allow', 'control: bob allowed');
  const out = evaluate(at(reqs.deniedActor), { grants, denies });
  assert.equal(out.decision, 'deny');
  assert.equal(out.code, REASONS.EXPLICIT_DENY);
});

test('expired and paused grants never match', () => {
  const { grants, reqs, at } = ctx();
  const only = (id) => grants.filter((g) => g.id === id);
  assert.equal(evaluate(at(reqs.valid), { grants: only('g0expired') }).decision, 'deny');
  assert.equal(evaluate(at(reqs.valid), { grants: only('g0paused') }).decision, 'deny');
});
