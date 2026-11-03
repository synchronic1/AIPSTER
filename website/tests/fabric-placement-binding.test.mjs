// FABRIC lane: placement/binding validation. Offline fakes only — no D1,
// no network, no inference, no admission. Proves the pure selector refuses
// bad bindings explicitly and never falls back, grants, or dispatches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePlacementBinding, selectPlacement } from '../src/inference/placement-binding.mjs';

const NOW = 1_791_000_000_000;
const owned = (over = {}) => ({
  resourceId: 'res-01',
  ownerId: 'tenant-a',
  kind: 'local',
  modelCompat: 'unverified',
  exactTokenMatch: false,
  caps: [],
  liveness: 'online',
  lastSeenAgeMs: 10_000,
  usable: true,
  capacity: null,
  via: { owned: true },
  ...over,
});
const req = (over = {}) => ({ tenantId: 'tenant-a', ...over });

// ---- validatePlacementBinding ----

test('accepts a fresh cpu/ganglion binding and labels compat unverified', () => {
  const r = validatePlacementBinding(
    { device: 'cpu', nodeId: 'res-01', runtimeId: 'ganglion', modelId: 'm1' },
    { liveness: 'online', lastSeenAgeMs: 10_000, usable: true, tenantMatch: true });
  assert.equal(r.ok, true);
  assert.equal(r.value.device, 'cpu');
  assert.equal(r.value.evidence.modelCompat, 'unverified');
});

test('rejects gpu without silent fallback to cpu', () => {
  for (const device of ['gpu', 'cuda', 'auto', undefined]) {
    const r = validatePlacementBinding({ device, nodeId: 'res-01', runtimeId: 'ganglion' },
      { liveness: 'online', usable: true, tenantMatch: true });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'DEVICE_UNSUPPORTED');
    assert.equal(r.http, 400);
    assert.ok(!('value' in r) || r.value === undefined);
  }
});

test('rejects runtimes outside ganglion/llama-server', () => {
  const r = validatePlacementBinding({ device: 'cpu', nodeId: 'res-01', runtimeId: 'cuda-rt' },
    { liveness: 'online', usable: true, tenantMatch: true });
  assert.equal(r.code, 'RUNTIME_UNSUPPORTED');
  const ok = validatePlacementBinding({ device: 'cpu', nodeId: 'res-01', runtimeId: 'llama-server' },
    { liveness: 'online', usable: true, tenantMatch: true });
  assert.equal(ok.ok, true);
});

test('rejects malformed ids and non-object shapes', () => {
  assert.equal(validatePlacementBinding(null, {}).code, 'INVALID_BINDING_SHAPE');
  assert.equal(validatePlacementBinding({ device: 'cpu', nodeId: '', runtimeId: 'ganglion' },
    { liveness: 'online', usable: true, tenantMatch: true }).code, 'INVALID_BINDING_ID');
});

test('fails closed on missing tenant evidence', () => {
  const r = validatePlacementBinding({ device: 'cpu', nodeId: 'res-01', runtimeId: 'ganglion' },
    { liveness: 'online', usable: true });
  assert.equal(r.code, 'TENANT_MISMATCH');
  assert.equal(r.http, 403);
});

test('rejects stale, offline, unknown, and unusable bindings', () => {
  const bind = { device: 'cpu', nodeId: 'res-01', runtimeId: 'ganglion' };
  const ev = { usable: true, tenantMatch: true };
  assert.equal(validatePlacementBinding(bind, { ...ev, liveness: 'stale' }).code, 'STALE_BINDING');
  assert.equal(validatePlacementBinding(bind, { ...ev, liveness: 'offline' }).code, 'UNREACHABLE_BINDING');
  assert.equal(validatePlacementBinding(bind, { ...ev, liveness: 'unknown' }).code, 'UNREACHABLE_BINDING');
  assert.equal(validatePlacementBinding(bind, { ...ev, liveness: 'online', usable: false }).code, 'RESOURCE_NOT_USABLE');
});

test('treats an online label older than the freshness window as stale', () => {
  const r = validatePlacementBinding({ device: 'cpu', nodeId: 'res-01', runtimeId: 'ganglion' },
    { liveness: 'online', lastSeenAgeMs: 60 * 60 * 1000, usable: true, tenantMatch: true });
  assert.equal(r.code, 'STALE_BINDING');
});

// ---- selectPlacement ----

