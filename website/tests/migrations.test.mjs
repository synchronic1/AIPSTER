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
  assert.ok(cols('key_verifiers').includes('resource_id'), 'key_verifiers.resource_id (0013 heartbeat binding)');
  assert.ok(cols('allowlist').includes('email'), 'allowlist.email');
  assert.ok(names.includes('write_budget'), 'missing table write_budget');
  for (const c of ['user_id', 'window', 'count']) assert.ok(cols('write_budget').includes(c), `write_budget.${c}`);
});

test('migrations are idempotent where SQLite allows', () => {
  const sqlite = new DatabaseSync(':memory:');
  applyMigrations(sqlite);
  // 0001/0002 are re-runnable (IF NOT EXISTS). 0003's ALTER TABLE is
  // once-only by SQLite design; D1's migration journal enforces that, so the
  // test re-applies only the idempotent files and verifies 0003's effects.
  applyMigrations(sqlite, ['0001_better_auth.sql', '0002_app.sql']); // must not throw
  const cols = sqlite.prepare('SELECT * FROM pragma_table_info(?)').all('user').map((c) => c.name);
  for (const c of ['username', 'displayUsername', 'demo']) assert.ok(cols.includes(c), `user.${c}`);
  const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  assert.ok(tables.includes('rateLimit'), 'rateLimit table');
});
