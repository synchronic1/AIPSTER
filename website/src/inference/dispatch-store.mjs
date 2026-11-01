// Real D1 store behind the internal admitted-dispatch coordinator.
//
// createD1DispatchStore(db, { now, env }) returns the coordinator `authority`
// object (docs/dispatch-coordinator.md shapes) plus the admission issuer and
// the bound-job transport primitives L2 consumes (DS-INFERENCE-LANES-20261101.md,
// L1 interface). Migration 0024_inference_dispatch.sql owns the tables.
//
// Nothing here is imported by worker.js; POST /api/jobs stays 501. There is no
// network I/O: dispatch is a durable queue row, not an inference call.
//
// Contract notes that are not obvious from the method bodies:
//
// - issueAdmission() stores runtime_instance = runtime_id (Addendum B) and
//   model_fingerprint = model_id (Addendum A): there is no worker-reported model
//   digest yet, so the model id is the pinned fingerprint. A later digest can
//   replace it without changing the coordinator wire shape.
// - The one grant covering an operation is the live app `grants` row (the
//   existing access authority: revoked_at + used_* counters read by grantUsage).
//   App grants have no version column, so the revision the coordinator re-pins
//   is derived deterministically from the quota terms:
//       revision = max_jobs * GRANT_REVISION_BASE + max_tokens
//   Any change to the granted quota changes the revision and invalidates an
//   admission issued under the old terms. A test can therefore prove the CAS
//   catches a changed revision by editing max_tokens after issuing.
// - Owner self-use admissions use grant_id = "owner:<resource_id>" (the
//   "owner:" prefix is reserved; app grant ids are generated with another
//   prefix). Their only budget is the owner daily pool, so readGrant reports a
//   non-binding token ceiling and the real ceiling is enforced at hold time,
//   where a missing/invalid INFERENCE_OWNER_DAILY_TOKENS is 0 and fails closed.
// - A hold is a conservative charge. Grant holds charge grants.used_tokens /
//   used_jobs (so every existing net-usage reader stays correct); owner holds
//   charge dispatch_pool_usage.used_tokens. Release is a guarded decrement by
//   the exact owning hold, settlement flips committed holds to charged without
//   touching the counters. No path can drive a counter negative or past a
//   ceiling, and none rewrites it from a caller-supplied number.
// - Mutating methods run one at a time per store instance. D1's single-writer
//   serialization is the cross-isolate guarantee; the in-isolate queue keeps
//   the same statement order under Promise.all so a batch of guarded statements
//   cannot interleave with itself (and keeps the node:sqlite test shim faithful
//   to real D1). Conditional SQL, not the queue, is what enforces every
//   invariant.
import { all, first, rid16 } from '../lib/store.js';
import { httpError } from '../lib/validate.js';
import { resourceLiveness } from '../lib/status.mjs';
import { CONTENT_MAX } from './worker-transport.mjs';

export const ADMISSION_TTL_MS = 10 * 60 * 1000;
export const INFERENCE_RUNTIME_IDS = Object.freeze(['ganglion', 'llama-server']);
const RUNTIME_IDS = new Set(INFERENCE_RUNTIME_IDS);
const TRANSPORT_PROTOCOL = 'aipster-bound-cpu-internal/1';
const GRANT_REVISION_BASE = 10000001;
const INFERENCE_ROUTE = 'internal';
const MAX_TOKENS = 4096;
const OWNER_PREFIX = 'owner:';
const GRANT_POOL_PREFIX = 'grant:';
const OWNER_GRANT_REVISION = 1;
const FAR_FUTURE = '9999-12-31T23:59:59.999Z';

const SUCCEEDED_KEYS = new Set(['request_id', 'node_id', 'runtime_id', 'model_id', 'runtime_instance',
  'model_fingerprint', 'simulated', 'content', 'elapsed_ms', 'usage', 'cache', 'truncated']);
const FAILED_KEYS = new Set(['reason', 'detail', 'elapsed_ms', 'usage', 'cache']);

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const isStr = (x, max = 256) => typeof x === 'string' && x.length > 0 && x.length <= max;
const isToken = (x, max = 64) => typeof x === 'string' && x.length >= 1 && x.length <= max
  && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(x);
const isGen = (x) => Number.isSafeInteger(x) && x >= 1;
const isAmount = (x) => Number.isSafeInteger(x) && x >= 1 && x <= MAX_TOKENS;
const isoAt = (ms) => new Date(ms).toISOString();
const dayOf = (ms) => isoAt(ms).slice(0, 10);
const changed = (res) => Number(res && res.meta && res.meta.changes) || 0;
const changes = (res, i = 0) => changed(res && res[i]);
const json = (x) => JSON.stringify(x);

function grantRevision(row) {
  return Number(row.max_jobs) * GRANT_REVISION_BASE + Number(row.max_tokens);
}

function ownerGrantId(resourceId) {
  return OWNER_PREFIX + resourceId;
}

function isOwnerGrant(grantId) {
  return typeof grantId === 'string' && grantId.startsWith(OWNER_PREFIX) && grantId.length > OWNER_PREFIX.length;
}

