/* Built with Meta Muse. */
// Milestone 1 directory and session inventory (PRD ACC01, ACC13): approved
// minimal identity projections for account selection, kept in an API,
// datastore projection, and cache separate from analytics. Only allowlisted
// columns are ever selected: session tokens, password hashes, provider
// credentials, IP addresses, and user-agent strings are never read into
// these responses, so they cannot leak through errors, logs, or exports.
//
// A valid unexpired session means the user could authenticate; it does not
// prove the person is online. There is no approved presence signal, so
// presence is honestly always `unknown` with reason `no_presence_signal`
// (never a fabricated online count, never per-user traffic analytics).
//
// No mutation lives here: suspension, restoration, revocation, replacement,
// and recovery stay 501 in src/admin/router.mjs. This file only reads.

import { pageQuery } from '../lib/store.js';

export const USERS_SCHEMA_VERSION = 'admin.access.users.v1';
export const SESSIONS_SCHEMA_VERSION = 'admin.access.sessions.v1';

// Mirror of the recognized roles in src/admin/router.mjs (which owns
// authorization). Only these roles are disclosed as live admin roles; an
// unknown stored value authorizes nothing and is not reported as a grant.
const RECOGNIZED_ROLES = new Set([
  'operations_observer',
  'access_administrator',
  'security_reviewer',
  'support_triager',
  'engineering_reviewer',
  'role_grant_authority',
]);

// Same conservative id shape the rest of the admin router accepts for path
// ids. Rows whose id is unusable are skipped but still count in total.
const SAFE_ID = /^[A-Za-z0-9_-]{1,127}$/;

// Same canonical-UTC rule as the grant ladder (and audit-read.mjs): a stored
// value that only looks like a timestamp is reported unknown, never rendered.
const CANONICAL_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

function liveGrant(row, nowMs) {
  if (!row || row.revoked_at !== null && row.revoked_at !== undefined) return false;
  if (row.scope !== 'platform' || !RECOGNIZED_ROLES.has(row.role)) return false;
  const exp = row.expires_at;
  if (exp === null || exp === undefined) return true;
  if (typeof exp !== 'string' || !CANONICAL_UTC.test(exp)) return false;
  const ms = Date.parse(exp);
  if (!Number.isFinite(ms)) return false;
  const roundTrip = new Date(ms).toISOString();
  if (roundTrip !== exp && roundTrip !== exp.replace('Z', '.000Z')) return false;
  return ms > nowMs;
}

function safeInstant(value) {
  return typeof value === 'string' && CANONICAL_UTC.test(value) && Number.isFinite(Date.parse(value))
    ? value
    : null;
}

