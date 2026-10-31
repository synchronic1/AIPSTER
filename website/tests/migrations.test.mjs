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
  assert.ok(names.includes('pairing_codes'), 'missing table pairing_codes (0015)');
  for (const c of ['salt', 'verifier', 'expires_at', 'used_at', 'attempts', 'node_id', 'resource_id']) assert.ok(cols('pairing_codes').includes(c), `pairing_codes.${c}`);
  assert.ok(names.includes('admin_grants'), 'missing table admin_grants (0016)');
  for (const c of ['user_id', 'role', 'scope', 'expires_at', 'revoked_at']) assert.ok(cols('admin_grants').includes(c), `admin_grants.${c}`);
  assert.ok(names.includes('dgm_preview_runs'), 'missing table dgm_preview_runs (0017)');
  for (const c of ['task_id', 'created_by', 'fixture', 'held', 'label', 'target', 'status', 'envelope_label', 'advice_reason', 'budget_fits', 'budget_reason', 'settlement', 'gates_json', 'provenance_json', 'created_at', 'updated_at']) assert.ok(cols('dgm_preview_runs').includes(c), `dgm_preview_runs.${c}`);
  assert.ok(names.includes('dgm_preview_events'), 'missing table dgm_preview_events (0017)');
  for (const c of ['run_id', 'seq', 'at', 'event', 'body_json']) assert.ok(cols('dgm_preview_events').includes(c), `dgm_preview_events.${c}`);
  assert.ok(names.includes('idempotency_keys'), 'missing table idempotency_keys (0015)');
  assert.ok(cols('resources').includes('node_id'), 'resources.node_id (0015 pairing identity)');
  assert.ok(names.includes('advisor_ops'), 'missing table advisor_ops (0018)');
  for (const c of ['tenant_id', 'op_key', 'input_digest', 'state', 'receipt_json', 'created_at', 'updated_at']) assert.ok(cols('advisor_ops').includes(c), `advisor_ops.${c}`);
  assert.ok(names.includes('routing_ops'), 'missing table routing_ops (0021 provisional)');
  for (const c of ['tenant_id', 'request_id', 'state', 'source', 'ranking_json', 'policy_version', 'created_at', 'updated_at', 'expires_at']) assert.ok(cols('routing_ops').includes(c), `routing_ops.${c}`);
  assert.ok(names.includes('routing_reservations'), 'missing table routing_reservations (0021 provisional)');
  for (const c of ['op_id', 'tenant_id', 'grant_id', 'jobs', 'tokens', 'state', 'created_at', 'expires_at']) assert.ok(cols('routing_reservations').includes(c), `routing_reservations.${c}`);
  assert.ok(names.includes('routing_advice_cache'), 'missing table routing_advice_cache (0021 provisional)');
  for (const c of ['cache_key', 'tenant_id', 'response_json', 'created_at', 'expires_at']) assert.ok(cols('routing_advice_cache').includes(c), `routing_advice_cache.${c}`);
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
