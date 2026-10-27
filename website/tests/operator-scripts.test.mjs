/* Built with Meta Muse. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createTestEnv } from './d1-shim.mjs';
import { disableUserStatements, sqlQuote } from '../scripts/lib/operator-sql.mjs';
import { promptPassword } from '../scripts/lib/prompt-password.mjs';

test('disable statements revoke access without touching classification', async () => {
  const t = await createTestEnv();
  const now = new Date().toISOString();
  await t.DB.prepare('INSERT INTO key_verifiers (id, owner_id, name, scope, salt, verifier, prefix, expires_at, metadata, created_at, last_used_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)')
    .bind('k_op1', 'u_alice', 'op', 'read', 's', 'v', 'aip_live_k_op1_x', null, '', now).run();
  const statements = disableUserStatements({ userId: 'u_alice', email: 'alice@example.com' });
  assert.equal(statements.length, 4);
  assert.ok(!/demo/i.test(statements.join(';')));
  for (const s of statements) await t.DB.prepare(s).run();
  const user = await t.DB.prepare('SELECT disabled FROM "user" WHERE id = ?').bind('u_alice').first();
  assert.equal(Number(user.disabled), 1);
  assert.equal((await t.DB.prepare('SELECT id FROM session WHERE userId = ?').bind('u_alice').all()).results.length, 0);
  const key = await t.DB.prepare('SELECT revoked_at FROM key_verifiers WHERE id = ?').bind('k_op1').first();
  assert.ok(key.revoked_at);
  assert.equal((await t.DB.prepare('SELECT email FROM allowlist WHERE email = ?').bind('alice@example.com').all()).results.length, 0);
});

test('disable statements quote identities and require a target', () => {
  assert.equal(sqlQuote("o'brien"), "'o''brien'");
  assert.throws(() => disableUserStatements({}), /userId/);
  const withCred = disableUserStatements({ userId: 'u_demo', deletePassword: true });
  assert.ok(withCred.some((s) => s.includes("providerId = 'credential'")));
  const withoutCred = disableUserStatements({ userId: 'u_demo' });
  assert.ok(!withoutCred.some((s) => s.includes('credential')));
});

function fakeStreams() {
  const input = new EventEmitter();
  input.isTTY = true;
  input.setRawMode = () => {};
  input.resume = () => {};
  input.pause = () => {};
  const output = { writes: [], write(s) { this.writes.push(String(s)); } };
  return { input, output };
}

test('hidden prompt masks input and supports backspace', async () => {
  const { input, output } = fakeStreams();
  const p = promptPassword('pw: ', { input, output });
  for (const ch of ['s', 'e', 'c', '\u007f', 'X', '\n']) input.emit('data', ch);
  assert.equal(await p, 'seX');
  const shown = output.writes.join('');
  assert.ok(shown.startsWith('pw: '));
  assert.ok(!shown.includes('seX') && !shown.includes('sec'), 'password never echoed');
  assert.ok(shown.includes('***'), 'keystrokes masked');
});

test('hidden prompt aborts on ctrl-C and refuses non-TTY', async () => {
  const a = fakeStreams();
  const p = promptPassword('pw: ', a);
  a.input.emit('data', '\u0003');
  await assert.rejects(p, /aborted/);
  const b = fakeStreams();
  b.input.isTTY = false;
  await assert.rejects(promptPassword('pw: ', b), /TTY/);
});
