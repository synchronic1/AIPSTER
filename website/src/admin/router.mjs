/* Built with Meta Muse. */
// Administration API scaffold (PRD Milestones 0-1 shape, no real mutations).
// Mounts under /api/admin/v1/* from src/worker.js. Every route denies by
// default: only a session actor holding a live admin_grants row (unrevoked,
// unexpired, recognized role and scope) reaches a handler, and the grant is
// re-checked against the database on every request — never cached, never
// taken from client claims. User API keys, heartbeat keys, demo sessions,
// and expired/revoked grants all fail closed with ADMIN_FORBIDDEN and learn
// nothing about grant existence.
//
// The scaffold answers authorized reads with typed "unavailable" envelopes
// (nulls are never coerced to zero) and authorized mutations with 501
// ADMIN_NOT_IMPLEMENTED: no administrative state changes anywhere in this
// module. Elevation, audit writes, and out-of-band grant issuance are
// Milestone 1 work; their absence is reported, not silently skipped.
import { all } from '../lib/store.js';
import { handleDgmPreview } from '../dgm/router.mjs';

// PRD Section 5 roles. Unknown role values authorize nothing.
export const ADMIN_ROLES = [
  'operations_observer',
  'access_administrator',
  'security_reviewer',
  'support_triager',
  'engineering_reviewer',
  'role_grant_authority'
];

// The only recognized grant scope in the scaffold. Any other stored scope
// grants no permission; fabric/org scoping is Milestone 1 work.
export const ADMIN_SCOPE = 'platform';

// Permission matrix: each endpoint names one permission, each role holds a
// fixed set. Combining roles must not join identity to traffic, so no role
// holds both access-directory and metric-slice permissions.
const ROLE_PERMISSIONS = {
  operations_observer: new Set([
    'admin.status', 'admin.overview.read', 'admin.fabrics.read', 'admin.resources.read',
    'admin.metrics.read', 'admin.operations.read', 'admin.coverage.read', 'admin.dgm.preview'
  ]),
  access_administrator: new Set([
    'admin.status', 'admin.access.read', 'admin.access.suspend', 'admin.access.restore',
    'admin.access.sessions.revoke', 'admin.access.keys.manage', 'admin.access.recovery'
  ]),
  security_reviewer: new Set(['admin.status', 'admin.audit.read']),
  support_triager: new Set(['admin.status', 'admin.tickets.read', 'admin.tickets.manage']),
  engineering_reviewer: new Set([
    'admin.status', 'admin.engineering.read', 'admin.engineering.export', 'admin.engineering.assign', 'admin.dgm.preview'
  ]),
  role_grant_authority: new Set(['admin.status'])
};
// NOTE: admin.operations.alerts.acknowledge is intentionally held by no
// scaffold role. PRD OPS02 keeps the operations observer read-only and
// requires an explicit acknowledge permission; role assignment is
// Milestone 4 work, so every acknowledgement fails closed until then.

// PRD Section 10 metric names: the only accepted `metric` values.
export const ADMIN_METRICS = [
  'incoming_requests', 'admitted_work', 'queue_depth', 'queue_wait_ms', 'throughput_rps',
  'throughput_tokens_per_s', 'latency_end_to_end_ms', 'time_to_first_byte_ms',
  'time_to_first_token_ms', 'token_usage_input', 'token_usage_output', 'error_rate',
  'retry_rate', 'hardware_utilization', 'usable_capacity', 'cost'
];

// Fixed aligned windows only; no arbitrary ranges (PRD PRIV05).
export const ADMIN_WINDOWS = ['15m'];

function send(ctx, status, body) {
  return ctx.json(status, body);
}

function denied() {
  // One shape for every authorization failure: authenticated-but-denied
  // callers cannot distinguish "no grant" from "wrong role" or "expired".
  return { status: 403, body: { error: 'Administration is not authorized for this caller.', code: 'ADMIN_FORBIDDEN' } };
}

// Canonical UTC timestamps only: YYYY-MM-DDTHH:MM:SS[.sss]Z, and the value
// must name a real instant (2026-99-99T... matches the shape but not this).
const CANONICAL_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

export function grantIsLive(expiresAt, nowMs) {
  // null means no expiry. Anything else that is not a canonical UTC
  // timestamp in the future denies: a malformed out-of-band value must fail
  // closed rather than compare as text against the clock.
  if (expiresAt === null || expiresAt === undefined) return true;
  if (typeof expiresAt !== 'string' || !CANONICAL_UTC.test(expiresAt)) return false;
  const ms = Date.parse(expiresAt);
  if (!Number.isFinite(ms)) return false;
  const roundTrip = new Date(ms).toISOString();
  if (roundTrip !== expiresAt && roundTrip !== expiresAt.replace('Z', '.000Z')) return false;
  return ms > nowMs;
}

