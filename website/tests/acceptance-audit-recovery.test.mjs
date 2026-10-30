import { test } from 'node:test';
import assert from 'node:assert/strict';
import { faultOnce } from './revision-fixtures.mjs';
import { fabricEnv } from './qa-helpers.mjs';
import * as core from '../src/fabric/store.mjs';

// Codex P2 on #29 23ce159 (store.mjs:313): an acceptance whose batch
// committed while its audit insert failed must be repaired on retry.
test('a retried acceptance repairs a missing audit row exactly once', async (c) => {
  const t = await fabricEnv(); c.after(() => t.sqlite.close());
  const alice = { kind: 'session', user: { id: 'u_alice' } }, bob = { kind: 'session', user: { id: 'u_bob' } };
  const a = (await core.registerNode(t.DB, alice, { label: 'a' })).body;
  const b = (await core.registerNode(t.DB, bob, { label: 'b' })).body;
  const inv = (await core.createInvitation(t.DB, alice, { issuerNode: a.id, recipientNode: b.id, recipientWorkspace: 'default' })).body;
  const input = { token: inv.token, nodeId: b.id, nodeKey: b.nodeSecret };
  const op = { key: 'accept-original', path: '/v1/fabric/invitations/accept' };
  const audits = async () => (await t.DB.prepare("SELECT * FROM audit WHERE action = 'fabric.invitation.accept'").all()).results;
  const faulty = faultOnce(t.DB, /INTO audit/, 'before');
  await assert.rejects(core.acceptInvitation(faulty, bob, input, op));
  assert.equal((await audits()).length, 0, 'the fault really dropped the audit');
  const retry = await core.acceptInvitation(t.DB, bob, input, op);
  assert.ok([200, 201].includes(retry.status), JSON.stringify(retry.body));
  assert.equal((await audits()).length, 1, 'retry repaired the missing audit');
  const again = await core.acceptInvitation(t.DB, bob, input, { key: 'accept-other', path: op.path });
  assert.ok([200, 201].includes(again.status), JSON.stringify(again.body));
  assert.equal((await audits()).length, 1, 'later retries never duplicate it');
});