test('selects the best candidate deterministically with exact exclusion reasons', () => {
  const cands = [
    owned({ resourceId: 'res-02' }),
    owned({ resourceId: 'res-01', exactTokenMatch: true }),
    owned({ resourceId: 'res-03', liveness: 'stale' }),
    owned({ resourceId: 'res-04', liveness: 'offline' }),
    owned({ resourceId: 'res-05', usable: false }),
    { resourceId: 'res-06', ownerId: 'tenant-b', kind: 'local', liveness: 'online', usable: true, via: { owned: true } },
  ];
  const a = selectPlacement(cands, req({ model: 'm1' }), { nowMs: NOW });
  const b = selectPlacement(cands, req({ model: 'm1' }), { nowMs: NOW });
  assert.deepEqual(a, b);
  assert.equal(a.code, 'SELECTED');
  assert.equal(a.selected.resourceId, 'res-01');
  assert.equal(a.selected.binding.device, 'cpu');
  assert.equal(a.selected.binding.runtimeId, 'ganglion');
  assert.equal(a.selected.evidence.modelCompat, 'unverified');
  assert.equal(a.receipt.executable, false);
  const reasons = Object.fromEntries(a.excluded.map((e) => [e.resourceId, e.reason]));
  assert.equal(reasons['res-03'], 'STALE_TELEMETRY');
  assert.equal(reasons['res-04'], 'UNREACHABLE');
  assert.equal(reasons['res-05'], 'NOT_USABLE');
  assert.equal(reasons['res-06'], 'TENANT_MISMATCH');
});

test('does not exclude on model-token mismatch; exact match only scores', () => {
  const a = selectPlacement([owned({ resourceId: 'res-01', exactTokenMatch: false })], req({ model: 'other' }), { nowMs: NOW });
  assert.equal(a.code, 'SELECTED');
  assert.equal(a.selected.evidence.modelCompat, 'unverified');
});

test('granted rows are not tenant-refused; quota shortfall excludes exactly', () => {
  const granted = (over = {}) => ({
    resourceId: 'res-g', ownerId: 'owner-z', kind: 'cluster', modelCompat: 'unverified',
    exactTokenMatch: false, caps: [], liveness: 'online', lastSeenAgeMs: 5_000, usable: true,
    capacity: { jobsRemaining: 3, tokensRemaining: 100 }, via: { grantId: 'grant-1' }, ...over,
  });
  const ok = selectPlacement([granted()], req({ maxTokens: 64 }), { nowMs: NOW });
  assert.equal(ok.code, 'SELECTED');
  const short = selectPlacement([granted()], req({ maxTokens: 200 }), { nowMs: NOW });
  assert.equal(short.code, 'NO_ELIGIBLE_NODE');
  assert.deepEqual(short.excluded, [{ resourceId: 'res-g', reason: 'CAPACITY_INSUFFICIENT' }]);
});

test('gpu device selects nothing and never falls back', () => {
  const r = selectPlacement([owned()], req({ device: 'gpu' }), { nowMs: NOW });
  assert.equal(r.code, 'DEVICE_UNSUPPORTED');
  assert.equal(r.selected, null);
  assert.ok(r.excluded.length === 1 && r.excluded[0].reason === 'DEVICE_UNSUPPORTED');
});

test('unknown runtime and passed deadline select nothing and hold nothing', () => {
  const badRt = selectPlacement([owned()], req({ runtimeId: 'cuda-rt' }), { nowMs: NOW });
  assert.equal(badRt.code, 'RUNTIME_UNSUPPORTED');
  assert.equal(badRt.selected, null);
  const late = selectPlacement([owned()], req({ deadlineMs: NOW - 1 }), { nowMs: NOW });
  assert.equal(late.code, 'DEADLINE_EXCEEDED');
  assert.equal(late.selected, null);
  // Pure: repeating the expired call changes no state and returns the same refusal.
  assert.deepEqual(late, selectPlacement([owned()], req({ deadlineMs: NOW - 1 }), { nowMs: NOW }));
});

test('empty and fully-excluded sets report NO_ELIGIBLE_NODE', () => {
  assert.equal(selectPlacement([], req(), { nowMs: NOW }).code, 'NO_ELIGIBLE_NODE');
  const r = selectPlacement([owned({ liveness: 'unknown' }), null], req(), { nowMs: NOW });
  assert.equal(r.code, 'NO_ELIGIBLE_NODE');
  assert.deepEqual(r.excluded.map((e) => e.reason).sort(), ['MALFORMED_ROW', 'UNREACHABLE']);
});

test('tie-break is resourceId order and caller contract violations throw', () => {
  const r = selectPlacement([owned({ resourceId: 'res-b' }), owned({ resourceId: 'res-a' })], req(), { nowMs: NOW });
  assert.equal(r.selected.resourceId, 'res-a');
  assert.throws(() => selectPlacement([owned()], {}), /tenantId/);
  assert.throws(() => selectPlacement('nope', req()), /array/);
  assert.throws(() => selectPlacement([owned()], req({ maxTokens: 5000 })), /maxTokens/);
});

// ---- REVIEW-FABRIC-1 regressions (permanent) ----

test('via-less rows fail closed even when claiming the requester tenant', () => {
  for (const ownerId of ['tenant-b', 'tenant-a']) {
    const row = { ...owned({ resourceId: 'res-x', ownerId }) };
    delete row.via;
    const r = selectPlacement([row], req(), { nowMs: NOW });
    assert.equal(r.code, 'NO_ELIGIBLE_NODE');
    assert.equal(r.selected, null);
    assert.deepEqual(r.excluded, [{ resourceId: 'res-x', reason: 'MALFORMED_ROW' }]);
  }
});