export async function readUsers(db, { limit, offset } = {}, nowMs = Date.now()) {
  const observedAt = new Date(Number.isFinite(nowMs) ? nowMs : Date.now()).toISOString();
  const at = Number.isFinite(nowMs) ? nowMs : Date.now();
  const pageLimit = Number.isSafeInteger(limit) && limit > 0 ? limit : 20;
  const pageOffset = Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
  try {
    const nowIso = new Date(at).toISOString();
    const page = await pageQuery(db, {
      select: 'SELECT id, name, email, demo, disabled',
      from: 'FROM "user"',
      order: 'ORDER BY id ASC',
      limit: pageLimit,
      offset: pageOffset,
    });
    const items = [];
    for (const raw of page.items || []) {
      if (!raw || typeof raw.id !== 'string' || !SAFE_ID.test(raw.id)) continue;
      // One account row per provider at most in practice; prefer a provider
      // login over a local credential when both exist.
      let provider = 'unknown';
      try {
        const accts = await db.prepare(
          'SELECT providerId FROM account WHERE userId = ?'
        ).bind(raw.id).all();
        const kinds = new Set((accts.results || []).map((r) => r && r.providerId));
        if (kinds.has('github')) provider = 'github';
        else if (kinds.has('credential')) provider = 'credential';
      } catch {
        provider = 'unknown';
      }
      // A failed per-row read is unknown, never a measured value: null
      // counts/roles must never be coerced to 0 or [] (PRD Section 10.1).
      const isDemo = Number(raw.demo) === 1;
      let adminRoles = null;
      try {
        const grants = await db.prepare(
          "SELECT role, scope, expires_at, revoked_at FROM admin_grants WHERE user_id = ? AND revoked_at IS NULL"
        ).bind(raw.id).all();
        adminRoles = (grants.results || [])
          .filter((g) => liveGrant(g, at))
          .map((g) => g.role)
          .sort();
      } catch {
        adminRoles = null;
      }
      // The demo tenant never administers (requireAdmin denies every demo
      // caller), so a stored grant row for a demo user is not an
      // exercisable role and must not be displayed as one.
      if (isDemo) adminRoles = null;
      let keysActive = null;
      try {
        const k = await db.prepare(
          'SELECT COUNT(*) AS n FROM key_verifiers WHERE owner_id = ? AND revoked_at IS NULL'
        ).bind(raw.id).first();
        keysActive = k && Number.isSafeInteger(k.n) && k.n >= 0 ? k.n : null;
      } catch {
        keysActive = null;
      }
      let sessionsActive = null;
      try {
        const s = await db.prepare(
          'SELECT COUNT(*) AS n FROM session WHERE userId = ? AND datetime(expiresAt) IS NOT NULL AND expiresAt > ?'
        ).bind(raw.id, nowIso).first();
        sessionsActive = s && Number.isSafeInteger(s.n) && s.n >= 0 ? s.n : null;
      } catch {
        sessionsActive = null;
      }
      items.push({
        id: raw.id,
        name: typeof raw.name === 'string' ? raw.name : null,
        email: typeof raw.email === 'string' ? raw.email : null,
        provider,
        status: Number(raw.disabled) === 1 ? 'suspended' : 'active',
        tenant: isDemo ? 'demo' : 'platform',
        admin_roles: adminRoles,
        keys_active: keysActive,
        sessions_active: sessionsActive,
      });
    }
    return {
      schema_version: USERS_SCHEMA_VERSION,
      state: 'available',
      observed_at: observedAt,
      items,
      total: Number.isSafeInteger(page.total) ? page.total : null,
      limit: Number.isSafeInteger(page.limit) ? page.limit : pageLimit,
      offset: Number.isSafeInteger(page.offset) ? page.offset : pageOffset,
    };
  } catch {
    return {
      schema_version: USERS_SCHEMA_VERSION,
      state: 'unavailable',
      reason_code: 'directory_unavailable',
      observed_at: null,
      items: [],
      total: null,
      limit: pageLimit,
      offset: pageOffset,
    };
  }
}

export async function readSessions(db, { limit, offset } = {}, nowMs = Date.now()) {
  const observedAt = new Date(Number.isFinite(nowMs) ? nowMs : Date.now()).toISOString();
  const at = Number.isFinite(nowMs) ? nowMs : Date.now();
  const pageLimit = Number.isSafeInteger(limit) && limit > 0 ? limit : 20;
  const pageOffset = Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
  try {
    // Only safe references are selected: never token, ipAddress, or
    // userAgent. Those columns stay out of the query, not just the output.
    const page = await pageQuery(db, {
      select: 'SELECT id, userId, createdAt, expiresAt',
      from: 'FROM session',
      order: 'ORDER BY expiresAt DESC, id ASC',
      limit: pageLimit,
      offset: pageOffset,
    });
    const items = [];
    for (const raw of page.items || []) {
      if (!raw || typeof raw.id !== 'string' || !SAFE_ID.test(raw.id)) continue;
      const exp = safeInstant(raw.expiresAt);
      items.push({
        id: raw.id,
        user_id: typeof raw.userId === 'string' ? raw.userId : null,
        issued_at: safeInstant(raw.createdAt),
        expires_at: exp,
        active: exp !== null && Date.parse(exp) > at,
        // PRD ACC13 asks for the authentication method. The session table
        // records no method, so the field is declared and null — never
        // inferred from provider or session shape.
        authentication_method: null,
        presence: 'unknown',
        presence_reason: 'no_presence_signal',
      });
    }
    return {
      schema_version: SESSIONS_SCHEMA_VERSION,
      state: 'available',
      observed_at: observedAt,
      items,
      total: Number.isSafeInteger(page.total) ? page.total : null,
      limit: Number.isSafeInteger(page.limit) ? page.limit : pageLimit,
      offset: Number.isSafeInteger(page.offset) ? page.offset : pageOffset,
    };
  } catch {
    return {
      schema_version: SESSIONS_SCHEMA_VERSION,
      state: 'unavailable',
      reason_code: 'sessions_unavailable',
      observed_at: null,
      items: [],
      total: null,
      limit: pageLimit,
      offset: pageOffset,
    };
  }
}
