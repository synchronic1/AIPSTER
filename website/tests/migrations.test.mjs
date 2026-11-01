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
  for (const c of ['op_id', 'tenant_id', 'grant_id', 'jobs', 'tokens', 'state', 'created_at', 'updated_at', 'expires_at']) assert.ok(cols('routing_reservations').includes(c), `routing_reservations.${c}`);
  assert.ok(names.includes('routing_advice_cache'), 'missing table routing_advice_cache (0021 provisional)');
  for (const c of ['cache_key', 'tenant_id', 'response_json', 'created_at', 'expires_at']) assert.ok(cols('routing_advice_cache').includes(c), `routing_advice_cache.${c}`);
  assert.ok(names.includes('routing_refunds'), 'missing table routing_refunds (0021 provisional)');
  for (const c of ['reservation_id', 'grant_id', 'jobs', 'tokens', 'created_at']) assert.ok(cols('routing_refunds').includes(c), `routing_refunds.${c}`);
  assert.ok(names.includes('dispatch_admissions'), 'missing table dispatch_admissions (0024)');
  for (const c of ['admission_ref', 'principal_id', 'tenant_id', 'grant_id', 'grant_revision', 'resource_id',
    'incarnation', 'peer_node', 'peer_workspace', 'route', 'node_id', 'runtime_id', 'runtime_instance',
    'model_id', 'model_fingerprint', 'max_tokens', 'pools_json', 'expires_at', 'created_at']) {
    assert.ok(cols('dispatch_admissions').includes(c), `dispatch_admissions.${c}`);
  }
  assert.ok(names.includes('dispatch_operations'), 'missing table dispatch_operations (0024)');
  for (const c of ['op_id', 'op_key', 'principal_id', 'tenant_id', 'request_digest', 'binding_json',
    'generation', 'phase', 'job_id', 'uncertain_phase', 'uncertain_detail', 'cancel_intent',
    'settled_outcome', 'settled_digest', 'settled_job_id', 'created_at', 'updated_at']) {
    assert.ok(cols('dispatch_operations').includes(c), `dispatch_operations.${c}`);
  }
  assert.ok(names.includes('dispatch_holds'), 'missing table dispatch_holds (0024)');
  for (const c of ['hold_id', 'op_id', 'generation', 'pool_id', 'pool_kind', 'amount', 'jobs', 'state',
    'created_at', 'updated_at']) assert.ok(cols('dispatch_holds').includes(c), `dispatch_holds.${c}`);
  assert.ok(names.includes('dispatch_pool_usage'), 'missing table dispatch_pool_usage (0024)');
  for (const c of ['pool_id', 'kind', 'principal_id', 'day', 'ceiling_tokens', 'used_tokens',
    'created_at', 'updated_at']) assert.ok(cols('dispatch_pool_usage').includes(c), `dispatch_pool_usage.${c}`);
  assert.ok(names.includes('dispatch_start_redemptions'), 'missing table dispatch_start_redemptions (0024)');
  for (const c of ['op_id', 'generation', 'redeemed_at', 'worker_node_id', 'worker_runtime_instance']) {
    assert.ok(cols('dispatch_start_redemptions').includes(c), `dispatch_start_redemptions.${c}`);
  }
  assert.ok(names.includes('dispatch_fences'), 'missing table dispatch_fences (0024)');
  for (const c of ['op_id', 'generation', 'fenced_at', 'reason']) assert.ok(cols('dispatch_fences').includes(c), `dispatch_fences.${c}`);
  assert.ok(names.includes('dispatch_jobs'), 'missing table dispatch_jobs (0024)');
  for (const c of ['job_id', 'op_id', 'generation', 'resource_id', 'node_id', 'runtime_id', 'model_id',
    'runtime_instance', 'model_fingerprint', 'status', 'envelope_json', 'deadline_at', 'lease_id',
    'leased_at', 'result_json', 'created_at', 'updated_at']) assert.ok(cols('dispatch_jobs').includes(c), `dispatch_jobs.${c}`);
  assert.ok(names.includes('dispatch_settlements'), 'missing table dispatch_settlements (0024)');
  for (const c of ['op_id', 'generation', 'job_id', 'outcome', 'result_digest', 'settled_at']) {
    assert.ok(cols('dispatch_settlements').includes(c), `dispatch_settlements.${c}`);
  }
  const unique = sqlite.prepare('SELECT * FROM pragma_index_list(?)').all('dispatch_holds');
  assert.ok(unique.some((i) => i.unique === 1), 'dispatch_holds is unique per (op_id, pool_id)');
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
