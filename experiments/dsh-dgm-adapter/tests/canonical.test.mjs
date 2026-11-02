import test from 'node:test';
import assert from 'node:assert/strict';

import { canonicalJson, digestOf, idFromDigest, seal, sha256Hex, verifySeal } from '../src/canonical.mjs';

test('canonical JSON sorts keys and ignores insertion order', () => {
  const a = { b: 1, a: { d: [3, 2], c: 'x' } };
  const b = { a: { c: 'x', d: [3, 2] }, b: 1 };
  assert.equal(canonicalJson(a), canonicalJson(b));
  assert.equal(canonicalJson(a), '{"a":{"c":"x","d":[3,2]},"b":1}');
});

test('canonical JSON rejects values JSON cannot represent', () => {
  assert.throws(() => canonicalJson({ a: undefined }), /undefined/);
  assert.throws(() => canonicalJson({ a: NaN }), /finite/);
  assert.throws(() => canonicalJson({ a: () => 1 }), /not JSON-safe/);
  assert.throws(() => canonicalJson({ a: new Date(0) }), /plain object/);
  const cyclic = { a: 1 };
  cyclic.self = cyclic;
  assert.throws(() => canonicalJson(cyclic), /cycle/);
});

test('sha256Hex matches the published test vector', async () => {
  assert.equal(
    await sha256Hex('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
  );
});

test('digestOf is stable and key-order independent', async () => {
  assert.equal(await digestOf({ a: 1, b: 2 }), await digestOf({ b: 2, a: 1 }));
  assert.notEqual(await digestOf({ a: 1 }), await digestOf({ a: 2 }));
});

test('idFromDigest is prefixed, shortened and validated', async () => {
  const digest = await digestOf({ x: 1 });
  const id = idFromDigest('run', digest, 12);
  assert.match(id, /^run_[0-9a-f]{12}$/);
  assert.throws(() => idFromDigest('run', 'not-a-digest'), /64-char/);
});

test('seal and verifySeal detect any mutation', async () => {
  const sealed = await seal({ run: 'r1', status: 'selected' }, 'verdict_sha256');
  assert.match(sealed.verdict_sha256, /^[0-9a-f]{64}$/);

  const good = await verifySeal(sealed, 'verdict_sha256');
  assert.equal(good.ok, true);
  assert.equal(good.digest, sealed.verdict_sha256);

  const tampered = { ...sealed, status: 'rejected' };
  const bad = await verifySeal(tampered, 'verdict_sha256');
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'DIGEST_MISMATCH');

  assert.equal((await verifySeal({}, 'verdict_sha256')).reason, 'MISSING_DIGEST');
  assert.equal((await verifySeal(null, 'verdict_sha256')).reason, 'NOT_AN_OBJECT');
});

test('sealing is idempotent and never digests its own field', async () => {
  const once = await seal({ a: 1 }, 'sha256');
  const twice = await seal(once, 'sha256');
  assert.equal(once.sha256, twice.sha256);
});