test('unrecognized via provenance is refused, valid grant refs still pass', () => {
  for (const via of [{}, { owned: false }, { owned: 'yes' }]) {
    const r = selectPlacement([owned({ resourceId: 'res-x', via })], req(), { nowMs: NOW });
    assert.equal(r.code, 'NO_ELIGIBLE_NODE');
    assert.deepEqual(r.excluded, [{ resourceId: 'res-x', reason: 'UNKNOWN_PROVENANCE' }]);
  }
  const nullVia = selectPlacement([owned({ resourceId: 'res-x', via: null })], req(), { nowMs: NOW });
  assert.deepEqual(nullVia.excluded, [{ resourceId: 'res-x', reason: 'MALFORMED_ROW' }]);
  for (const via of [{ grantId: '' }, { grantId: 42 }]) {
    const r = selectPlacement([owned({ resourceId: 'res-x', via })], req(), { nowMs: NOW });
    assert.equal(r.code, 'NO_ELIGIBLE_NODE');
    assert.deepEqual(r.excluded, [{ resourceId: 'res-x', reason: 'MALFORMED_ROW' }]);
  }
  const ok = selectPlacement([owned({ resourceId: 'res-x', ownerId: 'owner-z', via: { grantId: 'grant-1' } })],
    req(), { nowMs: NOW });
  assert.equal(ok.code, 'SELECTED');
  assert.equal(ok.selected.resourceId, 'res-x');
});

test('non-finite heartbeat ages never produce non-finite scores or quietly-ready state', () => {
  for (const age of [NaN, Infinity, -Infinity, 'recent', undefined]) {
    const r = selectPlacement([owned({ lastSeenAgeMs: age })], req(), { nowMs: NOW });
    assert.equal(r.code, 'SELECTED');
    assert.ok(Number.isFinite(r.selected.score), `score must be finite for age ${String(age)}`);
    assert.ok(JSON.stringify(r.selected.score) !== 'null');
    const fresh = r.selected.contributions.find((c) => c.feature === 'freshness');
    assert.equal(fresh.points, 0);
    assert.ok(Number.isFinite(fresh.points));
    assert.equal(r.selected.evidence.lastSeenAgeMs, null);
  }
});

test('future heartbeat ages clamp to just-now and never exceed the freshness bound', () => {
  const r = selectPlacement([owned({ lastSeenAgeMs: -3_600_000 })], req(), { nowMs: NOW });
  assert.equal(r.code, 'SELECTED');
  const fresh = r.selected.contributions.find((c) => c.feature === 'freshness');
  assert.ok(Number.isFinite(fresh.points));
  assert.ok(fresh.points >= 0 && fresh.points <= 20, `freshness ${fresh.points} outside 0..20`);
  assert.equal(fresh.points, 20);
  assert.equal(r.selected.evidence.lastSeenAgeMs, 0);
});

test('malformed deadlineMs throws; past instants select nothing', () => {
  for (const bad of ['tomorrow', 1.5, NaN, true, '123', {}, []]) {
    assert.throws(() => selectPlacement([owned()], req({ deadlineMs: bad }), { nowMs: NOW }),
      /deadline/, `deadlineMs=${String(bad)} silently ignored`);
  }
  for (const past of [0, -1, NOW, NOW - 1]) {
    const r = selectPlacement([owned()], req({ deadlineMs: past }), { nowMs: NOW });
    assert.equal(r.code, 'DEADLINE_EXCEEDED');
    assert.equal(r.selected, null);
  }
  assert.equal(selectPlacement([owned()], req({ deadlineMs: null }), { nowMs: NOW }).code, 'SELECTED');
  assert.equal(selectPlacement([owned()], req({ deadlineMs: NOW + 60_000 }), { nowMs: NOW }).code, 'SELECTED');
});

test('unknown binding keys are strictly rejected like the mirrored contract', () => {
  const ev = { liveness: 'online', usable: true, tenantMatch: true };
  const r = validatePlacementBinding(
    { device: 'cpu', nodeId: 'res-01', runtimeId: 'ganglion', admin: true }, ev);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'UNKNOWN_BINDING_FIELD');
  assert.equal(r.http, 400);
  assert.equal(validatePlacementBinding(
    { device: 'cpu', nodeId: 'res-01', runtimeId: 'ganglion', modelId: 'm1' }, ev).ok, true);
});

test('validate evidence normalizes invalid heartbeat ages instead of echoing them', () => {
  const bind = { device: 'cpu', nodeId: 'res-01', runtimeId: 'ganglion' };
  const ev = { liveness: 'online', usable: true, tenantMatch: true };
  assert.equal(validatePlacementBinding(bind, { ...ev, lastSeenAgeMs: NaN }).value.evidence.lastSeenAgeMs, null);
  assert.equal(validatePlacementBinding(bind, { ...ev, lastSeenAgeMs: -5_000 }).value.evidence.lastSeenAgeMs, 0);
});
