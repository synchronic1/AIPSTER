/* Built with Meta Muse. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations } from './d1-shim.mjs';

test('migrations create the auth and app tables', () => {
  const sqlite = new DatabaseSync(':memory:');
  applyMigrations(sqlite);
  const names = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
  for (const t of ['user', 'session', 'account', 'verification', 'resources', 'grants', 'key_verifiers', 'jobs', 'usage', 'audit', 'allowlist']) {
    assert.ok(names.includes(t), `missing table ${t}`);
  }
  const cols = (t) => sqlite.prepare(`SELECT * FROM pragma_table_info(?)`).all(t).map((c) => c.name);
  for (const c of ['id', 'name', 'email', 'createdAt', 'updatedAt']) assert.ok(cols('user').includes(c), `user.${c}`);
  for (const c of ['id', 'token', 'expiresAt', 'userId']) assert.ok(cols('session').includes(c), `session.${c}`);
  assert.ok(cols('key_verifiers').includes('verifier'), 'key_verifiers.verifier');
  assert.ok(cols('allowlist').includes('email'), 'allowlist.email');
});

test('migrations are idempotent', () => {
  const sqlite = new DatabaseSync(':memory:');
  applyMigrations(sqlite);
  applyMigrations(sqlite); // must not throw
});
