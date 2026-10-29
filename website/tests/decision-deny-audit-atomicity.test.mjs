import { test } from 'node:test';
import assert from 'node:assert/strict';
import { revisionFixture, faultOnce } from './revision-fixtures.mjs';
import * as core from '../src/fabric/store.mjs';
import { handleFabric } from '../src/fabric/router.mjs';

// Codex P2 findings on #29 21e2766: an approval decision or deny removal
// could commit while its audit insert (or the HTTP response) failed.

async function route(db, actor, method, path, body, key) {
  const url = new URL(path, 'https://synthetic.invalid');
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers['Idempotency-Key'] = key;
  const request = new Request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const response = await handleFabric({ db, actor, url, request, env: { FEDERATION_ENABLED: '1' },
    json: (status, data) => Response.json(data, { status }),
    needAuthz: () => null, needSession: () => null, needCsrf: () => null, needNotDemo: () => null });
  return { status: response.status, body: await response.json() };
}

for (const real of [false, true]) {
  const label = real ? 'local D1' : 'sqlite';

  test(`${label}: a failed decision audit leaves the approval undecided and the retry applies once`, async (c) => {
    const t = await revisionFixture(real); c.after(t.close);
    await core.pauseGrant(t.db, t.alice, t.grant, { expectedVersion: 1 });
    const appr = (await core.requestApproval(t.db, t.alice, { action: 'grant.resume', targetId: t.grant })).body;
    const path = `/v1/fabric/approvals/${appr.id}/decide`;
    const faulty = faultOnce(t.db, /INTO audit/, 'before', true);
    const first = await route(faulty, t.alice, 'POST', path, { decision: 'approve' }, 'decide-1');
    assert.equal(first.status, 500, JSON.stringify(first.body));
    const mid = await t.db.prepare('SELECT decision FROM approvals WHERE id = ?').bind(appr.id).first();
    assert.equal(mid.decision, 'requested', 'no decision without its audit evidence');
    const retry = await route(t.db, t.alice, 'POST', path, { decision: 'approve' }, 'decide-1');
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    assert.equal(retry.body.decision, 'approved');
    const audits = (await t.db.prepare("SELECT * FROM audit WHERE action = 'fabric.approval.approved' AND target = ?").bind(appr.id).all()).results;
    assert.equal(audits.length, 1);
  });

  test(`${label}: a lost decision response replays the applied decision, not ALREADY_DECIDED`, async (c) => {
    const t = await revisionFixture(real); c.after(t.close);
    await core.pauseGrant(t.db, t.alice, t.grant, { expectedVersion: 1 });
    const appr = (await core.requestApproval(t.db, t.alice, { action: 'grant.resume', targetId: t.grant })).body;
    const path = `/v1/fabric/approvals/${appr.id}/decide`;
    // The batch commits, then the response is lost before finalization.
    const lossy = faultOnce(t.db, /UPDATE approvals SET decision/, 'after', true);
    const lost = await route(lossy, t.alice, 'POST', path, { decision: 'approve' }, 'decide-2');
    assert.equal(lost.status, 500, JSON.stringify(lost.body));
    const retry = await route(t.db, t.alice, 'POST', path, { decision: 'approve' }, 'decide-2');
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    assert.equal(retry.body.decision, 'approved');
    // A different operation still sees the decision as already made.
    const other = await route(t.db, t.alice, 'POST', path, { decision: 'approve' }, 'decide-other');
    assert.equal(other.status, 409, JSON.stringify(other.body));
    assert.equal(other.body.code, 'ALREADY_DECIDED');
  });

  test(`${label}: a failed audit never removes a deny without evidence`, async (c) => {
    const t = await revisionFixture(real); c.after(t.close);
    const deny = (await core.createDeny(t.db, t.alice, { resourceId: 'r_gpu1', principal: 'bob-op', action: 'infer' })).body;
    assert.ok(deny.id);
    const faulty = faultOnce(t.db, /INTO audit/, 'before', true);
    const failed = await route(faulty, t.alice, 'DELETE', `/v1/fabric/denies/${deny.id}`);
    assert.equal(failed.status, 500, JSON.stringify(failed.body));
    const still = await t.db.prepare('SELECT id FROM fabric_denies WHERE id = ?').bind(deny.id).first();
    assert.ok(still, 'deny survives a failed audit');
    const ok = await route(t.db, t.alice, 'DELETE', `/v1/fabric/denies/${deny.id}`);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(await t.db.prepare('SELECT id FROM fabric_denies WHERE id = ?').bind(deny.id).first(), null);
    const audits = (await t.db.prepare("SELECT * FROM audit WHERE action = 'fabric.deny.delete' AND target = ?").bind(deny.id).all()).results;
    assert.equal(audits.length, 1, 'removal has exactly one audit row');
  });
}