export async function requireAdmin(ctx, permission) {
  // Returns { grant } on success or { status, body } to send on failure.
  const actor = ctx.actor;
  if (!actor || actor.kind !== 'session' || !actor.user) {
    if (actor && (actor.kind === 'key' || actor.kind === 'expired' || actor.kind === 'invalid-key')) return denied();
    return { status: 401, body: { error: 'Sign-in required.', code: 'AUTH_REQUIRED' } };
  }
  // The demo tenant never administers, even if a grant row were mis-seeded.
  if (Number(actor.user.demo) === 1) return denied();
  let rows = [];
  try {
    rows = await all(ctx.db,
      'SELECT role, scope, expires_at FROM admin_grants WHERE user_id = ? AND revoked_at IS NULL',
      actor.user.id);
  } catch {
    // Fail closed when authority cannot be established (PRD AUTH04).
    return denied();
  }
  const nowMs = Date.now();
  for (const row of rows || []) {
    if (!row || !grantIsLive(row.expires_at, nowMs)) continue;
    const perms = row && row.scope === ADMIN_SCOPE ? ROLE_PERMISSIONS[row.role] : undefined;
    if (perms && perms.has(permission)) {
      return { grant: { role: row.role, scope: row.scope, expires_at: row.expires_at || null } };
    }
  }
  return denied();
}

function unavailable(schemaVersion, reasonCode, extra) {
  return {
    schema_version: schemaVersion,
    state: 'unavailable',
    reason_code: reasonCode,
    observed_at: null,
    ...(extra || {})
  };
}

function unavailableList(schemaVersion, reasonCode) {
  // total is null, never 0: the scaffold measured nothing (PRD Section 10.1).
  return unavailable(schemaVersion, reasonCode, { items: [], total: null });
}

function notImplemented(message) {
  return {
    status: 501,
    body: { error: message || 'Administration is scaffold-only: this action is not implemented and no state changed.', code: 'ADMIN_NOT_IMPLEMENTED' }
  };
}

async function read(ctx, permission, body) {
  const gate = await requireAdmin(ctx, permission);
  if (gate.status) return send(ctx, gate.status, gate.body);
  return send(ctx, 200, body);
}

async function mutate(ctx, permission, message) {
  const gate = await requireAdmin(ctx, permission);
  if (gate.status) return send(ctx, gate.status, gate.body);
  const csrf = ctx.needCsrf();
  if (csrf) return csrf;
  const out = notImplemented(message);
  return send(ctx, out.status, out.body);
}

function metricResponse(url) {
  // Mirrors the PRD Section 11.3 aggregate contract. Only allowlisted
  // scope/interval parameters are accepted; everything else is rejected
  // before any series, hint, or download could exist.
  const metric = url.searchParams.get('metric') || 'latency_end_to_end_ms';
  if (!ADMIN_METRICS.includes(metric)) {
    return { status: 400, body: { error: 'Unknown metric. Use an allowlisted metric name.', code: 'BAD_METRIC' } };
  }
  const window = url.searchParams.get('window') || '15m';
  if (!ADMIN_WINDOWS.includes(window)) {
    return { status: 400, body: { error: 'Unknown window. Fixed windows only.', code: 'BAD_WINDOW' } };
  }
  const end = new Date(Math.floor(Date.now() / 900000) * 900000).toISOString();
  const start = new Date(Date.parse(end) - 900000).toISOString();
  return {
    status: 200,
    body: {
      schema_version: 'admin.metrics.v1',
      scope: { fabric_alias: null },
      window: { start, end },
      metric,
      state: 'not_instrumented',
      value: null,
      reason_code: 'admin_scaffold',
      definition_version: 'scaffold_v1',
      release_policy_version: 'proposed_v1',
      observed_at: null
    }
  };
}

const ID_PATTERN = '([A-Za-z0-9_-]{1,64})';

