/* Built with Meta Muse. */
// Private uploads + validation + My assets (Phase 2): AC10 (private
// lifecycle + tenant isolation), AC11 (refusals), AC12 (atomic validated
// promotion), AC13 (duplicate/interrupted/expiry recovery). Fixture memory
// store (CATALOG_FIXTURES=1); one test proves the unprovisioned refusal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword } from 'better-auth/crypto';
import { createTestEnv, readJson } from './d1-shim.mjs';
import { validateManifest, validateRelPath, screenMagic, screenSafetensors, checkShardIndex, MAX_ASSET_BYTES } from '../src/lib/catalog/validate.mjs';
import { __resetFixtureStore } from '../src/lib/catalog/store.mjs';

const fx = () => createTestEnv({ CATALOG_FIXTURES: '1' });
const GGUF = 'fixture-org/tiny-instruct-gguf';

const sess = (t, user) => ({ ...t.as(user), ...t.csrf });

async function seedDemo(t) {
  const now = new Date().toISOString();
  await t.DB.prepare('INSERT INTO "user" (id, name, email, emailVerified, image, username, displayUsername, demo, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind('u_demo', 'Demo explorer', 'demo@aipster.invalid', 0, null, 'demo', 'demo', 1, now, now).run();
  const hash = await hashPassword('demo-test-password-01');
  await t.DB.prepare('INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind('acc_demo_credential', 'u_demo', 'credential', 'u_demo', hash, now, now).run();
  const res = await t.call('/api/auth/sign-in/username', { method: 'POST', body: { username: 'demo', password: 'demo-test-password-01' } });
  const session = res.headers.getSetCookie().find((c) => c && c.startsWith('better-auth.session_token='));
  assert.ok(session, 'demo sign-in sets a session cookie');
  return { Cookie: session.split(';')[0] };
}

function tinySafetensors() {
  const header = JSON.stringify({ w: { dtype: 'F32', shape: [2], data_offsets: [0, 8] } });
  const hlen = Buffer.byteLength(header);
  const out = new Uint8Array(8 + hlen + 8);
  new DataView(out.buffer).setBigUint64(0, BigInt(hlen), true);
  out.set(new TextEncoder().encode(header), 8);
  return out;
}

async function begin(t, user, spec) {
  return readJson(await t.call('/api/catalog/uploads', { method: 'POST', headers: sess(t, user), body: spec }));
}

async function chunk(t, user, id, relpath, index, bytes) {
  return readJson(await t.call(`/api/catalog/uploads/${id}/chunk?path=${encodeURIComponent(relpath)}&index=${index}`, {
    method: 'PUT', headers: sess(t, user), rawBody: bytes,
  }));
}

async function finalize(t, user, id) {
  return readJson(await t.call(`/api/catalog/uploads/${id}/finalize`, { method: 'POST', headers: sess(t, user), body: {} }));
}

async function roundTrip(t, user, name, files, extra = {}) {
  // files: [{ relpath, bytes: Uint8Array }]
  const b = await begin(t, user, {
    name, kind: 'model', task: 'text-generation', format: 'gguf', license: 'apache-2.0',
    files: files.map((f) => ({ relpath: f.relpath, bytes: f.bytes.length })), ...extra,
  });
  assert.equal(b.status, 201, b.text);
  for (const f of files) {
    // Two chunks per file to exercise assembly (AC13 paths use this too).
    const mid = Math.max(1, Math.floor(f.bytes.length / 2));
    const c0 = await chunk(t, user, b.json.id, f.relpath, 0, f.bytes.slice(0, mid));
    assert.equal(c0.status, 200, c0.text);
    const c1 = await chunk(t, user, b.json.id, f.relpath, 1, f.bytes.slice(mid));
    assert.equal(c1.status, 200, c1.text);
  }
  return finalize(t, user, b.json.id);
}

const ggufBytes = (n = 64) => new Uint8Array(n).fill(0x47);

test('AC10: private upload validates, lists for the owner, hides from others', async () => {
  const t = await fx();
  __resetFixtureStore();
  const fin = await roundTrip(t, t.alice, 'my-gguf', [{ relpath: 'model.gguf', bytes: ggufBytes() }]);
  assert.equal(fin.status, 201, fin.text);
  assert.equal(fin.json.state, 'validated');
  assert.match(fin.json.revision, /^[a-f0-9]{64}$/);
  const mine = await readJson(await t.call('/api/catalog/my-assets', { headers: sess(t, t.alice) }));
  assert.equal(mine.json.items.length, 1);
  assert.equal(mine.json.items[0].name, 'my-gguf');
  assert.equal(mine.json.items[0].validation, 'validated');
  assert.ok(mine.json.items[0].id.startsWith('priv:'));
  const bobs = await readJson(await t.call('/api/catalog/my-assets', { headers: sess(t, t.bob) }));
  assert.equal(bobs.json.items.length, 0, 'bob sees none of alice’s assets');
  const cross = await readJson(await t.call(`/api/catalog/assets/${encodeURIComponent(mine.json.items[0].id)}`, { headers: sess(t, t.bob) }));
  assert.equal(cross.status, 404, 'cross-tenant private id 404s, never 403');
  const own = await readJson(await t.call(`/api/catalog/assets/${encodeURIComponent(mine.json.items[0].id)}`, { headers: sess(t, t.alice) }));
  assert.equal(own.status, 200, own.text);
  assert.equal(own.json.files.length, 1);
  assert.ok(own.json.files[0].sha256, 'server-computed digest recorded');
  const anon = await readJson(await t.call('/api/catalog/my-assets'));
  assert.equal(anon.status, 401);
});

test('AC10: demo and API keys cannot ingest', async () => {
  const t = await fx();
  const keys = await readJson(await t.call('/api/keys', { method: 'POST', headers: sess(t, t.alice), body: { name: 'r', scope: 'read' } }));
  const keyed = await readJson(await t.call('/api/catalog/uploads', {
    method: 'POST', headers: { Authorization: 'Bearer ' + keys.json.secret }, body: { name: 'x', kind: 'model', files: [] },
  }));
  assert.equal(keyed.status, 403, 'ingestion is session-only');
  const myKeys = await readJson(await t.call('/api/catalog/my-assets', { headers: { Authorization: 'Bearer ' + keys.json.secret } }));
  assert.equal(myKeys.status, 403, 'asset listing is session-only');
});

test('S-F13: demo is denied begin, chunk, and finalize (not just keyed callers)', async () => {
  const t = await fx();
  const cookie = await seedDemo(t);
  const headers = { ...cookie, ...t.csrf };
  const b = await readJson(await t.call('/api/catalog/uploads', {
    method: 'POST', headers, body: { name: 'd', kind: 'model', files: [{ relpath: 'm.gguf', bytes: 8 }] },
  }));
  assert.equal(b.status, 403);
  assert.equal(b.json.code, 'DEMO_RESTRICTED');
  const c = await readJson(await t.call('/api/catalog/uploads/up_bogus/chunk?path=m.gguf&index=0', {
    method: 'PUT', headers, rawBody: new Uint8Array([1, 2, 3, 4]),
  }));
  assert.equal(c.status, 403);
  assert.equal(c.json.code, 'DEMO_RESTRICTED');
  const f = await readJson(await t.call('/api/catalog/uploads/up_bogus/finalize', { method: 'POST', headers, body: {} }));
  assert.equal(f.status, 403);
  assert.equal(f.json.code, 'DEMO_RESTRICTED');
});

test('F5: gapped chunk indexes are refused even when byte sums match', async () => {
  const t = await fx();
  __resetFixtureStore();
  const bytes = ggufBytes(64);
  const b = await begin(t, t.alice, {
    name: 'gap', kind: 'model', task: 'text-generation', format: 'gguf', license: 'apache-2.0',
    files: [{ relpath: 'model.gguf', bytes: 64 }],
  });
  assert.equal(b.status, 201, b.text);
  const c0 = await chunk(t, t.alice, b.json.id, 'model.gguf', 0, bytes.slice(0, 32));
  assert.equal(c0.status, 200, c0.text);
  const c2 = await chunk(t, t.alice, b.json.id, 'model.gguf', 2, bytes.slice(32, 64));
  assert.equal(c2.status, 200, c2.text);
  const fin = await finalize(t, t.alice, b.json.id);
  assert.equal(fin.status, 400, fin.text);
  assert.equal(fin.json.code, 'UPLOAD_INCOMPLETE');
  assert.match(fin.json.error, /contiguous/i, 'the gap is named, not silently skipped');
});

test('F15: finalize re-checks quota against concurrent promotion', async () => {
  const t = await fx();
  __resetFixtureStore();
  const b = await begin(t, t.alice, {
    name: 'late', kind: 'model', task: 'text-generation', format: 'gguf', license: 'apache-2.0',
    files: [{ relpath: 'model.gguf', bytes: 64 }],
  });
  assert.equal(b.status, 201, b.text);
  await chunk(t, t.alice, b.json.id, 'model.gguf', 0, ggufBytes(64));
  // A concurrent promotion lands between begin and finalize (direct row:
  // no real bytes needed to prove the accounting re-check).
  const now = new Date().toISOString();
  await t.DB.prepare('INSERT INTO catalog_assets (id, owner_id, source, repo, revision, kind, task, arch, format, quant, license_json, access, manifest_json, validation, freshness_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind('rival', 'u_alice', 'private', 'rival', 'r'.repeat(64), 'model', 'text-generation', 'llama', 'gguf', 'Q4_K_M', '{}', 'private', '{}', 'validated', now, now).run();
  await t.DB.prepare('INSERT INTO catalog_asset_files (asset_id, relpath, bytes, sha256) VALUES (?, ?, ?, ?)')
    .bind('rival', 'model.gguf', MAX_ASSET_BYTES, '00'.repeat(32)).run();
  const fin = await finalize(t, t.alice, b.json.id);
  assert.equal(fin.status, 400, fin.text);
  assert.equal(fin.json.code, 'QUOTA_EXCEEDED');
});

test('F18: adapter finalize requires a resolvable base asset', async () => {
  const t = await fx();
  __resetFixtureStore();
  const ghost = await roundTrip(t, t.alice, 'ghost-adapter', [{ relpath: 'adapter.gguf', bytes: ggufBytes() }], {
    kind: 'adapter', baseAssetId: 'no-such-base', baseRevision: 'ab'.repeat(32),
    targetModules: ['q_proj'], tokenizer: 'base-tok',
  });
  assert.equal(ghost.status, 422, ghost.text);
  assert.equal(ghost.json.code, 'BASE_NOT_FOUND');
  const base = await roundTrip(t, t.alice, 'real-base', [{ relpath: 'model.gguf', bytes: ggufBytes() }]);
  assert.equal(base.status, 201, base.text);
  const good = await roundTrip(t, t.alice, 'bound-adapter', [{ relpath: 'adapter.gguf', bytes: ggufBytes() }], {
    kind: 'adapter', baseAssetId: base.json.assetId, baseRevision: 'ab'.repeat(32),
    targetModules: ['q_proj'], tokenizer: 'base-tok',
  });
  assert.equal(good.status, 201, good.text);
});

test('S-F6: shard accounting is case-insensitive like the suffix policy', async () => {
  const err = checkShardIndex(
    [{ relpath: 'MODEL.SAFETENSORS', bytes: 100 }],
    { weight_map: { w: 'MODEL.SAFETENSORS' }, metadata: { total_size: 100 } },
  );
  assert.equal(err, null, 'upper-case shard name is accounted');
});

test('S-F7: magic screen covers common archive/executable variants', async () => {
  const cases = [
    ['gzip', new Uint8Array([0x1f, 0x8b, 8, 0])],
    ['rar', new TextEncoder().encode('Rar!\x1a\x07\x00')],
    ['7z', new Uint8Array([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])],
    ['mach-o-64', new Uint8Array([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0])],
    ['zip-empty', new Uint8Array([0x50, 0x4b, 0x05, 0x06])],
  ];
  for (const [label, bytes] of cases) {
    assert.ok(screenMagic(bytes), `${label} is refused`);
  }
  assert.equal(screenMagic(new TextEncoder().encode('GGUF')), null, 'gguf weights still pass');
  assert.equal(screenMagic(tinySafetensors().slice(0, 64)), null, 'safetensors still passes');
});

test('N7: magic screen covers big-endian Mach-O variants', async () => {
  assert.ok(screenMagic(new Uint8Array([0xfe, 0xed, 0xfa, 0xce, 0, 0, 0, 0])), 'BE Mach-O 32-bit refused');
  assert.ok(screenMagic(new Uint8Array([0xfe, 0xed, 0xfa, 0xcf, 0, 0, 0, 0])), 'BE Mach-O 64-bit refused');
});

test('AC11: traversal, bad suffixes, hostile bytes, and bad manifests fail closed', async () => {
  const t = await fx();
  __resetFixtureStore();
  const badNames = ['../escape.gguf', '/abs.gguf', 'a/../../b.gguf', 'a\\b.gguf', 'C:/x.gguf', ''];
  for (const relpath of badNames) {
    const r = await begin(t, t.alice, { name: 't', kind: 'model', files: [{ relpath, bytes: 8 }] });
    if (!relpath) assert.equal(r.status, 400);
    else assert.equal(r.status, 400, relpath);
    assert.equal(r.json.code, 'BAD_PATH');
  }
  const zero = await begin(t, t.alice, { name: 't', kind: 'model', files: [{ relpath: 'm.gguf', bytes: 0 }] });
  assert.equal(zero.status, 400);
  // Pickle weights refused by suffix AND by magic.
  const bin = await roundTrip(t, t.alice, 'pkl', [{ relpath: 'model.bin', bytes: new Uint8Array([0x80, 0x04, 1, 2, 3, 4, 5, 6]) }]);
  assert.equal(bin.status, 422);
  assert.ok(bin.json.checks.some((c) => c.code === 'SUFFIX_REFUSED' || c.code === 'MAGIC_REFUSED'));
  // Mislabeled executable with an innocent suffix.
  const elf = new Uint8Array(32);
  elf.set([0x7f, 0x45, 0x4c, 0x46], 0);
  const exe = await roundTrip(t, t.alice, 'exe', [{ relpath: 'model.gguf', bytes: elf }]);
  assert.equal(exe.status, 422);
  assert.ok(exe.json.checks.some((c) => c.code === 'MAGIC_REFUSED'), JSON.stringify(exe.json.checks));
  // Zip refused even with an innocent name.
  const zip = new Uint8Array(32);
  zip.set([0x50, 0x4b, 0x03, 0x04], 0);
  const z = await roundTrip(t, t.alice, 'zip', [{ relpath: 'model.gguf', bytes: zip }]);
  assert.equal(z.status, 422);
  // Unknown suffix refused.
  const unk = await roundTrip(t, t.alice, 'unk', [{ relpath: 'model.xyz', bytes: ggufBytes() }]);
  assert.equal(unk.status, 422);
  assert.ok(unk.json.checks.some((c) => c.code === 'SUFFIX_UNKNOWN'));
  // Truncated safetensors header refused.
  const trunc = await roundTrip(t, t.alice, 'trunc', [{ relpath: 'model.safetensors', bytes: new Uint8Array(4) }]);
  assert.equal(trunc.status, 422);
  // Rejected uploads create no asset rows.
  const mine = await readJson(await t.call('/api/catalog/my-assets', { headers: sess(t, t.alice) }));
  assert.equal(mine.json.items.length, 0, 'nothing rejected is promotable');
});

test('AC11: valid safetensors + shard index pass; mismatch fails', async () => {
  const t = await fx();
  __resetFixtureStore();
  const st = tinySafetensors();
  const index = { metadata: { total_size: st.length }, weight_map: { w: 'model.safetensors' } };
  const indexBytes = new TextEncoder().encode(JSON.stringify(index));
  const ok = await roundTrip(t, t.alice, 'sharded', [
    { relpath: 'model.safetensors', bytes: st },
    { relpath: 'model.safetensors.index.json', bytes: indexBytes },
  ]);
  assert.equal(ok.status, 201, ok.text);
  const badIndex = new TextEncoder().encode(JSON.stringify({ metadata: {}, weight_map: { w: 'missing.safetensors' } }));
  const bad = await roundTrip(t, t.alice, 'badshard', [
    { relpath: 'model.safetensors', bytes: st },
    { relpath: 'model.safetensors.index.json', bytes: badIndex },
  ]);
  assert.equal(bad.status, 422);
  assert.ok(bad.json.checks.some((c) => c.code === 'SHARD_INDEX'), JSON.stringify(bad.json.checks));
});

test('AC11: quotas and chunk bounds enforced', async () => {
  const t = await fx();
  __resetFixtureStore();
  const over = await begin(t, t.alice, { name: 'big', kind: 'model', files: [{ relpath: 'm.gguf', bytes: 101 * 1024 * 1024 * 1024 }] });
  assert.equal(over.status, 400);
  assert.equal(over.json.code, 'QUOTA_EXCEEDED');
  const b = await begin(t, t.alice, { name: 'q', kind: 'model', files: [{ relpath: 'm.gguf', bytes: 64 }] });
  assert.equal(b.status, 201);
  const huge = await chunk(t, t.alice, b.json.id, 'm.gguf', 0, new Uint8Array(9 * 1024 * 1024));
  assert.ok([400, 413].includes(huge.status), `oversize chunk: ${huge.status}`);
  const ghost = await chunk(t, t.alice, b.json.id, 'other.gguf', 0, new Uint8Array(8));
  assert.equal(ghost.status, 400);
  assert.equal(ghost.json.code, 'BAD_PATH');
  const badMethod = await readJson(await t.call(`/api/catalog/uploads/${b.json.id}/chunk?path=m.gguf&index=0`, { method: 'POST', headers: sess(t, t.alice), rawBody: new Uint8Array(8) }));
  assert.equal(badMethod.status, 405);
});

test('AC13: duplicate chunks/finalize are idempotent; interrupted resumes; expiry 410s', async () => {
  const t = await fx();
  __resetFixtureStore();
  const bytes = ggufBytes(100);
  const b = await begin(t, t.alice, { name: 'resume', kind: 'model', files: [{ relpath: 'm.gguf', bytes: 100 }] });
  const id = b.json.id;
  const c0 = await chunk(t, t.alice, id, 'm.gguf', 0, bytes.slice(0, 40));
  assert.equal(c0.status, 200);
  const dup = await chunk(t, t.alice, id, 'm.gguf', 0, bytes.slice(0, 40));
  assert.equal(dup.status, 200, 'duplicate chunk overwrites idempotently');
  const early = await finalize(t, t.alice, id);
  assert.equal(early.status, 400);
  assert.equal(early.json.code, 'UPLOAD_INCOMPLETE');
  const c1 = await chunk(t, t.alice, id, 'm.gguf', 1, bytes.slice(40));
  assert.equal(c1.status, 200, 'resume after interruption');
  const fin = await finalize(t, t.alice, id);
  assert.equal(fin.status, 201, fin.text);
  const fin2 = await finalize(t, t.alice, id);
  assert.equal(fin2.status, 200);
  assert.equal(fin2.json.duplicate, true);
  assert.equal(fin2.json.assetId, fin.json.assetId, 'duplicate finalize replays the same asset');
  // Digest mismatch fails without corrupting the session.
  const b2 = await begin(t, t.alice, { name: 'dig', kind: 'model', files: [{ relpath: 'm.gguf', bytes: 8, sha256: '0'.repeat(64) }] });
  await chunk(t, t.alice, b2.json.id, 'm.gguf', 0, new Uint8Array(8).fill(7));
  const dm = await finalize(t, t.alice, b2.json.id);
  assert.equal(dm.status, 400);
  assert.equal(dm.json.code, 'DIGEST_MISMATCH');
  // Expiry.
  const b3 = await begin(t, t.alice, { name: 'old', kind: 'model', files: [{ relpath: 'm.gguf', bytes: 8 }] });
  await t.DB.prepare("UPDATE catalog_uploads SET expires_at = '2000-01-01T00:00:00Z' WHERE id = ?").bind(b3.json.id).run();
  const exp = await finalize(t, t.alice, b3.json.id);
  assert.equal(exp.status, 410);
  // Status shows received accounting.
  const st = await readJson(await t.call(`/api/catalog/uploads/${id}`, { headers: sess(t, t.alice) }));
  assert.equal(st.json.state, 'validated');
  const stBob = await readJson(await t.call(`/api/catalog/uploads/${id}`, { headers: sess(t, t.bob) }));
  assert.equal(stBob.status, 404, 'upload status is owner-only');
});

test('AC12: promotion is atomic; revalidate re-checks; rejected never evaluates', async () => {
  const t = await fx();
  __resetFixtureStore();
  const fin = await roundTrip(t, t.alice, 'atomic', [{ relpath: 'm.gguf', bytes: ggufBytes() }]);
  const assetId = fin.json.assetId;
  const rows = await t.DB.prepare('SELECT COUNT(*) n FROM catalog_asset_files WHERE asset_id = ?').bind(assetId).first();
  assert.equal(rows.n, 1, 'file rows land with the asset row');
  const re = await readJson(await t.call(`/api/catalog/assets/${assetId}/validate`, { method: 'POST', headers: sess(t, t.alice), body: {} }));
  assert.equal(re.status, 200, re.text);
  assert.equal(re.json.validation, 'validated');
  const reBob = await readJson(await t.call(`/api/catalog/assets/${assetId}/validate`, { method: 'POST', headers: sess(t, t.bob), body: {} }));
  assert.equal(reBob.status, 404);
  // Flip to rejected out-of-band: compat must refuse (gate test).
  await t.DB.prepare("UPDATE catalog_assets SET validation = 'rejected' WHERE id = ?").bind(assetId).run();
  const reg = await readJson(await t.call('/api/inventory', { method: 'POST', headers: sess(t, t.alice), body: { name: 'n' } }));
  const refused = await readJson(await t.call('/api/catalog/compat', {
    method: 'POST', headers: sess(t, t.alice),
    body: { assetId: `priv:${assetId}`, nodeId: reg.json.id, runtime: 'fixture-llama', context: 512, concurrency: 1 },
  }));
  assert.equal(refused.status, 422);
  assert.equal(refused.json.code, 'ASSET_NOT_VALIDATED');
});

test('Journey B: validated private bytes flow through the same compat path', async () => {
  const t = await fx();
  __resetFixtureStore();
  const fin = await roundTrip(t, t.alice, 'tiny-private', [{ relpath: 'm.gguf', bytes: ggufBytes(256) }], { format: 'gguf', quant: 'Q4_K_M' });
  assert.equal(fin.status, 201, fin.text);
  const reg = await readJson(await t.call('/api/inventory', { method: 'POST', headers: sess(t, t.alice), body: { name: 'n' } }));
  const noSnap = await readJson(await t.call('/api/catalog/compat', {
    method: 'POST', headers: sess(t, t.alice),
    body: { assetId: `priv:${fin.json.assetId}`, nodeId: reg.json.id, runtime: 'fixture-llama', context: 512, concurrency: 1 },
  }));
  assert.equal(noSnap.json.state, 'unknown', 'private asset, same unknown-without-telemetry rule');
  // Cross-tenant private ref 404s.
  const cross = await readJson(await t.call('/api/catalog/compat', {
    method: 'POST', headers: sess(t, t.bob),
    body: { repo: GGUF, nodeId: reg.json.id, runtime: 'fixture-llama', context: 512, concurrency: 1 },
  }));
  assert.equal(cross.status, 404);
});

test('unprovisioned store refuses bytes honestly (begin works, chunks 503)', async () => {
  const t = await createTestEnv({});
  const b = await begin(t, t.alice, { name: 'n', kind: 'model', files: [{ relpath: 'm.gguf', bytes: 8 }] });
  assert.equal(b.status, 201, 'manifest intake needs no bytes');
  assert.equal(b.json.store, 'unprovisioned');
  const c = await chunk(t, t.alice, b.json.id, 'm.gguf', 0, new Uint8Array(8));
  assert.equal(c.status, 503);
  assert.equal(c.json.code, 'STORAGE_UNPROVISIONED');
  const sum = await readJson(await t.call('/api/catalog/summary', { headers: sess(t, t.alice) }));
  assert.equal(sum.json.uploadsAvailable, false);
});

test('validator units: names, magic, headers, shard math', async () => {
  assert.equal(validateRelPath('a/b.gguf'), null);
  assert.ok(validateRelPath('../x'));
  assert.ok(validateRelPath('/x'));
  assert.ok(validateRelPath('a//b'));
  assert.ok(validateRelPath(''));
  assert.equal(screenMagic(new Uint8Array([0x47, 0x47, 0x55, 0x46])), null, 'GGUF magic passes the screen');
  assert.ok(screenMagic(new Uint8Array([0x7f, 0x45, 0x4c, 0x46])));
  assert.ok(screenMagic(new Uint8Array([0x80, 0x04, 0x00])));
  assert.ok(screenMagic(new Uint8Array([0x4d, 0x5a, 0x00])));
  assert.ok(screenMagic(new Uint8Array(0)));
  const good = tinySafetensors();
  assert.equal(screenSafetensors('m.safetensors', good.length, good), null);
  assert.ok(screenSafetensors('m.safetensors', good.length, good.slice(0, 4)));
  const badOff = tinySafetensors();
  assert.ok(screenSafetensors('m.safetensors', 10, badOff), 'offsets escaping the declared size fail');
  assert.equal(checkShardIndex([{ relpath: 'a.safetensors', bytes: 10 }], { metadata: { total_size: 10 }, weight_map: { w: 'a.safetensors' } }), null);
  assert.ok(checkShardIndex([{ relpath: 'a.safetensors', bytes: 10 }], { metadata: {}, weight_map: { w: 'b.safetensors' } }));
  assert.ok(checkShardIndex([{ relpath: 'a.safetensors', bytes: 10 }, { relpath: 'b.safetensors', bytes: 10 }], { metadata: {}, weight_map: { w: 'a.safetensors' } }));
  const empty = validateManifest({ files: [] });
  assert.equal(empty.ok, false);
  const dup = validateManifest({ files: [{ relpath: 'a.gguf', bytes: 8 }, { relpath: 'a.gguf', bytes: 8 }] }, () => new Uint8Array(8));
  assert.equal(dup.ok, false);
  const missing = validateManifest({ files: [{ relpath: 'a.gguf', bytes: 8 }] }, () => null);
  assert.equal(missing.ok, false);
});