function ownerCeiling(env) {
  const n = env ? Number(env.INFERENCE_OWNER_DAILY_TOKENS) : NaN;
  // Missing or invalid means 0: the pool fails closed rather than defaulting open.
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

function principalOf(value) {
  if (!isObj(value) || !isStr(value.principal_id) || !isStr(value.tenant_id)) return null;
  return { principal_id: value.principal_id, tenant_id: value.tenant_id };
}

function mapAdmission(row) {
  return {
    admission_ref: row.admission_ref,
    principal_id: row.principal_id,
    tenant_id: row.tenant_id,
    grant_id: row.grant_id,
    grant_revision: Number(row.grant_revision),
    resource_id: row.resource_id,
    incarnation: row.incarnation,
    peer_node: row.peer_node,
    peer_workspace: row.peer_workspace,
    route: row.route,
    node_id: row.node_id,
    runtime_id: row.runtime_id,
    runtime_instance: row.runtime_instance,
    model_id: row.model_id,
    model_fingerprint: row.model_fingerprint,
    max_tokens: Number(row.max_tokens),
    expires_at: Number(row.expires_at),
    pools: JSON.parse(row.pools_json),
  };
}

function mapOperation(row) {
  return {
    op_id: row.op_id,
    op_key: row.op_key,
    principal_id: row.principal_id,
    tenant_id: row.tenant_id,
    request_digest: row.request_digest,
    binding: JSON.parse(row.binding_json),
    generation: Number(row.generation),
    phase: row.phase,
    job_id: row.job_id || null,
    uncertain: row.uncertain_phase
      ? { phase: row.uncertain_phase, detail: row.uncertain_detail || null }
      : null,
    cancel_intent: Number(row.cancel_intent) === 1,
    settled: row.settled_outcome
      ? { outcome: row.settled_outcome, result_digest: row.settled_digest || '' }
      : null,
  };
}

// Validate the binding the coordinator derived from durable admitted state.
function validateBinding(binding, principalId, tenantId) {
  if (!isObj(binding)) return false;
  if (binding.principal_id !== principalId || binding.tenant_id !== tenantId) return false;
  for (const k of ['admission_ref', 'grant_id', 'resource_id', 'incarnation', 'node_id', 'runtime_id',
    'runtime_instance', 'model_id', 'model_fingerprint']) {
    if (!isStr(binding[k])) return false;
  }
  if (!isGen(binding.grant_revision)) return false;
  if (!Number.isSafeInteger(binding.deadline_at) || binding.deadline_at <= 0) return false;
  if (!Array.isArray(binding.pools) || binding.pools.length < 1) return false;
  const ids = new Set();
  for (const pool of binding.pools) {
    if (!isObj(pool) || !isStr(pool.pool_id) || !isAmount(pool.amount)) return false;
    if (ids.has(pool.pool_id)) return false;
    ids.add(pool.pool_id);
  }
  return true;
}

export function createD1DispatchStore(db, { now = () => Date.now(), env = null } = {}) {
  if (!db || typeof db.prepare !== 'function' || typeof db.batch !== 'function') {
    throw new Error('createD1DispatchStore requires a D1 database');
  }

  // Serialize mutating methods within this isolate (see the header note).
  let tail = Promise.resolve();
  function exclusive(fn) {
    const next = tail.then(fn, fn);
    tail = next.then(() => undefined, () => undefined);
    return next;
  }

  const clock = () => Number(now());

  async function opRow(op_id) {
    return first(db, 'SELECT * FROM dispatch_operations WHERE op_id = ?', op_id);
  }

  async function fencedAt(op_id, generation) {
    const row = await first(db, 'SELECT 1 AS hit FROM dispatch_fences WHERE op_id = ? AND generation = ?', op_id, generation);
    return !!row;
  }

  // null when the operation's authority is still live for this exact binding;
  // otherwise a stable reason token.
  async function authorityProblem(op, binding, authority) {
    if (!isObj(authority) || authority.grant_id !== binding.grant_id) return 'authority_changed';
    if (isOwnerGrant(authority.grant_id)) {
      if (authority.grant_id !== ownerGrantId(binding.resource_id)) return 'authority_changed';
      const r = await first(db, 'SELECT id, owner_id, incarnation FROM resources WHERE id = ?', binding.resource_id);
      if (!r || r.incarnation !== authority.incarnation || r.owner_id !== op.principal_id) return 'authority_changed';
      return null;
    }
    const g = await first(db, `SELECT g.*, r.incarnation AS live_incarnation
      FROM grants g JOIN resources r ON r.id = g.resource_id WHERE g.id = ?`, authority.grant_id);
    if (!g) return 'authority_changed';
    if (g.revoked_at) return 'revoked';
    if (grantRevision(g) !== authority.grant_revision) return 'authority_changed';
    if (g.resource_id !== binding.resource_id) return 'authority_changed';
    if (g.grantee_id !== op.principal_id) return 'authority_changed';
    if (g.live_incarnation !== authority.incarnation) return 'authority_changed';
    return null;
  }

  async function liveAuthoritySql(op, binding, authority) {
    // Returns { sql, binds } for use inside a conditional UPDATE.
    if (isOwnerGrant(authority.grant_id)) {
      return {
        sql: `EXISTS (SELECT 1 FROM resources r WHERE r.id = ? AND r.incarnation = ? AND r.owner_id = ?)`,
        binds: [binding.resource_id, authority.incarnation, op.principal_id],
      };
    }
    return {
      sql: `EXISTS (SELECT 1 FROM grants g JOIN resources r ON r.id = g.resource_id
        WHERE g.id = ? AND g.revoked_at IS NULL AND (g.max_jobs * ? + g.max_tokens) = ?
          AND g.resource_id = ? AND g.grantee_id = ? AND r.incarnation = ?)`,
      binds: [authority.grant_id, GRANT_REVISION_BASE, authority.grant_revision,
        binding.resource_id, op.principal_id, authority.incarnation],
    };
  }

  // ------------------------------------------------------------------ issuer

  async function issueAdmission({ principal, resource_id, model_id, max_tokens, grant, runtime_id = 'ganglion' } = {}) {
    return exclusive(async () => {
      const p = principalOf(principal);
      if (!p) throw httpError(400, 'A trusted principal is required.', 'INVALID_PRINCIPAL');
      if (!isStr(resource_id)) throw httpError(400, 'resource_id is required.', 'INVALID_RESOURCE');
      if (!isStr(model_id)) throw httpError(400, 'model_id is required.', 'INVALID_MODEL');
      if (!isAmount(max_tokens)) throw httpError(400, `max_tokens must be 1..${MAX_TOKENS}.`, 'INVALID_MAX_TOKENS');
      if (!isStr(runtime_id) || !RUNTIME_IDS.has(runtime_id)) throw httpError(400, 'Unknown runtime.', 'BAD_RUNTIME');
      const grantId = typeof grant === 'string' ? grant : (isObj(grant) ? grant.id : null);
      if (grant != null && !isStr(grantId)) throw httpError(400, 'grant must be a grant id.', 'INVALID_GRANT');

      const t = clock();
      const resource = await first(db, `SELECT id, owner_id, node_id, incarnation, online, heartbeat_at
        FROM resources WHERE id = ?`, resource_id);
      if (!resource) throw httpError(404, 'Resource not found.', 'RESOURCE_NOT_FOUND');
      const liveness = resourceLiveness(
        { online: Number(resource.online) === 1, heartbeatAt: resource.heartbeat_at }, t);
      if (liveness !== 'online') throw httpError(403, 'Resource is not online.', 'RESOURCE_UNAVAILABLE');

      let grant_id;
      let revision;
      let pool_id;
      if (grantId === null) {
        if (resource.owner_id !== p.principal_id) {
          throw httpError(403, 'Owner admission requires resource ownership.', 'OWNER_MISMATCH');
        }
        grant_id = ownerGrantId(resource_id);
        revision = OWNER_GRANT_REVISION;
        pool_id = `${OWNER_PREFIX}${p.principal_id}:${dayOf(t)}`;
      } else {
        const g = await first(db, 'SELECT * FROM grants WHERE id = ?', grantId);
        if (!g || g.revoked_at !== null) throw httpError(403, 'No matching grant.', 'NO_MATCHING_GRANT');
        if (g.resource_id !== resource_id) throw httpError(403, 'No matching grant.', 'NO_MATCHING_GRANT');
        if (g.grantee_id !== p.principal_id) throw httpError(403, 'No matching grant.', 'NO_MATCHING_GRANT');
        if (g.owner_id !== resource.owner_id) throw httpError(403, 'No matching grant.', 'NO_MATCHING_GRANT');
        const owner = await first(db, 'SELECT demo FROM "user" WHERE id = ?', g.owner_id);
        const grantee = await first(db, 'SELECT demo FROM "user" WHERE id = ?', g.grantee_id);
        if (!owner || !grantee || Number(owner.demo || 0) !== Number(grantee.demo || 0)) {
          throw httpError(403, 'No matching grant.', 'NO_MATCHING_GRANT');
        }
        if (max_tokens > Number(g.max_tokens)) throw httpError(403, 'No matching grant.', 'NO_MATCHING_GRANT');
        grant_id = grantId;
        revision = grantRevision(g);
        pool_id = `${GRANT_POOL_PREFIX}${grantId}`;
      }

      const admission_ref = rid16('adm_');
      const expires_at = t + ADMISSION_TTL_MS;
      const runtime = runtime_id;
      const pools = [{ pool_id, amount: max_tokens }];
      await db.prepare(`INSERT INTO dispatch_admissions
        (admission_ref, principal_id, tenant_id, grant_id, grant_revision, resource_id, incarnation,
         peer_node, peer_workspace, route, node_id, runtime_id, runtime_instance, model_id,
         model_fingerprint, max_tokens, pools_json, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
        admission_ref, p.principal_id, p.tenant_id, grant_id, revision, resource_id, resource.incarnation,
        resource.node_id || resource.id, resource.owner_id, INFERENCE_ROUTE, resource_id, runtime,
        runtime, model_id, model_id, max_tokens, json(pools), expires_at, isoAt(t)).run();
      return { admission_ref, expires_at, model_id, max_tokens };
    });
  }

  // --------------------------------------------------------------- authority

  async function resolveAdmission({ principal, admission_ref } = {}) {
    const p = principalOf(principal);
    if (!p || !isStr(admission_ref, 128)) return null;
    const row = await first(db, `SELECT * FROM dispatch_admissions
      WHERE admission_ref = ? AND principal_id = ? AND tenant_id = ?`,
      admission_ref, p.principal_id, p.tenant_id);
    return row ? mapAdmission(row) : null;
  }

  async function admittedModels(grant_id) {
    const rows = await all(db, `SELECT DISTINCT model_id FROM dispatch_admissions
      WHERE grant_id = ? AND expires_at > ?`, grant_id, clock());
    return rows.map((r) => r.model_id);
  }

  async function readGrant({ grant_id } = {}) {
    if (!isStr(grant_id)) return null;
    if (isOwnerGrant(grant_id)) {
      const resourceId = grant_id.slice(OWNER_PREFIX.length);
      const r = await first(db, `SELECT id, owner_id, node_id, incarnation, created_at
        FROM resources WHERE id = ?`, resourceId);
      if (!r) return null;
      return {
        id: grant_id, status: 'enforced', revoked: false, revision: OWNER_GRANT_REVISION,
        recipientNode: r.node_id || r.id, recipientWorkspace: r.owner_id, consumers: [r.owner_id],
        resourceId: r.id, incarnation: r.incarnation, actions: ['inference'],
        models: await admittedModels(grant_id), notBefore: r.created_at, expiry: FAR_FUTURE,
        // Advisory only: the owner daily ceiling is enforced at hold time, and a
        // zero/absent env ceiling must reach acquireHold to fail closed there
        // instead of surfacing as NO_MATCHING_GRANT here.
        ceilings: { maxTokens: Number.MAX_SAFE_INTEGER }, route: INFERENCE_ROUTE,
      };
    }
    const g = await first(db, `SELECT g.*, r.node_id AS live_node_id, r.incarnation AS live_incarnation
      FROM grants g JOIN resources r ON r.id = g.resource_id WHERE g.id = ?`, grant_id);
    if (!g) return null;
    return {
      id: g.id, status: g.revoked_at ? 'revoked' : 'enforced', revoked: !!g.revoked_at,
      revision: grantRevision(g), recipientNode: g.live_node_id || g.resource_id,
      recipientWorkspace: g.owner_id, consumers: [g.grantee_id], resourceId: g.resource_id,
      incarnation: g.live_incarnation, actions: ['inference'], models: await admittedModels(grant_id),
      notBefore: g.created_at, expiry: FAR_FUTURE,
      ceilings: { maxTokens: Number(g.max_tokens), maxRequests: Number(g.max_jobs) },
      route: INFERENCE_ROUTE,
    };
  }

  async function claimOperation({ op_key, request_digest, principal_id, tenant_id, binding } = {}) {
    return exclusive(async () => {
      if (!isStr(op_key, 1024) || !isStr(request_digest, 128) || !isStr(principal_id) || !isStr(tenant_id)) {
        throw httpError(400, 'Malformed operation claim.', 'INVALID_OPERATION');
      }
      if (!validateBinding(binding, principal_id, tenant_id)) {
        throw httpError(400, 'Malformed operation binding.', 'INVALID_BINDING');
      }
      const existing = await first(db, 'SELECT * FROM dispatch_operations WHERE op_key = ?', op_key);
      if (existing) return { claimed: false, op: mapOperation(existing) };
      const op_id = rid16('dispatch-op-');
      const t = isoAt(clock());
      await db.prepare(`INSERT OR IGNORE INTO dispatch_operations
        (op_id, op_key, principal_id, tenant_id, request_digest, binding_json, generation, phase,
         cancel_intent, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, 'claimed', 0, ?, ?)`).bind(
        op_id, op_key, principal_id, tenant_id, request_digest, json(binding), t, t).run();
      const row = await first(db, 'SELECT * FROM dispatch_operations WHERE op_key = ?', op_key);
      // A concurrent claim in another isolate may have won the insert.
      return { claimed: row.op_id === op_id, op: mapOperation(row) };
    });
  }

  async function getOperation({ op_key } = {}) {
    if (!isStr(op_key, 1024)) return null;
    const row = await first(db, 'SELECT * FROM dispatch_operations WHERE op_key = ?', op_key);
    return row ? mapOperation(row) : null;
  }

  async function acquireHold({ op_id, generation, pool_id, amount } = {}) {
    return exclusive(async () => {
      if (!isStr(op_id) || !isGen(generation) || !isStr(pool_id, 512) || !isAmount(amount)) {
        throw httpError(400, 'Malformed hold request.', 'INVALID_HOLD');
      }
      const op = await opRow(op_id);
      if (!op || Number(op.generation) !== generation) return { held: false, reason: 'fenced' };
      if (await fencedAt(op_id, generation)) return { held: false, reason: 'fenced' };
      const binding = JSON.parse(op.binding_json);
      const declared = binding.pools.find((p) => p.pool_id === pool_id);
      if (!declared || declared.amount !== amount) {
        throw httpError(400, 'Hold does not match the admitted pool.', 'INVALID_HOLD');
      }
      const t = isoAt(clock());
      // A replayed hold returns the original permit, including after admission
      // committed it; a released/charged hold never re-charges.
      const own = await first(db, `SELECT * FROM dispatch_holds
        WHERE op_id = ? AND pool_id = ?`, op_id, pool_id);
      if (own && Number(own.generation) === generation) {
        if (own.state === 'held' || own.state === 'committed') return { held: true, hold_id: own.hold_id };
        return { held: false, reason: 'insufficient' };
      }
      if (!['claimed', 'holding'].includes(op.phase)) return { held: false, reason: 'fenced' };

      const hold_id = rid16('hold_');
      // Finding 4437293864: the initial reads above can race a cancellation
      // that fences and releases in another isolate. Re-check the operation's
      // exact generation and the fence tombstone inside the same atomic batch
      // as the budget charge, so a fenced/released operation can never gain a
      // hold and no orphaned charge can land.
      const opAlive = `EXISTS (SELECT 1 FROM dispatch_operations o
          WHERE o.op_id = ? AND o.generation = ? AND o.phase IN ('claimed', 'holding'))
        AND NOT EXISTS (SELECT 1 FROM dispatch_fences f WHERE f.op_id = ? AND f.generation = ?)`;
      const insertHold = db.prepare(`INSERT OR IGNORE INTO dispatch_holds
        (hold_id, op_id, generation, pool_id, pool_kind, amount, jobs, state, created_at, updated_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, 'held', ?, ?
        WHERE changes() = 1 AND ${opAlive}`);
      const advance = db.prepare(`UPDATE dispatch_operations SET phase = 'holding', updated_at = ?
        WHERE op_id = ? AND generation = ? AND phase IN ('claimed', 'holding') AND changes() = 1`);
      let batch;
      if (pool_id.startsWith(GRANT_POOL_PREFIX) && pool_id.length > GRANT_POOL_PREFIX.length) {
        const grantId = pool_id.slice(GRANT_POOL_PREFIX.length);
        // Charge at hold, net of routing refunds, only for an unrevoked grant
        // with headroom, no existing hold for this (op, pool), and a still-live
        // unfenced operation at this generation.
        batch = [
          db.prepare(`UPDATE grants SET used_tokens = used_tokens + ?, used_jobs = used_jobs + ?
            WHERE id = ? AND revoked_at IS NULL
              AND used_jobs - (SELECT COALESCE(SUM(jobs), 0) FROM routing_refunds WHERE grant_id = ?) + 1 <= max_jobs
              AND used_tokens - (SELECT COALESCE(SUM(tokens), 0) FROM routing_refunds WHERE grant_id = ?) + ? <= max_tokens
              AND NOT EXISTS (SELECT 1 FROM dispatch_holds WHERE op_id = ? AND pool_id = ?)
              AND ${opAlive}`).bind(
            amount, 1, grantId, grantId, grantId, amount, op_id, pool_id, op_id, generation, op_id, generation),
          insertHold.bind(hold_id, op_id, generation, pool_id, 'grant', amount, 1, t, t,
            op_id, generation, op_id, generation),
          advance.bind(t, op_id, generation),
        ];
      } else if (pool_id.startsWith(OWNER_PREFIX) && pool_id.length > OWNER_PREFIX.length) {
        const rest = pool_id.slice(OWNER_PREFIX.length);
        const sep = rest.lastIndexOf(':');
        const owner = sep > 0 ? rest.slice(0, sep) : rest;
        const day = sep > 0 ? rest.slice(sep + 1) : dayOf(clock());
        if (owner !== op.principal_id) throw httpError(400, 'Owner pool does not match the principal.', 'INVALID_HOLD');
        const ceiling = ownerCeiling(env);
        batch = [
          // The day's ceiling is fixed at first use; later env edits do not
          // retroactively raise an already-open pool.
          db.prepare(`INSERT OR IGNORE INTO dispatch_pool_usage
            (pool_id, kind, principal_id, day, ceiling_tokens, used_tokens, created_at, updated_at)
            VALUES (?, 'owner', ?, ?, ?, 0, ?, ?)`).bind(pool_id, owner, day, ceiling, t, t),
          db.prepare(`UPDATE dispatch_pool_usage SET used_tokens = used_tokens + ?, updated_at = ?
            WHERE pool_id = ? AND used_tokens + ? <= ceiling_tokens
              AND NOT EXISTS (SELECT 1 FROM dispatch_holds WHERE op_id = ? AND pool_id = ?)
              AND ${opAlive}`).bind(
            amount, t, pool_id, amount, op_id, pool_id, op_id, generation, op_id, generation),
          insertHold.bind(hold_id, op_id, generation, pool_id, 'owner', amount, 0, t, t,
            op_id, generation, op_id, generation),
          advance.bind(t, op_id, generation),
        ];
      } else {
        throw httpError(400, 'Unknown budget pool.', 'INVALID_HOLD');
      }
      const results = await db.batch(batch);
      // The guarded hold insert is the second-to-last statement in both
      // branches; its zero-row result means the charge did not apply either.
      if (changes(results, batch.length - 2) === 1) return { held: true, hold_id };
      // A concurrent caller may have won the (op, pool) insert; replay it.
      const held = await first(db, `SELECT * FROM dispatch_holds WHERE op_id = ? AND pool_id = ?`, op_id, pool_id);
      if (held && Number(held.generation) === generation
        && (held.state === 'held' || held.state === 'committed')) {
        return { held: true, hold_id: held.hold_id };
      }
      if (await fencedAt(op_id, generation)) return { held: false, reason: 'fenced' };
      return { held: false, reason: 'insufficient' };
    });
  }

  // The admission linearization point: one conditional UPDATE over the exact
  // operation-owned holds, the fence tombstone and the live authority. Every
  // later effect in the batch is guarded on changes() = 1, so a zero-row CAS
  // commits nothing (D1 batches do not abort on a zero-row statement).
  async function admit({ op_id, generation, holds, authority } = {}) {
    return exclusive(async () => {
      if (!isStr(op_id) || !isGen(generation) || !Array.isArray(holds) || !isObj(authority)) {
        throw httpError(400, 'Malformed admission request.', 'INVALID_ADMISSION');
      }
      const op = await opRow(op_id);
      if (!op) return { outcome: 'rejected', reason: 'unknown_operation' };
      if (Number(op.generation) !== generation) return { outcome: 'rejected', reason: 'fenced' };
      if (op.phase === 'admitted') {
        // Idempotent replay only for the exact hold set that committed.
        const provided = holds.filter((h) => isStr(h)).sort();
        const committed = (await all(db, `SELECT hold_id FROM dispatch_holds
          WHERE op_id = ? AND generation = ? AND state = 'committed'`, op_id, generation))
          .map((r) => r.hold_id).sort();
        if (provided.length !== holds.length || provided.length !== committed.length
          || provided.some((h, i) => h !== committed[i])) {
          return { outcome: 'rejected', reason: 'holds_mismatch' };
        }
        return { outcome: 'admitted' };
      }
      if (!['claimed', 'holding'].includes(op.phase)) return { outcome: 'rejected', reason: `phase_${op.phase}` };
      if (!authority || !isStr(authority.grant_id)) return { outcome: 'rejected', reason: 'authority_changed' };

      const binding = JSON.parse(op.binding_json);
      const holdIds = holds.filter((h) => isStr(h));
      if (holdIds.length !== holds.length || new Set(holdIds).size !== holdIds.length) {
        return { outcome: 'rejected', reason: 'holds_mismatch' };
      }
      const poolIds = binding.pools.map((p) => p.pool_id);
      if (holdIds.length !== poolIds.length) return { outcome: 'rejected', reason: 'holds_mismatch' };

      const t = isoAt(clock());
      const cond = [
        `NOT EXISTS (SELECT 1 FROM dispatch_fences f WHERE f.op_id = ? AND f.generation = ?)`,
      ];
      const binds = [op_id, generation];
      const live = await liveAuthoritySql(op, binding, authority);
      cond.push(live.sql);
      binds.push(...live.binds);

      const holdPh = holdIds.map(() => '?').join(',');
      const poolPh = poolIds.map(() => '?').join(',');
      cond.push(`(SELECT COUNT(*) FROM dispatch_holds h
        WHERE h.hold_id IN (${holdPh}) AND h.op_id = ? AND h.generation = ? AND h.state = 'held') = ?`);
      binds.push(...holdIds, op_id, generation, holdIds.length);
      cond.push(`NOT EXISTS (SELECT 1 FROM dispatch_holds h
        WHERE h.op_id = ? AND h.generation = ? AND h.state = 'held' AND h.hold_id NOT IN (${holdPh}))`);
      binds.push(op_id, generation, ...holdIds);
      cond.push(`(SELECT COUNT(*) FROM dispatch_holds h
        WHERE h.op_id = ? AND h.generation = ? AND h.state = 'held' AND h.pool_id IN (${poolPh})) = ?`);
      binds.push(op_id, generation, ...poolIds, poolIds.length);

      const [cas] = await db.batch([
        db.prepare(`UPDATE dispatch_operations SET phase = 'admitted', updated_at = ?
          WHERE op_id = ? AND generation = ? AND phase IN ('claimed', 'holding') AND ${cond.join(' AND ')}`).bind(
          t, op_id, generation, ...binds),
        db.prepare(`UPDATE dispatch_holds SET state = 'committed', updated_at = ?
          WHERE op_id = ? AND generation = ? AND state = 'held' AND changes() = 1`).bind(t, op_id, generation),
      ]);
      if (changed(cas) === 1) return { outcome: 'admitted' };

      // Classify the refusal for the operator; the CAS above decided it.
      if (await fencedAt(op_id, generation)) return { outcome: 'rejected', reason: 'fenced' };
      const problem = await authorityProblem(op, binding, authority);
      if (problem) return { outcome: 'rejected', reason: problem };
      return { outcome: 'rejected', reason: 'holds_mismatch' };
    });
  }

  async function redeemStart({ op_id, generation, worker } = {}) {
    return exclusive(async () => {
      if (!isStr(op_id) || !isGen(generation)) return { outcome: 'refused', reason: 'fenced' };
      const op = await opRow(op_id);
      if (!op || Number(op.generation) !== generation) return { outcome: 'refused', reason: 'fenced' };
      if (['redeemed', 'dispatched', 'settled'].includes(op.phase)) return { outcome: 'redeemed' };
      if (await fencedAt(op_id, generation)) return { outcome: 'refused', reason: 'fenced' };
      if (op.phase !== 'admitted') return { outcome: 'refused', reason: 'not_admitted' };
      const binding = JSON.parse(op.binding_json);
      const authority = {
        grant_id: binding.grant_id, grant_revision: binding.grant_revision, incarnation: binding.incarnation,
      };
      // Reason fidelity: like the modeled store, revoked authority is reported
      // ahead of a worker mismatch when both are true.
      if (await authorityProblem(op, binding, authority)) return { outcome: 'refused', reason: 'revoked' };
      if (!isObj(worker) || worker.node_id !== binding.node_id
        || worker.runtime_instance !== binding.runtime_instance) {
        return { outcome: 'refused', reason: 'worker_mismatch' };
      }
      const live = await liveAuthoritySql(op, binding, authority);
      const t = isoAt(clock());
      const [res] = await db.batch([
        db.prepare(`UPDATE dispatch_operations SET phase = 'redeemed', updated_at = ?
          WHERE op_id = ? AND generation = ? AND phase = 'admitted'
            AND NOT EXISTS (SELECT 1 FROM dispatch_fences f WHERE f.op_id = ? AND f.generation = ?)
            AND ${live.sql}`).bind(t, op_id, generation, op_id, generation, ...live.binds),
        db.prepare(`INSERT OR IGNORE INTO dispatch_start_redemptions
          (op_id, generation, redeemed_at, worker_node_id, worker_runtime_instance)
          SELECT ?, ?, ?, ?, ? WHERE changes() = 1`).bind(
          op_id, generation, t, worker.node_id, worker.runtime_instance),
      ]);
      if (changed(res) === 1) return { outcome: 'redeemed' };

      if (await fencedAt(op_id, generation)) return { outcome: 'refused', reason: 'fenced' };
      const problem = await authorityProblem(op, binding, authority);
      if (problem) return { outcome: 'refused', reason: 'revoked' };
      return { outcome: 'refused', reason: 'not_admitted' };
    });
  }

  async function fenceStart({ op_id, generation, reason = '' } = {}) {
    return exclusive(async () => {
      if (!isStr(op_id) || !isGen(generation)) return { outcome: 'fenced' };
      const t = isoAt(clock());
      // The tombstone is inserted only while no start can already exist. A
      // concurrent redemption in another isolate makes this a no-op, and the
      // re-read below reports it as already redeemed.
      const [res] = await db.batch([
        db.prepare(`INSERT OR IGNORE INTO dispatch_fences (op_id, generation, fenced_at, reason)
          SELECT ?, ?, ?, ?
          WHERE NOT EXISTS (SELECT 1 FROM dispatch_start_redemptions r WHERE r.op_id = ? AND r.generation = ?)
            AND NOT EXISTS (SELECT 1 FROM dispatch_operations o
              WHERE o.op_id = ? AND o.generation = ? AND o.phase IN ('redeemed', 'dispatched', 'settled'))`).bind(
          op_id, generation, t, String(reason).slice(0, 200), op_id, generation, op_id, generation),
      ]);
      if (changed(res) === 1) return { outcome: 'fenced' };
      const redeemed = await first(db, `SELECT 1 AS hit FROM dispatch_start_redemptions
        WHERE op_id = ? AND generation = ?`, op_id, generation);
      const op = await opRow(op_id);
      if (redeemed || (op && ['redeemed', 'dispatched', 'settled'].includes(op.phase))) {
        return { outcome: 'already_redeemed' };
      }
      // The tombstone was already there.
      return { outcome: 'fenced' };
    });
  }

  // Releases this operation's own uncharged holds, and only when no start can
  // still be redeemed (never admitted, or fenced after admission).
  async function releaseHolds({ op_id, generation, reason = '' } = {}) {
    return exclusive(async () => {
      if (!isStr(op_id) || !isGen(generation)) return { released: 0 };
      const t = isoAt(clock());
      const [gate] = await db.batch([
        db.prepare(`UPDATE dispatch_operations SET phase = 'released', updated_at = ?
          WHERE op_id = ? AND generation = ? AND phase IN ('claimed', 'holding', 'admitted')
            AND NOT EXISTS (SELECT 1 FROM dispatch_start_redemptions r WHERE r.op_id = ? AND r.generation = ?)
            AND (phase <> 'admitted' OR EXISTS (SELECT 1 FROM dispatch_fences f
              WHERE f.op_id = ? AND f.generation = ?))`).bind(
          t, op_id, generation, op_id, generation, op_id, generation),
      ]);
      if (changed(gate) !== 1) return { released: 0 };
      const holds = await all(db, `SELECT * FROM dispatch_holds
        WHERE op_id = ? AND generation = ? AND state IN ('held', 'committed')`, op_id, generation);
      if (!holds.length) return { released: 0 };
      const batch = [];
      const flipIndex = [];
      for (const h of holds) {
        flipIndex.push(batch.length);
        batch.push(db.prepare(`UPDATE dispatch_holds SET state = 'released', updated_at = ?
          WHERE hold_id = ? AND op_id = ? AND generation = ? AND state IN ('held', 'committed')
            AND EXISTS (SELECT 1 FROM dispatch_operations o
              WHERE o.op_id = ? AND o.generation = ? AND o.phase = 'released')`).bind(
          t, h.hold_id, op_id, generation, op_id, generation));
        if (h.pool_kind === 'grant') {
          batch.push(db.prepare(`UPDATE grants SET used_tokens = used_tokens - ?, used_jobs = used_jobs - ?
            WHERE id = ? AND used_tokens >= ? AND used_jobs >= ? AND changes() = 1`).bind(
            Number(h.amount), Number(h.jobs), h.pool_id.slice(GRANT_POOL_PREFIX.length),
            Number(h.amount), Number(h.jobs)));
        } else {
          batch.push(db.prepare(`UPDATE dispatch_pool_usage SET used_tokens = used_tokens - ?, updated_at = ?
            WHERE pool_id = ? AND used_tokens >= ? AND changes() = 1`).bind(
            Number(h.amount), t, h.pool_id, Number(h.amount)));
        }
      }
      const results = await db.batch(batch);
      const released = flipIndex.reduce((n, i) => n + (changes(results, i) === 1 ? 1 : 0), 0);
      return { released };
    });
  }

  async function recordDispatch({ op_id, generation, job_id } = {}) {
    return exclusive(async () => {
      if (!isStr(op_id) || !isGen(generation) || !isStr(job_id)) return { recorded: false };
      const t = isoAt(clock());
      const [res] = await db.batch([
        db.prepare(`UPDATE dispatch_operations SET phase = 'dispatched', job_id = ?, updated_at = ?
          WHERE op_id = ? AND generation = ? AND phase = 'redeemed'
            AND EXISTS (SELECT 1 FROM dispatch_jobs j
              WHERE j.job_id = ? AND j.op_id = ? AND j.generation = ?)`).bind(
          job_id, t, op_id, generation, job_id, op_id, generation),
      ]);
      return { recorded: changed(res) === 1 };
    });
  }

  async function markUncertain({ op_id, generation, phase, detail } = {}) {
    return exclusive(async () => {
      if (!isStr(op_id) || !isGen(generation)) return { recorded: false };
      const t = isoAt(clock());
      const [res] = await db.batch([
        db.prepare(`UPDATE dispatch_operations
          SET uncertain_phase = COALESCE(uncertain_phase, ?),
              uncertain_detail = COALESCE(uncertain_detail, ?), updated_at = ?
          WHERE op_id = ? AND generation = ?`).bind(
          String(phase || '').slice(0, 64), String(detail || '').slice(0, 200), t, op_id, generation),
      ]);
      return { recorded: changed(res) === 1 };
    });
  }

  async function recordCancelIntent({ op_id, generation } = {}) {
    return exclusive(async () => {
      if (!isStr(op_id) || !isGen(generation)) return { recorded: false };
      const t = isoAt(clock());
      const [res] = await db.batch([
        db.prepare(`UPDATE dispatch_operations SET cancel_intent = 1, updated_at = ?
          WHERE op_id = ? AND generation = ?`).bind(t, op_id, generation),
      ]);
      return { recorded: changed(res) === 1 };
    });
  }

  async function recheckRelease({ op_id, generation } = {}) {
    if (!isStr(op_id) || !isGen(generation)) return { ok: false, reason: 'unknown_operation' };
    const op = await opRow(op_id);
    if (!op) return { ok: false, reason: 'unknown_operation' };
    if (Number(op.generation) !== generation) return { ok: false, reason: 'generation_mismatch' };
    const binding = JSON.parse(op.binding_json);
    const authority = {
      grant_id: binding.grant_id, grant_revision: binding.grant_revision, incarnation: binding.incarnation,
    };
    const problem = await authorityProblem(op, binding, authority);
    if (problem) return { ok: false, reason: 'authority_revoked_before_release' };
    return { ok: true };
  }

  async function settle({ op_id, generation, job_id, outcome, result_digest } = {}) {
    return exclusive(async () => {
      if (!isStr(op_id) || !isGen(generation) || !isStr(job_id)) {
        return { settled: false, reason: 'invalid_request' };
      }
      if (!isStr(outcome, 32) || !isStr(result_digest, 128)) {
        return { settled: false, reason: 'invalid_request' };
      }
      const t = isoAt(clock());
      const [res] = await db.batch([
        db.prepare(`UPDATE dispatch_operations
          SET phase = 'settled', settled_outcome = ?, settled_digest = ?, settled_job_id = ?, updated_at = ?
          WHERE op_id = ? AND generation = ? AND job_id = ? AND phase = 'dispatched'
            AND settled_outcome IS NULL`).bind(
          outcome, result_digest, job_id, t, op_id, generation, job_id),
        db.prepare(`INSERT OR IGNORE INTO dispatch_settlements
          (op_id, generation, job_id, outcome, result_digest, settled_at)
          SELECT ?, ?, ?, ?, ?, ? WHERE changes() = 1`).bind(
          op_id, generation, job_id, outcome, result_digest, t),
        db.prepare(`UPDATE dispatch_holds SET state = 'charged', updated_at = ?
          WHERE op_id = ? AND generation = ? AND state = 'committed' AND changes() = 1`).bind(
          t, op_id, generation),
      ]);
      if (changed(res) === 1) return { settled: true };

      const op = await opRow(op_id);
      if (!op) return { settled: false, reason: 'unknown_operation' };
      if (Number(op.generation) !== generation) return { settled: false, reason: 'generation_mismatch' };
      if (op.job_id !== job_id) return { settled: false, reason: 'job_mismatch' };
      if (op.settled_outcome) return { settled: false, reason: 'already_settled' };
      return { settled: false, reason: 'not_dispatched' };
    });
  }

  // --------------------------------------------------------------- transport

  function validEnvelope(envelope) {
    if (!isObj(envelope) || envelope.protocol !== TRANSPORT_PROTOCOL) return false;
    if (!isObj(envelope.task) || !isObj(envelope.binding)) return false;
    const task = envelope.task;
    if (!isStr(task.model_id) || !isStr(task.prompt, 65536) || !task.prompt.trim()) return false;
    if (!isAmount(task.max_tokens)) return false;
    if (task.temperature !== 0 || task.allow_simulated !== false) return false;
    if (!isObj(task.placement) || task.placement.device !== 'cpu') return false;
    if (!isStr(task.placement.node_id) || !isStr(task.placement.runtime_id)) return false;
    const b = envelope.binding;
    const keys = Object.keys(b).sort();
    if (keys.length !== 5 || keys.join(',') !== 'deadline_at,generation,model_fingerprint,op_id,runtime_instance') return false;
    if (!isStr(b.op_id) || !isGen(b.generation) || !isStr(b.runtime_instance)
      || !isStr(b.model_fingerprint) || !Number.isSafeInteger(b.deadline_at)) return false;
    return true;
  }

  async function enqueueJob(envelope) {
    return exclusive(async () => {
      if (!validEnvelope(envelope)) return { accepted: false, reason: 'invalid_envelope' };
      const b = envelope.binding;
      const task = envelope.task;
      const placement = task.placement;
      const op = await opRow(b.op_id);
      if (!op || Number(op.generation) !== b.generation) return { accepted: false, reason: 'unknown_operation' };
      const binding = JSON.parse(op.binding_json);
      // Verify the exact bound envelope before replaying: a different
      // instance/fingerprint/placement for the same op is never accepted.
      if (b.runtime_instance !== binding.runtime_instance
        || b.model_fingerprint !== binding.model_fingerprint
        || b.deadline_at !== binding.deadline_at
        || placement.node_id !== binding.node_id
        || placement.runtime_id !== binding.runtime_id
        || task.model_id !== binding.model_id) {
        return { accepted: false, reason: 'binding_mismatch' };
      }
      const existing = await first(db, `SELECT job_id FROM dispatch_jobs
        WHERE op_id = ? AND generation = ?`, b.op_id, b.generation);
      if (existing) return { accepted: true, job_id: existing.job_id }; // lost-response replay
      if (op.phase !== 'redeemed') return { accepted: false, reason: 'not_redeemed' };

      const job_id = rid16('job_');
      const t = isoAt(clock());
      await db.batch([
        db.prepare(`INSERT OR IGNORE INTO dispatch_jobs
          (job_id, op_id, generation, resource_id, node_id, runtime_id, model_id, runtime_instance,
           model_fingerprint, status, envelope_json, deadline_at, created_at, updated_at)
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?
          WHERE EXISTS (SELECT 1 FROM dispatch_operations o WHERE o.op_id = ? AND o.generation = ?
              AND o.phase = 'redeemed')
            AND EXISTS (SELECT 1 FROM dispatch_start_redemptions s WHERE s.op_id = ? AND s.generation = ?)
            AND NOT EXISTS (SELECT 1 FROM dispatch_fences f WHERE f.op_id = ? AND f.generation = ?)`).bind(
          job_id, b.op_id, b.generation, placement.node_id, placement.node_id, placement.runtime_id,
          task.model_id, b.runtime_instance, b.model_fingerprint, json(envelope), b.deadline_at, t, t,
          b.op_id, b.generation, b.op_id, b.generation, b.op_id, b.generation),
      ]);
      const row = await first(db, `SELECT job_id FROM dispatch_jobs WHERE op_id = ? AND generation = ?`,
        b.op_id, b.generation);
      if (row) return { accepted: true, job_id: row.job_id };
      return { accepted: false, reason: 'not_dispatchable' };
    });
  }

  async function leaseNextJob({ resource_id, now: at } = {}) {
    return exclusive(async () => {
      if (!isStr(resource_id)) return null;
      const t = Number.isSafeInteger(at) ? at : clock();
      const lease_id = rid16('lease_');
      const tIso = isoAt(t);
      // One atomically selected queued job: matching resource, redeemed and
      // unfenced operation, no recorded uncertainty, deadline still ahead.
      const [res] = await db.batch([
        db.prepare(`UPDATE dispatch_jobs
          SET status = 'leased', lease_id = ?, leased_at = ?, updated_at = ?
          WHERE job_id = (SELECT j.job_id FROM dispatch_jobs j
              JOIN dispatch_operations o ON o.op_id = j.op_id AND o.generation = j.generation
              WHERE j.resource_id = ? AND j.status = 'queued' AND j.deadline_at > ?
                AND o.phase IN ('redeemed', 'dispatched') AND o.uncertain_phase IS NULL
                AND NOT EXISTS (SELECT 1 FROM dispatch_fences f
                  WHERE f.op_id = j.op_id AND f.generation = j.generation)
                AND EXISTS (SELECT 1 FROM dispatch_start_redemptions s
                  WHERE s.op_id = j.op_id AND s.generation = j.generation)
              ORDER BY j.created_at, j.job_id LIMIT 1)
            AND status = 'queued'`).bind(lease_id, tIso, tIso, resource_id, t),
      ]);
      if (changed(res) !== 1) return null;
      const row = await first(db, 'SELECT * FROM dispatch_jobs WHERE lease_id = ?', lease_id);
      if (!row) return null;
      return {
        job_id: row.job_id,
        lease_id: row.lease_id,
        envelope: JSON.parse(row.envelope_json),
        deadline_at: Number(row.deadline_at),
      };
    });
  }

  function normalizeResult(status, result, job) {
    if (!isObj(result)) return { ok: false, reason: 'invalid_result' };
    const keys = Object.keys(result);
    if (status === 'succeeded') {
      if (keys.some((k) => !SUCCEEDED_KEYS.has(k))) return { ok: false, reason: 'invalid_result' };
      if (result.request_id !== job.job_id || result.node_id !== job.node_id
        || result.runtime_id !== job.runtime_id || result.model_id !== job.model_id
        || result.runtime_instance !== job.runtime_instance
        || result.model_fingerprint !== job.model_fingerprint) return { ok: false, reason: 'result_mismatch' };
      if (result.simulated !== false) return { ok: false, reason: 'simulated_result' };
      if (result.truncated !== undefined && result.truncated !== false) return { ok: false, reason: 'invalid_result' };
      // Same limit as the HTTP worker-result validator (worker-transport.mjs):
      // a real completion is far longer than the 256-char identifier default.
      if (!isStr(result.content, CONTENT_MAX) || !result.content.trim()) {
        return { ok: false, reason: 'invalid_result' };
      }
      if (!Number.isFinite(result.elapsed_ms) || result.elapsed_ms < 0) return { ok: false, reason: 'invalid_result' };
      if (!isObj(result.usage) || !isObj(result.cache)) return { ok: false, reason: 'invalid_result' };
      return { ok: true, result };
    }
    // failed / expired
    if (keys.some((k) => !FAILED_KEYS.has(k))) return { ok: false, reason: 'invalid_result' };
    if (!isToken(result.reason, 128)) return { ok: false, reason: 'invalid_result' };
    if (result.detail !== undefined && !isStr(result.detail, 4000)) return { ok: false, reason: 'invalid_result' };
    if (result.elapsed_ms !== undefined
      && (!Number.isFinite(result.elapsed_ms) || result.elapsed_ms < 0)) return { ok: false, reason: 'invalid_result' };
    if (result.usage !== undefined && !isObj(result.usage)) return { ok: false, reason: 'invalid_result' };
    if (result.cache !== undefined && !isObj(result.cache)) return { ok: false, reason: 'invalid_result' };
    return { ok: true, result };
  }

  async function completeJob({ job_id, lease_id, resource_id, status, result } = {}) {
    return exclusive(async () => {
      if (!isStr(job_id) || !isStr(lease_id) || !isStr(resource_id)) return { accepted: false, reason: 'invalid_request' };
      if (!['succeeded', 'failed', 'expired'].includes(status)) return { accepted: false, reason: 'invalid_status' };
      const job = await first(db, 'SELECT * FROM dispatch_jobs WHERE job_id = ?', job_id);
      if (!job) return { accepted: false, reason: 'unknown_job' };
      if (job.resource_id !== resource_id) return { accepted: false, reason: 'wrong_resource' };
      if (job.lease_id !== lease_id) return { accepted: false, reason: 'wrong_lease' };
      if (job.status !== 'leased') return { accepted: false, reason: 'already_completed' };
      if (clock() > Number(job.deadline_at)) return { accepted: false, reason: 'late' };
      const op = await opRow(job.op_id);
      if (!op || Number(op.generation) !== Number(job.generation) || op.uncertain_phase !== null
        || !['redeemed', 'dispatched'].includes(op.phase)) return { accepted: false, reason: 'late' };
      if (await fencedAt(job.op_id, Number(job.generation))) return { accepted: false, reason: 'late' };
      const normalized = normalizeResult(status, result, job);
      if (!normalized.ok) return { accepted: false, reason: normalized.reason };
      const t = isoAt(clock());
      const [res] = await db.batch([
        db.prepare(`UPDATE dispatch_jobs SET status = ?, result_json = ?, updated_at = ?
          WHERE job_id = ? AND lease_id = ? AND resource_id = ? AND status = 'leased'`).bind(
          status, json(normalized.result), t, job_id, lease_id, resource_id),
      ]);
      if (changed(res) === 1) return { accepted: true };
      return { accepted: false, reason: 'already_completed' };
    });
  }

  async function readJob({ job_id } = {}) {
    if (!isStr(job_id)) return null;
    const row = await first(db, 'SELECT * FROM dispatch_jobs WHERE job_id = ?', job_id);
    if (!row) return null;
    const status = row.status === 'queued' || row.status === 'leased' ? 'running' : row.status;
    return {
      id: row.job_id,
      node_id: row.node_id,
      runtime_id: row.runtime_id,
      model_id: row.model_id,
      status,
      result: row.result_json ? JSON.parse(row.result_json) : null,
    };
  }

  return {
    // coordinator authority
    resolveAdmission, readGrant, claimOperation, getOperation, acquireHold, admit, redeemStart,
    fenceStart, releaseHolds, recordDispatch, markUncertain, recordCancelIntent, recheckRelease, settle,
    // issuer + bound-job transport primitives (L2)
    issueAdmission, enqueueJob, leaseNextJob, completeJob, readJob,
  };
}