export async function handleAdmin(ctx) {
  const { request, url } = ctx;
  const path = url.pathname;
  const method = request.method;

  if (path === '/api/admin/v1/status' && method === 'GET') {
    const gate = await requireAdmin(ctx, 'admin.status');
    if (gate.status) return send(ctx, gate.status, gate.body);
    return send(ctx, 200, {
      schema_version: 'admin.status.v1',
      admin: 'scaffold',
      elevation: 'not_implemented',
      mutations: 'disabled',
      grant: gate.grant,
      observed_at: new Date().toISOString()
    });
  }
  // ---- reads: typed unavailable envelopes, no traffic detail views ----
  if (path === '/api/admin/v1/overview' && method === 'GET') {
    return read(ctx, 'admin.overview.read', unavailable('admin.overview.v1', 'not_implemented',
      { fabrics: null, resources: null, usable_capacity: null, coverage: null }));
  }
  if (path === '/api/admin/v1/fabrics' && method === 'GET') {
    // No canonical fabrics table exists (PRD VIS01): the scaffold invents
    // no fabrics from owner IDs and reports the model as pending.
    return read(ctx, 'admin.fabrics.read', unavailableList('admin.fabrics.v1', 'fabric_model_pending'));
  }
  if (path === '/api/admin/v1/resources' && method === 'GET') {
    return read(ctx, 'admin.resources.read', unavailableList('admin.resources.v1', 'not_implemented'));
  }
  if (path === '/api/admin/v1/metrics' && method === 'GET') {
    const gate = await requireAdmin(ctx, 'admin.metrics.read');
    if (gate.status) return send(ctx, gate.status, gate.body);
    const out = metricResponse(url);
    return send(ctx, out.status, out.body);
  }
  if (path === '/api/admin/v1/access/users' && method === 'GET') {
    return read(ctx, 'admin.access.read', unavailableList('admin.access.users.v1', 'not_implemented'));
  }
  if (path === '/api/admin/v1/operations/health' && method === 'GET') {
    return read(ctx, 'admin.operations.read', unavailable('admin.operations.health.v1', 'not_implemented',
      { control_plane: null, collectors: null, compatibility: null }));
  }
  if (path === '/api/admin/v1/operations/alerts' && method === 'GET') {
    return read(ctx, 'admin.operations.read', unavailableList('admin.operations.alerts.v1', 'not_implemented'));
  }
  if (path === '/api/admin/v1/tickets' && method === 'GET') {
    return read(ctx, 'admin.tickets.read', unavailableList('admin.tickets.v1', 'not_implemented'));
  }
  if (path === '/api/admin/v1/engineering/exports' && method === 'GET') {
    return read(ctx, 'admin.engineering.read', unavailableList('admin.engineering.exports.v1', 'not_implemented'));
  }
  if (path === '/api/admin/v1/engineering/assignments' && method === 'GET') {
    return read(ctx, 'admin.engineering.read', unavailableList('admin.engineering.assignments.v1', 'not_implemented'));
  }
  if (path === '/api/admin/v1/audit' && method === 'GET') {
    return read(ctx, 'admin.audit.read', unavailableList('admin.audit.v1', 'not_implemented'));
  }
  if (path === '/api/admin/v1/coverage' && method === 'GET') {
    return read(ctx, 'admin.coverage.read', unavailableList('admin.coverage.v1', 'not_implemented'));
  }
  // ---- mutations: authorized shape enforced, then 501, never a state change ----
  {
    const m = new RegExp(`^/api/admin/v1/access/users/${ID_PATTERN}/suspensions$`).exec(path);
    if (m && method === 'POST') return mutate(ctx, 'admin.access.suspend');
  }
  {
    const m = new RegExp(`^/api/admin/v1/access/users/${ID_PATTERN}/restorations$`).exec(path);
    if (m && method === 'POST') return mutate(ctx, 'admin.access.restore');
  }
  {
    const m = new RegExp(`^/api/admin/v1/access/users/${ID_PATTERN}/sessions/revocations$`).exec(path);
    if (m && method === 'POST') return mutate(ctx, 'admin.access.sessions.revoke');
  }
  {
    const m = new RegExp(`^/api/admin/v1/access/users/${ID_PATTERN}/keys/revocations$`).exec(path);
    if (m && method === 'POST') return mutate(ctx, 'admin.access.keys.manage');
  }
  {
    const m = new RegExp(`^/api/admin/v1/access/users/${ID_PATTERN}/keys/replacements$`).exec(path);
    if (m && method === 'POST') return mutate(ctx, 'admin.access.keys.manage');
  }
  {
    const m = new RegExp(`^/api/admin/v1/access/users/${ID_PATTERN}/recovery/challenges$`).exec(path);
    if (m && method === 'POST') return mutate(ctx, 'admin.access.recovery');
  }
  if (path === '/api/admin/v1/tickets' && method === 'POST') return mutate(ctx, 'admin.tickets.manage');
  {
    const m = new RegExp(`^/api/admin/v1/tickets/${ID_PATTERN}$`).exec(path);
    if (m && method === 'PATCH') return mutate(ctx, 'admin.tickets.manage');
  }
  if (path === '/api/admin/v1/engineering/exports' && method === 'POST') {
    return mutate(ctx, 'admin.engineering.export',
      'Administration is scaffold-only: no issue was exported and no state changed.');
  }
  if (path === '/api/admin/v1/engineering/assignments' && method === 'POST') {
    return mutate(ctx, 'admin.engineering.assign',
      'Administration is scaffold-only: no coding assignment was created and no state changed.');
  }
  {
    const m = new RegExp(`^/api/admin/v1/operations/alerts/${ID_PATTERN}/acknowledgements$`).exec(path);
    if (m && method === 'POST') return mutate(ctx, 'admin.operations.alerts.acknowledge');
  }
  // Authorization precedes routing: even unknown admin paths answer 401/403
  // to unauthorized callers, so path existence is not an oracle.
  const gate = await requireAdmin(ctx, 'admin.status');
  if (gate.status) return send(ctx, gate.status, gate.body);
  // DGM fixture preview (flag-gated, dark by default). requireAdmin is
  // passed through the context so the preview router needs no import cycle.
  if (path === '/api/admin/v1/dgm/preview/status' || path.startsWith('/api/admin/v1/dgm/preview/')) {
    const out = await handleDgmPreview({ ...ctx, requireAdmin: (permission) => requireAdmin(ctx, permission) });
    if (out) return out;
  }
  return send(ctx, 404, { error: 'Unknown admin route.', code: 'NOT_FOUND' });
}
