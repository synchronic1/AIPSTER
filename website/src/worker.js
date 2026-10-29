/* Built with Meta Muse. */
// AIPSTER apex Worker: same-origin control-panel API + /app UI on top of the
// existing static site. Routing: /api/auth/* -> Better Auth, /api/* -> JSON
// API (errors always JSON, never the static 404 page), /app* -> panel assets,
// everything else -> ASSETS (landing page preserved byte-for-byte).
import { createAuth, oauthConfigured, sessionUser } from './lib/auth.js';
import { all, first, run, pageQuery, cardFor, mapGrant, mapKey, mapJob, mapUsage, audit, rid, nowIso } from './lib/store.js';
import { mintKey, verifierFor, publicKey, splitPresented, timingSafeEqualStr, KEY_PREFIX, DEMO_KEY_PREFIX } from './lib/keys.js';
import { readJson, readBodyBytes, isId, isName, isScope, isEmail, pagination, httpError, normalizePairCode, PAIR_CODE_ALPHABET } from './lib/validate.js';
import { checkWriteBudget, assertClaimed, budgetWindow, WRITE_BUDGET_PER_HOUR, MAX_RESOURCES_PER_USER, MAX_KEYS_PER_USER, MAX_GRANTS_PER_USER, heartbeatBudgets, heartbeatWindow, HEARTBEAT_CAPS_SQL, heartbeatCounterStatements, pruneHeartbeatBuckets, heartbeatBucketCount, secondsUntilNextHour, HEARTBEAT_GLOBAL_ID } from './lib/quotas.js';
import { handleFabric, federationEnabled } from './fabric/router.mjs';
import { schemaReady } from './lib/schema.js';
import { buildStatus, MAX_STATUS_ITEMS, STALE_AFTER_MS } from './lib/status.mjs';

const VERSION = '0.4.0';
const CSRF_HEADER = 'X-Aipster-CSRF';
const APP_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

let cachedAuth = null;
function authFor(env) {
  if (!cachedAuth || cachedAuth.db !== env.DB || cachedAuth.key !== (env.BETTER_AUTH_SECRET || '') + '|' + (env.BETTER_AUTH_URL || '')) {
    cachedAuth = { db: env.DB, key: (env.BETTER_AUTH_SECRET || '') + '|' + (env.BETTER_AUTH_URL || ''), auth: createAuth(env) };
  }
  return cachedAuth.auth;
}

function baseHeaders() {
  return { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()' };
}

function json(status, obj, extra) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...baseHeaders(), 'Content-Type': 'application/json', ...(extra || {}) }
  });
}

function sameOrigin(request) {
  const origin = request.headers.get('Origin');
  const referer = request.headers.get('Referer');
  if (!origin && !referer) return true;
  const self = new URL(request.url).origin;
  if (origin) return origin === self;
  try { return new URL(referer).origin === self; } catch { return false; }
}

const AUTH_BODY_MAX = 64 * 1024;
// Heartbeat intake bounds (docs/heartbeat-intake.md): the strict
// {"usable": boolean} body is capped at 1 KiB, and at most one accepted
// heartbeat per resource per 25s window keeps sparse owner-pushed updates
// from becoming a write amplifier. The window is enforced inside the atomic
// intake UPDATE, never by a read-then-write.
const HEARTBEAT_BODY_MAX = 1024;
const HEARTBEAT_MIN_INTERVAL_MS = 25 * 1000;
// Pairing bounds (docs/pairing.md): small claim bodies, few live codes per
// owner, few guesses per code (burned after), and a short reclaim window in
// which the same node may re-bind a spent code after a lost response.
const PAIRING_BODY_MAX = 4 * 1024;
const MAX_ACTIVE_PAIRING_CODES = 5;
const MAX_PAIRING_ATTEMPTS = 10;
const PAIRING_RECLAIM_MS = 10 * 60 * 1000;
// POST /api/inventory Idempotency-Key replay horizon.
const IDEMPOTENCY_TTL_MS = 24 * 3600 * 1000;
// Compatibility grace for NULL claims written by the pre-atomic registration path.
const IDEMPOTENT_IN_FLIGHT_MS = 5 * 60 * 1000;
// Demo auth surface (allowlist): the only /api/auth/* routes a demo session
// may use are sign-in (both maintained paths), sign-out, and session reads.
// Everything else — update-user, change-password, link-social, password
// reset, token refresh, account management — is owner-managed or unused, so
// a closed-by-default list keeps future self-service routes from slipping
// through. Verified against better-auth 1.7.14 route sources.
const DEMO_ALLOWED_AUTH = new Set(['/api/auth/sign-in/username', '/api/auth/sign-in/email', '/api/auth/sign-out', '/api/auth/get-session']);
// A disabled account may only end sessions, never read or mutate auth state.
const DISABLED_ALLOWED_AUTH = new Set(['/api/auth/sign-out', '/api/auth/revoke-session', '/api/auth/revoke-sessions', '/api/auth/revoke-other-sessions']);
// Auth mutation budget: these maintained Better Auth routes mutate
// user/credential/account rows for the CALLER, so an authenticated caller
// is charged the same hourly write budget as app mutations (the PR11
// independent review caught update-user bypassing it: 200 + row writes
// at a spent budget). All six take POST (verified in 1.7.14 sources).
// Deliberately NOT billed: sign-out, session revocation, and
// unlink-account (security-reducing; must work at exhaustion — unlink
// cannot be spammed without re-linking, which IS billed), plus reads,
// unauthenticated login/registration/recovery flows, and library-managed
// session upkeep. Verified against better-auth 1.7.14 route sources
// (dist/api/routes/*.mjs).
const BUDGETED_AUTH_POST_ROUTES = new Set(['/api/auth/update-user', '/api/auth/change-email', '/api/auth/change-password', '/api/auth/delete-user', '/api/auth/update-session', '/api/auth/link-social']);

function canonicalOrigin(env) {
  const raw = (env && env.BETTER_AUTH_URL) || '';
  if (!raw.startsWith('https://')) return null; // http is local-dev only: no host pinning
  try { return new URL(raw).origin; } catch { return null; }
}

function wrongHost(env, origin) {
  const canon = canonicalOrigin(env);
  if (!canon) return false;
  return origin !== canon;
}

async function actorFrom(request, env, auth) {
  // Session cookie wins when valid; otherwise a Bearer [REDACTED] API key. Never mixed.
  // Disabled accounts authorize nothing: existing sessions and keys go dead for
  // API calls immediately (new sessions are blocked by the session-create hook).
  const found = await sessionUser(auth, request);
  if (found) {
    if (Number(found.user && found.user.disabled) === 1) return { kind: 'none' };
    return { kind: 'session', user: found.user };
  }
  const header = request.headers.get('Authorization') || '';
  const m = /^Bearer\s+(\S+)$/.exec(header);
  if (m) {
    const parts = splitPresented(m[1]);
    if (parts) {
      const row = await first(env.DB, 'SELECT * FROM key_verifiers WHERE id = ? AND revoked_at IS NULL', parts.id);
      if (row) {
        const expect = await verifierFor(parts.secret, row.salt);
        if (timingSafeEqualStr(expect, row.verifier)) {
          if (row.expires_at && Date.parse(row.expires_at) < Date.now()) return { kind: 'expired' };
          const user = await first(env.DB, 'SELECT id, name, email, username, demo, disabled FROM "user" WHERE id = ?', row.owner_id);
          if (user && Number(user.disabled) !== 1) {
            await run(env.DB, 'UPDATE key_verifiers SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)',
              nowIso(), row.id, new Date(Date.now() - 3600 * 1000).toISOString());
            return { kind: 'key', user, key: row };
          }
        }
      }
    }
    return { kind: 'invalid-key' };
  }
  return { kind: 'none' };
}

async function canUseResource(db, userId, resource) {
  if (resource.owner_id === userId) return { ok: true, grantId: null, grant: null };
  const g = await first(db, 'SELECT * FROM grants WHERE resource_id = ? AND grantee_id = ? AND revoked_at IS NULL', resource.id, userId);
  if (!g) return { ok: false, reason: 'No grant gives you access to this resource.' };
  if (!(await grantPartiesSameSide(db, g))) return { ok: false, reason: 'No grant gives you access to this resource.' };
  if (g.used_jobs >= g.max_jobs) return { ok: false, reason: 'Grant job quota exhausted.' };
  if (g.used_tokens >= g.max_tokens) return { ok: false, reason: 'Grant token quota exhausted.' };
  return { ok: true, grantId: g.id, grant: g };
}

async function grantPartiesSameSide(db, grant) {
  // Grants never cross the demo sandbox boundary in either direction, and
  // legacy/stale cross-boundary rows authorize nothing.
  const o = await first(db, 'SELECT demo FROM "user" WHERE id = ?', grant.owner_id);
  const g = await first(db, 'SELECT demo FROM "user" WHERE id = ?', grant.grantee_id);
  if (!o || !g) return false;
  return Number(o.demo || 0) === Number(g.demo || 0);
}

async function ownerName(db, userId) {
  const u = await first(db, 'SELECT name FROM "user" WHERE id = ?', userId);
  return (u && u.name) || 'Unknown';
}

async function revokedHeartbeatKey(request, db) {
  // The heartbeat endpoint reports a revoked key distinctly (401
  // KEY_REVOKED) instead of the generic 401, so honest senders can tell
  // "rotate and re-mint" apart from "wrong credential". The presented
  // secret is verified against the key's verifier BEFORE the revoked state
  // is disclosed: any other caller gets the generic 401 AUTH_REQUIRED, so
  // the key id alone is not a revocation oracle.
  const header = request.headers.get('Authorization') || '';
  const m = /^Bearer\s+(\S+)$/.exec(header);
  if (!m) return false;
  const parts = splitPresented(m[1]);
  if (!parts) return false;
  const row = await first(db, 'SELECT verifier, salt, revoked_at FROM key_verifiers WHERE id = ?', parts.id);
  if (!row || !row.revoked_at) return false;
  const expect = await verifierFor(parts.secret, row.salt);
  return timingSafeEqualStr(expect, row.verifier);
}

async function handleApi(request, env, url) {
  const path = url.pathname;
  const method = request.method;
  // Canonical-host guard: with an https BETTER_AUTH_URL configured, the API
  // (auth, app, health) answers only on that origin. Public-asset behavior
  // on other hosts is unchanged; local http dev skips pinning.
  if (wrongHost(env, url.origin)) {
    return json(403, { error: 'This host does not serve the API.', code: 'WRONG_HOST' });
  }
  if (path === '/api/health' && method === 'GET') {
    // Readiness probes the schema: a bound but unmigrated DB is not ready.
    // Booleans only; no lengths, names, or error strings leave this endpoint.
    const hasDb = !!env.DB;
    const secretOk = (env.BETTER_AUTH_SECRET || '').length >= 32;
    const urlOk = !!env.BETTER_AUTH_URL;
    const schemaOk = hasDb && await schemaReady(env.DB, federationEnabled(env));
    const authConfigured = hasDb && secretOk && urlOk;
    return json(200, {
      ok: true, app: 'aipster-app', version: VERSION,
      auth_configured: authConfigured, ready: authConfigured && schemaOk,
      detail: { db: hasDb, secret: secretOk, url: urlOk, schema: schemaOk, oauth: oauthConfigured(env) }
    });
  }
  let auth;
  try {
    auth = authFor(env);
  } catch (error) {
    return json(500, { error: 'Authentication is not configured.', code: 'CONFIG' });
  }
  if (path === '/api/auth/sign-in/social' || path === '/api/auth/callback/github') {
    if (!oauthConfigured(env)) return json(503, { error: 'GitHub sign-in is not configured.', code: 'OAUTH_UNCONFIGURED' });
  }
  if (path.startsWith('/api/auth/')) {
    // Every auth request body is streamed through the byte cap first:
    // better-auth parses bodies itself, and Content-Length is absent on
    // chunked uploads and unset by several clients, so a header precheck is
    // not enforcement. Within-cap bodies are buffered and forwarded.
    let forwarded = request;
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      const bytes = await readBodyBytes(request, AUTH_BODY_MAX);
      // Preserve bodiless pass-through exactly: attaching an empty body
      // would trip the library's content-type requirement on bodyless posts.
      const init = { method, headers: request.headers };
      if (bytes.byteLength > 0) init.body = bytes;
      forwarded = new Request(request.url, init);
    }
    // Session-aware endpoint guard: the maintained auth routes bypass the app
    // actor checks, so demo/disabled boundaries are enforced here instead.
    const found = await sessionUser(auth, request);
    if (found && found.user) {
      const demo = Number(found.user.demo) === 1;
      const disabled = Number(found.user.disabled) === 1;
      if (disabled && !DISABLED_ALLOWED_AUTH.has(path)) {
        return json(401, { error: 'Sign-in required.', code: 'AUTH_REQUIRED' });
      }
      if (!disabled && demo && !DEMO_ALLOWED_AUTH.has(path)) {
        return json(403, { error: 'This auth endpoint is not available to the demo account.', code: 'DEMO_RESTRICTED' });
      }
      // Authenticated profile/credential mutations consume the hourly
      // write budget, exactly like app mutations — but only on POST and
      // only same-origin. Billing bare GETs would let cross-site
      // top-level navigations (SameSite=Lax carries the cookie) drain the
      // victim's budget with no mutation; billing cross-origin POSTs
      // would do the same one claim at a time. Cross-origin POSTs still
      // fail: better-auth's own origin check (trustedOrigins) rejects
      // them after we decline to bill. delete-user/callback (a GET) is
      // deliberately unbilled: fake tokens write nothing, and a valid
      // single-use token completes at most once per billed delete-user
      // initiation — billing the completion too would only reopen a
      // fake-token drain with no accounting benefit.
      if (!disabled && found.user && method === 'POST' && BUDGETED_AUTH_POST_ROUTES.has(path) && sameOrigin(request)) {
        await checkWriteBudget(env.DB, found.user.id);
      }
    }
    return auth.handler(forwarded);
  }

  const actor = await actorFrom(request, env, auth);
  const needSession = () => {
    if (actor.kind === 'key') return json(403, { error: 'API keys cannot use this management endpoint. Sign in instead.', code: 'KEY_FORBIDDEN' });
    if (actor.kind !== 'session') return json(401, { error: 'Sign-in required.', code: 'AUTH_REQUIRED' });
    return null;
  };
  const needCsrf = () => {
    if (request.headers.get(CSRF_HEADER) !== '1' || !sameOrigin(request)) {
      return json(403, { error: 'Missing or invalid CSRF protection.', code: 'CSRF_REQUIRED' });
    }
    return null;
  };
  const needAuthz = (scope = 'read') => {
    if (actor.kind === 'session') return null;
    if (actor.kind === 'key') {
      // Least privilege: a heartbeat-scoped key authorizes its own heartbeat
      // endpoint only. It fails every needAuthz check, closing the
      // any-key-passes-read shape for this scope.
      if (actor.key.scope === 'heartbeat') return json(403, { error: 'This API key is heartbeat-scoped; it can only post heartbeats.', code: 'KEY_SCOPE' });
      if (actor.key.scope === 'inference' || scope === 'read') return null;
      return json(403, { error: 'This API key is read-scoped; inference scope required.', code: 'KEY_SCOPE' });
    }
    if (actor.kind === 'expired') return json(401, { error: 'API key expired.', code: 'KEY_EXPIRED' });
    return json(401, { error: 'Sign-in or API key required.', code: 'AUTH_REQUIRED' });
  };
  const deny = (r) => r;
  const db = env.DB;
  const me = () => actor.user.id;
  // Demo workspace: user.demo = 1 marks the seeded demo tenant. Same sessions,
  // CSRF, and authorization as every user, plus sandbox restrictions below.
  const isDemo = () => !!actor.user && Number(actor.user.demo) === 1;
  const needNotDemo = () => isDemo()
    ? json(403, { error: 'The demo account cannot perform this action.', code: 'DEMO_RESTRICTED' })
    : null;

  // ---- inventory ----
  if (path === '/api/inventory' && method === 'GET') {
    const d = needAuthz('read'); if (d) return deny(d);
    const q = pagination(url);
    const page = await pageQuery(db, { select: 'SELECT *', from: 'FROM resources WHERE owner_id = ?', params: [me()], order: 'ORDER BY created_at DESC', ...q });
    const cards = [];
    for (const r of page.items) cards.push(cardFor(r, await ownerName(db, r.owner_id)));
    return json(200, { ...page, items: cards });
  }
  if (path === '/api/inventory' && method === 'POST') {
    const d = needSession() || needCsrf(); if (d) return deny(d);
    // Replay safety (migration 0015): a client-supplied Idempotency-Key
    // makes retries return the original card instead of a duplicate row.
    // Mapping, resource, budget and audit commit together. Concurrent losers
    // replay the winner; deleted-resource mappings provision a fresh identity.
    const idemKey = request.headers.get('Idempotency-Key');
    if (idemKey !== null && !isId(idemKey)) return json(400, { error: 'Idempotency-Key must be 1..64 id chars.', code: 'BAD_IDEMPOTENCY' });
    const body = await readJson(request);
    if (!isName(body.name)) return json(400, { error: 'Name is required (1..80 chars).', code: 'BAD_NAME' });
    const kind = ['local', 'cluster', 'provider'].includes(body.kind) ? body.kind : 'local';
    const origin = typeof body.origin === 'string' ? body.origin.slice(0, 80) : 'declared';
    const registered = await registerResource(db, me(), idemKey, body, kind, origin);
    return json(registered.created ? 201 : 200, cardFor(registered.row, await ownerName(db, me())));
  }
  {
    const m = /^\/api\/inventory\/([A-Za-z0-9_-]{1,64})$/.exec(path);
    if (m && method === 'GET') {
      const d = needAuthz('read'); if (d) return deny(d);
      const r = await first(db, 'SELECT * FROM resources WHERE id = ?', m[1]);
      if (!r) return json(404, { error: 'Resource not found or not shared with you.', code: 'NOT_FOUND' });
      if (r.owner_id !== me()) {
        const g = await first(db, 'SELECT * FROM grants WHERE resource_id = ? AND grantee_id = ? AND revoked_at IS NULL', r.id, me());
        if (!g || !(await grantPartiesSameSide(db, g))) return json(404, { error: 'Resource not found or not shared with you.', code: 'NOT_FOUND' });
      }
      return json(200, cardFor(r, await ownerName(db, r.owner_id)));
    }
  }
  {
    const m = /^\/api\/inventory\/([A-Za-z0-9_-]{1,64})$/.exec(path);
    if (m && method === 'DELETE') {
      const d = needSession() || needCsrf(); if (d) return deny(d);
      const r = await first(db, 'SELECT id FROM resources WHERE id = ? AND owner_id = ?', m[1], me());
      if (!r) return json(404, { error: 'Resource not found or not yours.', code: 'NOT_FOUND' });
      // Unbilled like key/grant revocation: teardown must work at a spent
      // budget. Bound keys keep revoked rows with the binding nulled, so a
      // deleted resource's sender key still reads KEY_REVOKED (rotate, not
      // wrong credential) instead of vanishing into AUTH_REQUIRED. Grants
      // and jobs cannot dangle (NOT NULL references), so their rows are
      // deleted; the audit trail (grant.create, resource.delete) records
      // what existed. Pairing claims keep their history with resource_id
      // nulled, which the reclaim path treats as invalid. The heartbeat
      // intake's row-existence check rejects further beats either way.
      const now = nowIso();
      const owned = `EXISTS(SELECT 1 FROM resources r JOIN "user" u ON u.id = r.owner_id WHERE r.id = ? AND r.owner_id = ? AND u.disabled = 0)`;
      const deleted = await db.batch([
        db.prepare(`DELETE FROM jobs WHERE (resource_id = ? OR grant_id IN (SELECT id FROM grants WHERE resource_id = ?)) AND ${owned}`).bind(r.id, r.id, r.id, me()),
        db.prepare(`DELETE FROM grants WHERE resource_id = ? AND ${owned}`).bind(r.id, r.id, me()),
        db.prepare(`UPDATE key_verifiers SET revoked_at = COALESCE(revoked_at, ?), resource_id = NULL WHERE resource_id = ? AND ${owned}`).bind(now, r.id, r.id, me()),
        db.prepare(`UPDATE pairing_codes SET resource_id = NULL WHERE resource_id = ? AND ${owned}`).bind(r.id, r.id, me()),
        db.prepare(`DELETE FROM idempotency_keys WHERE resource_id = ? AND ${owned}`).bind(r.id, r.id, me()),
        db.prepare(`DELETE FROM resources WHERE id = ? AND owner_id = ? AND EXISTS(SELECT 1 FROM "user" WHERE id = ? AND disabled = 0)`).bind(r.id, me(), me()),
        db.prepare(`INSERT INTO audit (id, at, actor_id, action, target, detail) SELECT ?, ?, ?, 'resource.delete', ?, '' WHERE changes() = 1`).bind(rid('a_'), now, me(), r.id)
      ]);
      if (Number(deleted[5].meta.changes) !== 1) return json(404, { error: 'Resource not found or not yours.', code: 'NOT_FOUND' });
      return json(200, { ok: true });
    }
  }

  // ---- heartbeat intake (owner-confined, key-only) ----
  // Contract: docs/heartbeat-intake.md. A heartbeat proves reachability
  // only, never inference acceptance. Auth is API-key ONLY: session cookies
  // are rejected before any CSRF check, so this endpoint has no CSRF
  // surface. The key must be heartbeat-scoped and bound to this exact
  // resource (migration 0013). Every intake check — row existence
  // (not-deleted), key-owner ownership, owner not disabled (0004), binding
  // match + key live (not revoked/expired), and the 25s rate window — lives
  // inside ONE conditional UPDATE, never a read-then-write. The server sets
  // heartbeat_at=now and online=1 plus the body's usable bit; no other
  // columns change. Heartbeats never draw the hourly write_budget (they
  // are charged to separate per-owner + global heartbeat budgets in the same
  // atomic batch as the resource UPDATE; a rejected heartbeat writes nothing). Aggregate ceilings, 429
  // codes, and the D1 write-cost calculation live in
  // docs/heartbeat-quotas.md.
  {
    const m = /^\/api\/resources\/([A-Za-z0-9_-]{1,64})\/heartbeat$/.exec(path);
    if (m && method === 'POST') {
      const resourceId = m[1];
      if (actor.kind === 'session') return json(403, { error: 'Heartbeats require a heartbeat-scoped API key; sessions cannot post heartbeats.', code: 'KEY_REQUIRED' });
      if (actor.kind === 'expired') return json(401, { error: 'API key expired.', code: 'KEY_EXPIRED' });
      if (actor.kind !== 'key') {
        if (await revokedHeartbeatKey(request, db)) return json(401, { error: 'API key revoked.', code: 'KEY_REVOKED' });
        return json(401, { error: 'Heartbeat API key required.', code: 'AUTH_REQUIRED' });
      }
      if (actor.key.scope !== 'heartbeat') return json(403, { error: 'This API key is not heartbeat-scoped.', code: 'KEY_SCOPE' });
      if (actor.key.resource_id !== resourceId) return json(404, { error: 'Resource not found or not yours.', code: 'NOT_FOUND' });
      // Strict body: exactly {"usable": boolean} within 1 KiB. Unknown
      // fields, client timestamps, and any other shape are rejected; the
      // server is the only writer of heartbeat_at/online/usable.
      let usable;
      try {
        const raw = new TextDecoder().decode(await readBodyBytes(request, HEARTBEAT_BODY_MAX));
        let data = null;
        try { data = JSON.parse(raw || 'null'); } catch { data = null; }
        const keys = data && typeof data === 'object' && !Array.isArray(data) ? Object.keys(data) : null;
        if (!keys || keys.length !== 1 || keys[0] !== 'usable' || typeof data.usable !== 'boolean') {
          return json(400, { error: 'Body must be exactly {"usable": boolean}.', code: 'BAD_HEARTBEAT' });
        }
        usable = data.usable ? 1 : 0;
      } catch (error) {
        if (error && error.status) return json(error.status, { error: error.message, code: error.code || 'BAD_REQUEST' });
        throw error;
      }
      // Fast path: a closed 25s window rejects before any budget write.
      // This probe is an optimization only — the conditional UPDATE below
      // still enforces the window atomically, so racers cannot slip through.
      const probe = await first(db, 'SELECT heartbeat_at FROM resources WHERE id = ?', resourceId);
      if (probe && probe.heartbeat_at) {
        const last = Date.parse(probe.heartbeat_at);
        if (Number.isFinite(last)) {
          const retryMs = HEARTBEAT_MIN_INTERVAL_MS - (Date.now() - last);
          if (retryMs > 0) {
            const retrySec = Math.ceil(retryMs / 1000);
            return json(429, { error: 'Heartbeat too soon; back off and retry.', code: 'HEARTBEAT_TOO_SOON', retryAfterSec: retrySec }, { 'Retry-After': String(retrySec) });
          }
        }
      }
      // Aggregate ceilings (docs/heartbeat-quotas.md). Read-only fast paths
      // first: a spent global or owner bucket rejects before any write.
      // Admission is then ONE batch: the resource UPDATE carries every
      // intake check plus both cap checks, and the owner and global counter
      // upserts each run only if the statement before changed one row. The
      // batch is a transaction, so racers serialize: an accepted heartbeat
      // moves the resource row and both counters by exactly one, and every
      // loser (cap, window, key, owner or resource) writes zero rows. There
      // is no claim to refund.
      const budgets = heartbeatBudgets(env);
      const hbWindow = heartbeatWindow();
      const quotaSpent = (code, error) => {
        const retrySec = secondsUntilNextHour();
        return json(429, { error, code, retryAfterSec: retrySec }, { 'Retry-After': String(retrySec) });
      };
      const globalSpent = () => quotaSpent('HEARTBEAT_GLOBAL_QUOTA', 'Deployment heartbeat budget is spent for the hour; back off and retry.');
      const ownerSpent = () => quotaSpent('HEARTBEAT_OWNER_QUOTA', 'Heartbeat budget for this owner is spent for the hour; back off and retry.');
      const globalCount = await heartbeatBucketCount(db, HEARTBEAT_GLOBAL_ID, hbWindow);
      if (globalCount !== null && globalCount >= budgets.global) return globalSpent();
      if ((await heartbeatBucketCount(db, actor.key.owner_id, hbWindow) ?? 0) >= budgets.owner) return ownerSpent();
      if (globalCount === null) await pruneHeartbeatBuckets(db, hbWindow);
      const now = nowIso();
      // Boundary: a beat exactly one interval old is admitted. The fast path
      // and the retry calculation treat retryMs = 0 as "no wait needed", so
      // the atomic UPDATE must admit there too; a strict `<` rejected it and
      // the classifier, finding no remaining delay, fell through to 404.
      const windowStart = new Date(Date.now() - HEARTBEAT_MIN_INTERVAL_MS).toISOString();
      const [claimed, ownerCharge, globalCharge] = await db.batch([
        db.prepare(
          `UPDATE resources SET heartbeat_at = ?, online = 1, usable = ?
           WHERE id = ?
             AND owner_id = ?
             AND (heartbeat_at IS NULL OR heartbeat_at <= ?)
             AND EXISTS (SELECT 1 FROM "user" u WHERE u.id = resources.owner_id AND COALESCE(u.disabled, 0) != 1)
             AND EXISTS (SELECT 1 FROM key_verifiers k WHERE k.id = ? AND k.resource_id = ? AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at >= ?))
             AND ${HEARTBEAT_CAPS_SQL}`)
          .bind(now, usable, resourceId, actor.key.owner_id, windowStart, actor.key.id, resourceId, now,
            actor.key.owner_id, hbWindow, budgets.owner, hbWindow, budgets.global),
        ...heartbeatCounterStatements(db, actor.key.owner_id, hbWindow),
      ]);
      if (Number(claimed.meta.changes) === 1) {
        // The batch has committed the heartbeat. If a counter upsert did not
        // register its change (local D1 always chains changes(); production
        // D1 is not yet verified), complete the charge rather than leave an
        // accepted heartbeat uncharged. This charges, never refunds.
        const [ownerUpsert, globalUpsert] = heartbeatCounterStatements(db, actor.key.owner_id, hbWindow, { unconditional: true });
        if (Number(ownerCharge.meta.changes) !== 1) await ownerUpsert.run();
        if (Number(globalCharge.meta.changes) !== 1) await globalUpsert.run();
        return json(200, { ok: true, id: resourceId, heartbeatAt: now, online: true, usable: usable === 1 });
      }
      // Admission lost: nothing was written. Map the reason with read-only
      // probes. No audit row per heartbeat; the coarse key last_used_at
      // update in actorFrom is the only trail.
      if ((await heartbeatBucketCount(db, HEARTBEAT_GLOBAL_ID, hbWindow) ?? 0) >= budgets.global) return globalSpent();
      if ((await heartbeatBucketCount(db, actor.key.owner_id, hbWindow) ?? 0) >= budgets.owner) return ownerSpent();
      const keyRow = await first(db, 'SELECT revoked_at, expires_at FROM key_verifiers WHERE id = ?', actor.key.id);
      if (!keyRow || keyRow.revoked_at) return json(401, { error: 'API key revoked.', code: 'KEY_REVOKED' });
      if (keyRow.expires_at && Date.parse(keyRow.expires_at) < Date.now()) return json(401, { error: 'API key expired.', code: 'KEY_EXPIRED' });
      const target = await first(db, 'SELECT owner_id, heartbeat_at FROM resources WHERE id = ?', resourceId);
      if (!target || target.owner_id !== actor.key.owner_id) return json(404, { error: 'Resource not found or not yours.', code: 'NOT_FOUND' });
      const owner = await first(db, 'SELECT disabled FROM "user" WHERE id = ?', target.owner_id);
      if (!owner || Number(owner.disabled) === 1) return json(401, { error: 'Sign-in or API key required.', code: 'AUTH_REQUIRED' });
      const last = target.heartbeat_at ? Date.parse(target.heartbeat_at) : NaN;
      if (Number.isFinite(last)) {
        const retryMs = HEARTBEAT_MIN_INTERVAL_MS - (Date.now() - last);
        if (retryMs > 0) {
          const retrySec = Math.ceil(retryMs / 1000);
          return json(429, { error: 'Heartbeat too soon; back off and retry.', code: 'HEARTBEAT_TOO_SOON', retryAfterSec: retrySec }, { 'Retry-After': String(retrySec) });
        }
      }
      return json(404, { error: 'Resource not found or not yours.', code: 'NOT_FOUND' });
    }
  }

  // ---- status (read-only readiness strip; written only by heartbeat intake) ----
  if (path === '/api/status' && method === 'GET') {
    const d = needAuthz('read'); if (d) return deny(d);
    // Owner-scoped minimal columns only: free-text cpu/gpu/origin/limits and
    // credits stay out of this payload (they can carry private addresses).
    // The 50-item cap applies to the listed page only; the summary counts
    // come from a separate aggregate over ALL owned rows, so summary.total
    // always equals the Overview inventory total. The aggregate mirrors
    // resourceLiveness exactly for ISO heartbeats: online=1 with a missing
    // or unparseable heartbeat is unknown; otherwise fresh (>= cutoff) is
    // online and older is stale; online != 1 is offline.
    const nowMs = Date.now();
    const cutoffIso = new Date(nowMs - STALE_AFTER_MS).toISOString();
    const rows = await all(db,
      'SELECT id, name, kind, online, usable, heartbeat_at FROM resources WHERE owner_id = ? ORDER BY created_at DESC LIMIT ?',
      me(), MAX_STATUS_ITEMS);
    const agg = await first(db,
      `SELECT COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN online = 1 THEN 0 ELSE 1 END), 0) AS offline,
        COALESCE(SUM(CASE WHEN online = 1 AND (heartbeat_at IS NULL OR datetime(heartbeat_at) IS NULL) THEN 1 ELSE 0 END), 0) AS unknown,
        COALESCE(SUM(CASE WHEN online = 1 AND datetime(heartbeat_at) IS NOT NULL AND heartbeat_at >= ? THEN 1 ELSE 0 END), 0) AS online,
        COALESCE(SUM(CASE WHEN online = 1 AND datetime(heartbeat_at) IS NOT NULL AND heartbeat_at < ? THEN 1 ELSE 0 END), 0) AS stale
        FROM resources WHERE owner_id = ?`,
      cutoffIso, cutoffIso, me());
    const shared = await first(db,
      'SELECT COUNT(*) AS n FROM grants g JOIN "user" o ON o.id = g.owner_id JOIN "user" r ON r.id = g.grantee_id WHERE g.grantee_id = ? AND g.revoked_at IS NULL AND o.demo = r.demo',
      me());
    return json(200, buildStatus({
      rows,
      summary: {
        online: Number(agg ? agg.online : 0),
        stale: Number(agg ? agg.stale : 0),
        offline: Number(agg ? agg.offline : 0),
        unknown: Number(agg ? agg.unknown : 0),
      },
      total: Number(agg ? agg.total : 0),
      sharedWithMe: Number(shared ? shared.n : 0),
      demo: isDemo(),
      nowMs,
    }));
  }

  // ---- sharing ----
  if (path === '/api/shared-with-me' && method === 'GET') {
    const d = needAuthz('read'); if (d) return deny(d);
    const q = pagination(url);
    const page = await pageQuery(db, { select: 'SELECT g.*', from: 'FROM grants g JOIN "user" o ON o.id = g.owner_id JOIN "user" r ON r.id = g.grantee_id WHERE g.grantee_id = ? AND g.revoked_at IS NULL AND o.demo = r.demo', params: [me()], order: 'ORDER BY g.created_at DESC', ...q });
    const items = [];
    for (const g of page.items) {
      const r = await first(db, 'SELECT name FROM resources WHERE id = ?', g.resource_id);
      items.push({ ...mapGrantLite(g), resourceName: r ? r.name : '(removed)', ownerName: await ownerName(db, g.owner_id), enforcement: 'recorded', policyNote: 'Inference-only grant recorded by the owner; quotas are checked when dispatch is enabled. Dispatch is currently disabled.' });
    }
    return json(200, { ...page, items });
  }
  if (path === '/api/grants' && method === 'GET') {
    const d = needSession(); if (d) return deny(d);
    const q = pagination(url);
    const page = await pageQuery(db, { select: 'SELECT g.*', from: 'FROM grants g JOIN "user" o ON o.id = g.owner_id JOIN "user" r ON r.id = g.grantee_id WHERE g.owner_id = ? AND o.demo = r.demo', params: [me()], order: 'ORDER BY g.created_at DESC', ...q });
    return json(200, { ...page, items: page.items.map(mapGrantLite) });
  }
  if (path === '/api/grants' && method === 'POST') {
    const d = needSession() || needCsrf() || needNotDemo(); if (d) return deny(d);
    const body = await readJson(request);
    if (!isId(body.resourceId)) return json(400, { error: 'resourceId is required.', code: 'BAD_RESOURCE' });
    const resource = await first(db, 'SELECT * FROM resources WHERE id = ?', body.resourceId);
    if (!resource || resource.owner_id !== me()) return json(404, { error: 'Resource not found or not yours.', code: 'NOT_FOUND' });
    if (!isEmail(body.grantee)) return json(400, { error: 'Grantee must be a registered user email.', code: 'BAD_GRANTEE' });
    const grantee = await first(db, 'SELECT id, email, demo FROM "user" WHERE email = ?', String(body.grantee).trim().toLowerCase());
    if (!grantee) return json(404, { error: 'Grantee user not found.', code: 'USER_NOT_FOUND' });
    if (grantee.id === me()) return json(400, { error: 'Cannot share with yourself.', code: 'SELF_SHARE' });
    if (Number(grantee.demo) === 1) return json(403, { error: 'Grants cannot cross the demo sandbox boundary.', code: 'DEMO_RESTRICTED' });
    const maxJobs = Math.floor(Number(body.maxJobs));
    const maxTokens = Math.floor(Number(body.maxTokens));
    if (!Number.isSafeInteger(maxJobs) || maxJobs < 1 || maxJobs > 10000) return json(400, { error: 'maxJobs must be 1..10000.', code: 'BAD_QUOTA' });
    if (!Number.isSafeInteger(maxTokens) || maxTokens < 100 || maxTokens > 10000000) return json(400, { error: 'maxTokens must be 100..10000000.', code: 'BAD_QUOTA' });
    const existing = await first(db, 'SELECT id FROM grants WHERE resource_id = ? AND grantee_id = ? AND revoked_at IS NULL', resource.id, grantee.id);
    if (existing) return json(409, { error: 'An active grant already exists for this user and resource.', code: 'GRANT_EXISTS' });
    await checkWriteBudget(db, me());
    const id = rid('g_');
    const gc = await run(db, `INSERT INTO grants (id, resource_id, owner_id, grantee_id, max_jobs, max_tokens, used_jobs, used_tokens, inference_only, created_at, revoked_at)
      SELECT ?, ?, ?, ?, ?, ?, 0, 0, 1, ?, NULL WHERE (SELECT COUNT(*) FROM grants WHERE owner_id = ? AND revoked_at IS NULL) < ${MAX_GRANTS_PER_USER}`,
      id, resource.id, me(), grantee.id, maxJobs, maxTokens, nowIso(), me());
    assertClaimed(gc, 'grant');
    await audit(db, me(), 'grant.create', id, `${resource.id} -> ${grantee.email}`);
    return json(201, mapGrantLite(await first(db, 'SELECT * FROM grants WHERE id = ?', id)));
  }
  {
    const m = /^\/api\/grants\/([A-Za-z0-9_-]{1,64})$/.exec(path);
    if (m && method === 'DELETE') {
      const d = needSession() || needCsrf(); if (d) return deny(d);
      const g = await first(db, 'SELECT * FROM grants WHERE id = ? AND owner_id = ?', m[1], me());
      if (!g) return json(404, { error: 'Grant not found or not yours.', code: 'NOT_FOUND' });
      if (g.revoked_at) return json(200, { ok: true });
      await run(db, 'UPDATE grants SET revoked_at = ? WHERE id = ?', nowIso(), g.id);
      await audit(db, me(), 'grant.revoke', g.id);
      return json(200, { ok: true });
    }
  }

  // ---- pairing (one-time worker onboarding; contract: docs/pairing.md) ----
  // A signed-in owner mints a short-lived single-use code in the browser;
  // the worker exchanges it for a resource row plus a resource-bound
  // heartbeat key. The claim endpoint is code-authenticated, never
  // session-authenticated: the worker holds no AIPSTER credential yet, so
  // there is no CSRF surface. Abuse is bounded by 60-bit codes, a short
  // TTL, single use, and a per-code attempt burn.
  if (path === '/api/pairing/codes' && method === 'POST') {
    const d = needSession() || needCsrf() || needNotDemo(); if (d) return deny(d);
    const body = await readJson(request);
    let ttlMin = 10;
    if (body.ttlMinutes !== undefined) {
      if (!Number.isSafeInteger(body.ttlMinutes) || body.ttlMinutes < 1 || body.ttlMinutes > 60) {
        return json(400, { error: 'ttlMinutes must be 1..60.', code: 'BAD_TTL' });
      }
      ttlMin = body.ttlMinutes;
    }
    const minted = mintPairCode();
    const now = nowIso();
    const window = budgetWindow(new Date(now));
    const expiresAt = new Date(Date.now() + ttlMin * 60 * 1000).toISOString();
    const saltBytes = crypto.getRandomValues(new Uint8Array(16));
    const salt = Array.from(saltBytes, (b) => b.toString(16).padStart(2, '0')).join('');
    // Admission, one-time secret verifier and history must commit together:
    // a failed audit cannot strand an undisclosed code or consume its slot.
    const [pc] = await db.batch([
      db.prepare(`INSERT INTO pairing_codes (id, owner_id, salt, verifier, created_at, expires_at, used_at, attempts)
        SELECT ?, ?, ?, ?, ?, ?, NULL, 0
        WHERE EXISTS(SELECT 1 FROM "user" WHERE id=? AND disabled=0 AND demo=0)
        AND (SELECT COUNT(*) FROM pairing_codes WHERE owner_id=? AND used_at IS NULL AND expires_at>=?) < ${MAX_ACTIVE_PAIRING_CODES}
        AND COALESCE((SELECT count FROM write_budget WHERE user_id=? AND window=?),0) < ${WRITE_BUDGET_PER_HOUR}`)
        .bind(minted.id, me(), salt, await verifierFor(minted.secret, salt), now, expiresAt, me(), me(), now, me(), window),
      db.prepare(`INSERT INTO write_budget(user_id,window,count) SELECT ?,?,1 WHERE changes()=1 ON CONFLICT(user_id,window) DO UPDATE SET count=count+1`).bind(me(),window),
      db.prepare(`INSERT INTO audit(id,at,actor_id,action,target,detail) SELECT ?,?,?,'pairing.code.create',?,'' WHERE changes()=1`).bind(rid('a_'),now,me(),minted.id)
    ]);
    if (Number(pc.meta.changes) !== 1) {
      const live = await first(db, 'SELECT disabled,demo FROM "user" WHERE id=?', me());
      if (!live || Number(live.disabled) || Number(live.demo)) throw httpError(401, 'Sign-in required.', 'AUTH_REQUIRED');
      const budget = await first(db, 'SELECT count FROM write_budget WHERE user_id=? AND window=?', me(), window);
      if (budget && budget.count >= WRITE_BUDGET_PER_HOUR) throw httpError(429, 'Too many changes in the last hour. Try again later.', 'WRITE_RATE_LIMITED');
      return json(409, { error: `Too many unused pairing codes (${MAX_ACTIVE_PAIRING_CODES} per user). Let one expire first.`, code: 'PAIRING_LIMIT' });
    }
    return json(201, { id: minted.id, code: minted.code, expiresAt, oneTime: 'This code is shown once. It cannot be recovered.' });
  }
  if (path === '/api/pairing/claim' && method === 'POST') {
    const body = await readJson(request, PAIRING_BODY_MAX);
    const norm = normalizePairCode(body.code);
    if (!norm) return json(400, { error: 'Pairing code shape is invalid.', code: 'BAD_CODE' });
    if (!isId(body.nodeId)) return json(400, { error: 'nodeId is required (1..64 id chars).', code: 'BAD_NODE' });
    const row = await first(db, 'SELECT * FROM pairing_codes WHERE id = ?', norm.id);
    if (!row) return json(404, { error: 'Pairing code invalid or expired.', code: 'PAIRING_INVALID' });
    const ownerId = row.owner_id;
    const nodeId = body.nodeId;
    // The node/code ids are public lookup handles, never credentials. Verify
    // the bearer and current owner before BOTH initial claims and reclaims.
    if (Number(row.attempts) >= MAX_PAIRING_ATTEMPTS) return json(404, { error: 'Pairing code invalid or expired.', code: 'PAIRING_INVALID' });
    if (!timingSafeEqualStr(await verifierFor(norm.secret, row.salt), row.verifier)) {
      await run(db, 'UPDATE pairing_codes SET attempts = attempts + 1 WHERE id = ? AND attempts < ?', row.id, MAX_PAIRING_ATTEMPTS);
      return json(404, { error: 'Pairing code invalid or expired.', code: 'PAIRING_INVALID' });
    }
    const owner = await first(db, 'SELECT id, demo, disabled FROM "user" WHERE id = ?', ownerId);
    if (!owner || Number(owner.disabled) === 1 || Number(owner.demo) === 1) return json(404, { error: 'Pairing code invalid or expired.', code: 'PAIRING_INVALID' });
    let resource = null;
    if (row.used_at) {
      // Lost-response retry: the same node re-binds within the reclaim
      // window and gets a fresh sender key; anything else sees the same
      // generic invalid as an unknown code.
      if (row.node_id === nodeId && row.resource_id
        && Number.isFinite(Date.parse(row.used_at)) && Date.parse(row.used_at) + PAIRING_RECLAIM_MS >= Date.now()) {
        resource = await first(db, 'SELECT * FROM resources WHERE id = ? AND owner_id = ? AND node_id = ?', row.resource_id, ownerId, nodeId);
      }
      if (!resource) return json(404, { error: 'Pairing code invalid or expired.', code: 'PAIRING_INVALID' });
    } else if (!Number.isFinite(Date.parse(row.expires_at)) || Date.parse(row.expires_at) < Date.now()) {
      return json(410, { error: 'Pairing code expired. Mint a new one.', code: 'PAIRING_EXPIRED' });
    }
    const kind = ['local', 'cluster', 'provider'].includes(body.kind) ? body.kind : 'local';
    const cpu = typeof body.cpu === 'string' && body.cpu.trim() ? body.cpu.slice(0, 80) : 'unknown';
    const gpu = typeof body.gpu === 'string' && body.gpu.trim() ? body.gpu.slice(0, 80) : 'none recorded';
    const caps = Array.isArray(body.capabilities) ? body.capabilities.map(String).slice(0, 20) : [];
    const wantName = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 80) : `worker-${nodeId.slice(0, 16)}`;
    const now = nowIso();
    if (!resource) resource = await first(db, 'SELECT * FROM resources WHERE owner_id = ? AND node_id = ?', ownerId, nodeId);
    let created = !resource;
    let resourceId = resource ? resource.id : rid('r_');
    let name = resource ? resource.name : await uniqueResourceName(db, ownerId, wantName);
    let fresh = await completePairing(db, row, nodeId, resourceId, { created, name, kind, cpu, gpu, caps }, now);
    if (!fresh) {
      // A concurrent claim may have consumed this code or enrolled the node.
      // Reload consent, preserving its authenticated identity and same-node
      // reclaim window, before the one bounded transaction retry.
      const winner = await first(db, 'SELECT * FROM resources WHERE owner_id = ? AND node_id = ?', ownerId, nodeId);
      const latest = winner ? await first(db, 'SELECT * FROM pairing_codes WHERE id=?', row.id) : null;
      const retryAt = nowIso();
      const eligible = latest && latest.owner_id === ownerId && latest.salt === row.salt && latest.verifier === row.verifier
        && Number(latest.attempts) < MAX_PAIRING_ATTEMPTS
        && (latest.used_at
          ? latest.node_id === nodeId && latest.resource_id === winner.id && Number.isFinite(Date.parse(latest.used_at))
            && Date.parse(latest.used_at) + PAIRING_RECLAIM_MS >= Date.parse(retryAt)
          : Number.isFinite(Date.parse(latest.expires_at)) && Date.parse(latest.expires_at) >= Date.parse(retryAt));
      if (eligible) {
        created = false; resourceId = winner.id; name = winner.name;
        fresh = await completePairing(db, latest, nodeId, resourceId, { created, name, kind, cpu, gpu, caps }, retryAt);
      }
    }
    if (!fresh) {
      const live = await first(db, 'SELECT disabled,demo FROM "user" WHERE id = ?', ownerId);
      if (!live || Number(live.disabled) || Number(live.demo)) return json(404, { error: 'Pairing code invalid or expired.', code: 'PAIRING_INVALID' });
      const spent = await first(db, 'SELECT count FROM write_budget WHERE user_id = ? AND window = ?', ownerId, budgetWindow());
      if (spent && spent.count >= WRITE_BUDGET_PER_HOUR) throw httpError(429, 'Too many changes in the last hour. Try again later.', 'WRITE_RATE_LIMITED');
      const keys = await first(db, 'SELECT COUNT(*) n FROM key_verifiers WHERE owner_id = ? AND revoked_at IS NULL', ownerId);
      if (keys.n >= MAX_KEYS_PER_USER) return json(409, { error: `Active API key limit reached (${MAX_KEYS_PER_USER} per user). Revoke an old key first.`, code: 'KEY_LIMIT' });
      if (created) {
        const count = await first(db, 'SELECT COUNT(*) n FROM resources WHERE owner_id = ?', ownerId);
        if (count.n >= MAX_RESOURCES_PER_USER) return json(409, { error: `Resource limit reached (${MAX_RESOURCES_PER_USER} per user).`, code: 'RESOURCE_LIMIT' });
      }
      return json(404, { error: 'Pairing code invalid or expired.', code: 'PAIRING_INVALID' });
    }
    resource = await first(db, 'SELECT * FROM resources WHERE id = ? AND owner_id = ? AND node_id = ?', resourceId, ownerId, nodeId);
    return json(created ? 201 : 200, {
      resourceId: resource.id, created, resource: cardFor(resource, await ownerName(db, ownerId)),
      heartbeatKey: fresh.secret, keyId: fresh.id, keyPrefix: fresh.prefix,
      heartbeatUrl: `/api/resources/${resource.id}/heartbeat`,
      oneTime: 'This secret is shown once. It cannot be recovered.'
    });
  }

  // ---- API keys (session only; secrets one-time) ----
  if (path === '/api/keys' && method === 'GET') {
    const d = needSession(); if (d) return deny(d);
    const q = pagination(url);
    const page = await pageQuery(db, { select: 'SELECT *', from: 'FROM key_verifiers WHERE owner_id = ?', params: [me()], order: 'ORDER BY created_at DESC', ...q });
    return json(200, { ...page, items: page.items.map((k) => publicKey(mapKeyRow(k))) });
  }
  if (path === '/api/keys' && method === 'POST') {
    const d = needSession() || needCsrf(); if (d) return deny(d);
    const body = await readJson(request);
    if (!isName(body.name)) return json(400, { error: 'Name is required (1..80 chars).', code: 'BAD_NAME' });
    if (!isScope(body.scope)) return json(400, { error: 'Scope must be "read", "inference", or "heartbeat".', code: 'BAD_SCOPE' });
    // Heartbeat keys bind to exactly one caller-owned resource at mint
    // (migration 0013). The demo account cannot mint them: demo telemetry
    // stays fixture-labeled and can never touch real intake.
    let heartbeatResourceId = null;
    if (body.scope === 'heartbeat') {
      const nd = needNotDemo(); if (nd) return deny(nd);
      if (!isId(body.resourceId)) return json(400, { error: 'resourceId is required for heartbeat scope.', code: 'BAD_RESOURCE' });
      const target = await first(db, 'SELECT id FROM resources WHERE id = ? AND owner_id = ?', body.resourceId, me());
      if (!target) return json(404, { error: 'Resource not found or not yours.', code: 'NOT_FOUND' });
      heartbeatResourceId = body.resourceId;
    } else if (body.resourceId !== undefined && body.resourceId !== null) {
      return json(400, { error: 'resourceId is only valid with heartbeat scope.', code: 'BAD_RESOURCE' });
    }
    let expiresAt = null;
    if (body.expiresAt !== undefined && body.expiresAt !== null) {
      const t = Date.parse(body.expiresAt);
      if (!Number.isFinite(t) || t <= Date.now()) return json(400, { error: 'expiresAt must be a future timestamp.', code: 'BAD_EXPIRY' });
      expiresAt = new Date(t).toISOString();
    }
    const metadata = isDemo() ? 'sandbox: demo-only credential' : (body.metadata !== undefined ? String(body.metadata).slice(0, 500) : '');
    const keyPrefix = isDemo() ? DEMO_KEY_PREFIX : KEY_PREFIX;
    await checkWriteBudget(db, me());
    const { id, secret, short } = mintKey(keyPrefix);
    const saltBytes = crypto.getRandomValues(new Uint8Array(16));
    const salt = Array.from(saltBytes, (b) => b.toString(16).padStart(2, '0')).join('');
    const kc = await run(db, `INSERT INTO key_verifiers (id, owner_id, name, scope, resource_id, salt, verifier, prefix, expires_at, metadata, created_at, last_used_at, revoked_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL WHERE (SELECT COUNT(*) FROM key_verifiers WHERE owner_id = ? AND revoked_at IS NULL) < ${MAX_KEYS_PER_USER}`,
      id, me(), body.name.trim(), body.scope, heartbeatResourceId, salt, await verifierFor(secret, salt), keyPrefix + id + '_' + short, expiresAt, metadata, nowIso(), me());
    assertClaimed(kc, 'key');
    await audit(db, me(), 'key.create', id, body.scope === 'heartbeat' ? `heartbeat:${heartbeatResourceId}` : body.scope);
    const row = await first(db, 'SELECT * FROM key_verifiers WHERE id = ?', id);
    return json(201, { ...publicKey(mapKeyRow(row)), secret, oneTime: 'This secret is shown once. It cannot be recovered.' });
  }
  {
    const m = /^\/api\/keys\/([A-Za-z0-9_-]{1,64})$/.exec(path);
    if (m && method === 'DELETE') {
      const d = needSession() || needCsrf(); if (d) return deny(d);
      const k = await first(db, 'SELECT id, revoked_at FROM key_verifiers WHERE id = ? AND owner_id = ?', m[1], me());
      if (!k) return json(404, { error: 'Key not found or not yours.', code: 'NOT_FOUND' });
      if (k.revoked_at) return json(200, { ok: true });
      await run(db, 'UPDATE key_verifiers SET revoked_at = ? WHERE id = ?', nowIso(), m[1]);
      await audit(db, me(), 'key.revoke', m[1]);
      return json(200, { ok: true });
    }
  }

  // ---- jobs (dispatch disabled; reads allowed) ----
  if (path === '/api/jobs' && method === 'POST') {
    const d = needAuthz('inference'); if (d) return deny(d);
    if (actor.kind === 'session') { const c = needCsrf(); if (c) return deny(c); }
    return json(501, { error: 'Inference dispatch is disabled. No job was created and no compute ran.', code: 'INFERENCE_DISABLED' });
  }
  {
    const m = /^\/api\/jobs\/([A-Za-z0-9_-]{1,64})$/.exec(path);
    if (m && method === 'GET') {
      const d = needAuthz('read'); if (d) return deny(d);
      const j = await first(db, 'SELECT * FROM jobs WHERE id = ? AND owner_id = ?', m[1], me());
      if (!j) return json(404, { error: 'Job not found or not yours.', code: 'NOT_FOUND' });
      return json(200, mapJob(j));
    }
  }
  if (path === '/api/jobs' && method === 'GET') {
    const d = needAuthz('read'); if (d) return deny(d);
    const q = pagination(url);
    const page = await pageQuery(db, { select: 'SELECT *', from: 'FROM jobs WHERE owner_id = ?', params: [me()], order: 'ORDER BY created_at DESC', ...q });
    return json(200, { ...page, items: page.items.map(mapJob) });
  }

  // ---- usage ----
  if (path === '/api/usage' && method === 'GET') {
    const d = needAuthz('read'); if (d) return deny(d);
    const q = pagination(url);
    const page = await pageQuery(db, { select: 'SELECT *', from: 'FROM usage WHERE owner_id = ?', params: [me()], order: 'ORDER BY at DESC', ...q });
    const rows = page.items.map(mapUsage);
    const totals = rows.reduce((t, r) => ({
      requests: t.requests + r.requests,
      tokensIn: t.tokensIn + r.tokensIn,
      tokensOut: t.tokensOut + r.tokensOut,
      // Unknown is not zero: costs sum only when every row carries a real
      // number; any unmeasured row makes the total unknown (null).
      modelCostUsd: t.modelCostUsd === null || r.modelCostUsd === null || r.modelCostUsd === undefined ? null : t.modelCostUsd + r.modelCostUsd,
      executionCostUsd: t.executionCostUsd === null || r.executionCostUsd === null || r.executionCostUsd === undefined ? null : t.executionCostUsd + r.executionCostUsd
    }), { requests: 0, tokensIn: 0, tokensOut: 0, modelCostUsd: 0, executionCostUsd: 0 });
    return json(200, { items: rows, total: page.total, limit: page.limit, offset: page.offset, totals, note: 'Model cost and execution cost are tracked separately. Unmeasured values stay null (unknown).' });
  }

  // ---- settings (session only) ----
  if (path === '/api/settings' && method === 'GET') {
    const d = needSession(); if (d) return deny(d);
    return json(200, { displayName: actor.user.name || '', email: actor.user.email || '', username: actor.user.username || null, demo: isDemo() });
  }
  if (path === '/api/settings' && method === 'PATCH') {
    const d = needSession() || needCsrf(); if (d) return deny(d);
    const body = await readJson(request);
    if (!isName(body.displayName)) return json(400, { error: 'displayName is required (1..80 chars).', code: 'BAD_NAME' });
    await checkWriteBudget(db, me());
    await run(db, 'UPDATE "user" SET name = ?, updatedAt = ? WHERE id = ?', body.displayName.trim(), nowIso(), me());
    await audit(db, me(), 'settings.update', 'displayName');
    return json(200, { ok: true, displayName: body.displayName.trim() });
  }

  if (path === '/api/audit' && method === 'GET') {
    const d = needSession(); if (d) return deny(d);
    const q = pagination(url);
    const page = await pageQuery(db, { select: 'SELECT *', from: 'FROM audit WHERE actor_id = ?', params: [me()], order: 'ORDER BY at DESC', ...q });
    return json(200, page);
  }

  // ---- federation control plane (F1; flag-gated, default off) ----
  if (path === '/v1/fabric/mcp' || path.startsWith('/v1/fabric/')) {
    return handleFabric({ request, env, url, actor, db, json, needSession, needCsrf, needAuthz, needNotDemo });
  }

  return json(404, { error: 'Unknown API route.', code: 'NOT_FOUND' });
}

function mapGrantLite(g) {
  return {
    id: g.id, resourceId: g.resource_id, ownerId: g.owner_id, granteeId: g.grantee_id,
    quotas: { maxJobs: g.max_jobs, maxTokens: g.max_tokens },
    usedJobs: g.used_jobs, usedTokens: g.used_tokens,
    inferenceOnly: !!g.inference_only, createdAt: g.created_at, revokedAt: g.revoked_at || null
  };
}

function mintPairCode() {
  // 32-bit id handle + 60-bit Crockford secret (12 bytes masked to 5 bits
  // each; 256 is a multiple of 32, so there is no modulo bias).
  const idBytes = crypto.getRandomValues(new Uint8Array(4));
  const idHex = Array.from(idBytes, (b) => b.toString(16).padStart(2, '0')).join('');
  const secret = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => PAIR_CODE_ALPHABET[b & 31]).join('');
  return {
    id: 'p_' + idHex,
    secret,
    code: `pair-${idHex}-${secret.slice(0, 4)}-${secret.slice(4, 8)}-${secret.slice(8, 12)}`
  };
}

async function uniqueResourceName(db, ownerId, base) {
  // Display names stay human-meaningful on collision ("lab", "lab-2", ...).
  // Identity is the row id / node binding, never the name, so a lost rename
  // race only duplicates a label, never an identity.
  // The owner's names are read once (bounded by the per-owner resource cap)
  // and candidates are checked locally, not one query per collision.
  const clean = String(base || '').trim().slice(0, 80) || 'worker';
  const taken = new Set((await all(db, 'SELECT name FROM resources WHERE owner_id = ?', ownerId)).map((r) => r.name));
  for (let n = 1; n <= 100; n++) {
    const cand = n === 1 ? clean : `${clean.slice(0, 74)}-${n}`;
    if (!taken.has(cand)) return cand;
  }
  return `${clean.slice(0, 60)}-${rid('').slice(0, 6)}`;
}

async function completePairing(db, code, nodeId, resourceId, meta, now) {
  // One transaction re-pins the authenticated consent, live owner and exact
  // resource identity, then creates the sender before revoking older keys.
  // No partial enrollment/rotation survives an audit or persistence failure.
  // The key cap counts the RESULTING total: this resource's live sender keys
  // are revoked by the same batch, so a lost-response reclaim at a full cap
  // replaces its sender instead of needing a phantom free slot. The
  // exclusion is NULL-safe, so unbound keys still count; genuinely new
  // senders still hit KEY_LIMIT.
  const ownerId = code.owner_id;
  const { id, secret, short } = mintKey(KEY_PREFIX);
  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  const salt = Array.from(saltBytes, (b) => b.toString(16).padStart(2, '0')).join('');
  const hash = await verifierFor(secret, salt);
  const result = await db.batch([
    db.prepare(`UPDATE pairing_codes SET used_at = COALESCE(used_at, ?), node_id = ?
      WHERE id = ? AND owner_id = ? AND salt = ? AND verifier = ? AND used_at IS ? AND resource_id IS ? AND attempts < ?
      AND ((used_at IS NULL AND expires_at >= ?) OR (used_at IS NOT NULL AND node_id = ? AND resource_id = ? AND used_at >= ?))
      AND EXISTS(SELECT 1 FROM "user" WHERE id = ? AND disabled = 0 AND demo = 0)
      AND ((? = 1 AND NOT EXISTS(SELECT 1 FROM resources WHERE owner_id = ? AND node_id = ?)
        AND (SELECT COUNT(*) FROM resources WHERE owner_id = ?) < ${MAX_RESOURCES_PER_USER})
        OR (? = 0 AND EXISTS(SELECT 1 FROM resources WHERE id = ? AND owner_id = ? AND node_id = ?)))
      AND (SELECT COUNT(*) FROM key_verifiers WHERE owner_id = ? AND revoked_at IS NULL
        AND (resource_id IS NULL OR resource_id != ? OR scope != 'heartbeat')) < ${MAX_KEYS_PER_USER}
      AND COALESCE((SELECT count FROM write_budget WHERE user_id = ? AND window = ?),0) < ${WRITE_BUDGET_PER_HOUR}`)
      .bind(now, nodeId, code.id, ownerId, code.salt, code.verifier, code.used_at, code.resource_id, MAX_PAIRING_ATTEMPTS,
        now, nodeId, resourceId, new Date(Date.parse(now) - PAIRING_RECLAIM_MS).toISOString(), ownerId,
        meta.created ? 1 : 0, ownerId, nodeId, ownerId, meta.created ? 1 : 0, resourceId, ownerId, nodeId, ownerId, resourceId, ownerId, budgetWindow(new Date(now))),
    db.prepare(`INSERT INTO write_budget(user_id,window,count) SELECT ?,?,1 WHERE changes() = 1 ON CONFLICT(user_id,window) DO UPDATE SET count=count+1`).bind(ownerId,budgetWindow(new Date(now))),
    ...(meta.created ? [db.prepare(`INSERT INTO resources (id, owner_id, node_id, name, kind, origin, cpu, gpu, capabilities_json, configured, authenticated, online, usable, heartbeat_at, limits_json, scope, verification_json, credits_json, created_at)
      SELECT ?, ?, ?, ?, ?, 'paired', ?, ?, ?, 1, 1, 0, 0, NULL, '{}', 'owner only', ?, NULL, ? WHERE changes() = 1`)
      .bind(resourceId, ownerId, nodeId, meta.name, meta.kind, meta.cpu, meta.gpu, JSON.stringify(meta.caps), JSON.stringify({ note: `Paired ${now}; awaiting first heartbeat.` }), now)] : []),
    db.prepare(`INSERT INTO key_verifiers (id, owner_id, name, scope, resource_id, salt, verifier, prefix, expires_at, metadata, created_at, last_used_at, revoked_at)
      SELECT ?, ?, ?, 'heartbeat', ?, ?, ?, ?, NULL, ?, ?, NULL, NULL WHERE changes() = 1
      AND EXISTS(SELECT 1 FROM resources WHERE id = ? AND owner_id = ? AND node_id = ?)`)
      .bind(id, ownerId, `worker heartbeat ${nodeId.slice(0, 32)}`, resourceId, salt, hash, KEY_PREFIX + id + '_' + short, `pairing node ${nodeId}`, now, resourceId, ownerId, nodeId),
    db.prepare(`UPDATE key_verifiers SET revoked_at = ? WHERE resource_id = ? AND scope = 'heartbeat' AND revoked_at IS NULL AND id != ? AND changes() = 1`).bind(now, resourceId, id),
    db.prepare(`UPDATE pairing_codes SET resource_id = ? WHERE id = ? AND EXISTS(SELECT 1 FROM key_verifiers WHERE id = ?)`).bind(resourceId, code.id, id),
    ...(meta.created ? [db.prepare(`INSERT INTO audit (id, at, actor_id, action, target, detail) SELECT ?, ?, ?, 'resource.register', ?, ? WHERE EXISTS(SELECT 1 FROM key_verifiers WHERE id = ?)`).bind(rid('a_'), now, ownerId, resourceId, meta.name, id)] : []),
    db.prepare(`INSERT INTO audit (id, at, actor_id, action, target, detail) SELECT ?, ?, ?, 'key.create', ?, ? WHERE EXISTS(SELECT 1 FROM key_verifiers WHERE id = ?)`).bind(rid('a_'), now, ownerId, id, `heartbeat:${resourceId}`, id),
    db.prepare(`INSERT INTO audit (id, at, actor_id, action, target, detail) SELECT ?, ?, ?, 'pairing.claim', ?, ? WHERE EXISTS(SELECT 1 FROM key_verifiers WHERE id = ?)`).bind(rid('a_'), now, ownerId, code.id, `${nodeId} -> ${resourceId}`, id)
  ]);
  if (Number(result[0].meta.changes) !== 1) return null;
  return { id, secret, prefix: KEY_PREFIX + id + '_' + short };
}

async function registerResource(db, ownerId, key, body, kind, origin) {
  const now = nowIso(), window = budgetWindow(new Date(now));
  const cutoff = new Date(Date.parse(now) - IDEMPOTENCY_TTL_MS).toISOString();
  const prior = key ? await first(db, 'SELECT * FROM idempotency_keys WHERE owner_id = ? AND key = ?', ownerId, key) : null;
  const replay = async () => key ? first(db, `SELECT r.* FROM idempotency_keys i JOIN resources r ON r.id=i.resource_id AND r.owner_id=i.owner_id WHERE i.owner_id=? AND i.key=? AND i.created_at>=?`, ownerId, key, cutoff) : null;
  const existing = await replay();
  if (existing) return { created: false, row: existing };
  if (prior && prior.resource_id === null) {
    const claimedAt = Date.parse(prior.created_at);
    if (!Number.isFinite(claimedAt) || claimedAt + IDEMPOTENT_IN_FLIGHT_MS >= Date.parse(now)) {
      throw httpError(409, 'A request with this Idempotency-Key is already in flight. Retry shortly.', 'IDEMPOTENT_IN_FLIGHT');
    }
  }
  // Reserve the generated resource identity inside the same transaction as
  // admission, insertion and audit. No committed NULL mapping can wedge a
  // retry; concurrent losers read the winner without spending another slot.
  const id = rid('r_');
  const allowed = `EXISTS(SELECT 1 FROM "user" WHERE id=? AND disabled=0)
    AND (SELECT COUNT(*) FROM resources WHERE owner_id=?) < ${MAX_RESOURCES_PER_USER}
    AND COALESCE((SELECT count FROM write_budget WHERE user_id=? AND window=?),0) < ${WRITE_BUDGET_PER_HOUR}`;
  const claim = key ? [db.prepare(`INSERT OR IGNORE INTO idempotency_keys(owner_id,key,resource_id,created_at) SELECT ?,?,?,? WHERE ${allowed}`).bind(ownerId,key,id,now,ownerId,ownerId,ownerId,window)] : [];
  await db.batch([
    ...(prior ? [db.prepare(`DELETE FROM idempotency_keys WHERE owner_id=? AND key=? AND created_at=? AND resource_id IS ? AND ${allowed}`).bind(ownerId,key,prior.created_at,prior.resource_id,ownerId,ownerId,ownerId,window)] : []),
    ...claim,
    db.prepare(`INSERT INTO resources (id,owner_id,name,kind,origin,cpu,gpu,capabilities_json,configured,authenticated,online,usable,heartbeat_at,limits_json,scope,verification_json,credits_json,created_at)
      SELECT ?,?,?,?,?,?,?,?,1,0,0,0,NULL,?,'owner only',?,NULL,? WHERE ${key ? 'changes()=1 AND EXISTS(SELECT 1 FROM idempotency_keys WHERE owner_id=? AND key=? AND resource_id=?)' : allowed}`)
      .bind(id,ownerId,body.name.trim(),kind,origin,String(body.cpu||'unknown').slice(0,80),String(body.gpu||'none recorded').slice(0,80),JSON.stringify(Array.isArray(body.capabilities)?body.capabilities.map(String).slice(0,20):[]),JSON.stringify(body.limits&&typeof body.limits==='object'?body.limits:{}),JSON.stringify({note:'Declared by owner; not verified.'}),now,...(key?[ownerId,key,id]:[ownerId,ownerId,ownerId,window])),
    db.prepare(`INSERT INTO write_budget(user_id,window,count) SELECT ?,?,1 WHERE changes()=1 ON CONFLICT(user_id,window) DO UPDATE SET count=count+1`).bind(ownerId,window),
    db.prepare(`INSERT INTO audit(id,at,actor_id,action,target,detail) SELECT ?,?,?,'resource.register',?,? WHERE changes()=1`).bind(rid('a_'),now,ownerId,id,body.name.trim())
  ]);
  const row = await first(db,'SELECT * FROM resources WHERE id=? AND owner_id=?',id,ownerId);
  if (row) return { created: true, row };
  const winner = await replay();
  if (winner) return { created: false, row: winner };
  const live = await first(db,'SELECT disabled FROM "user" WHERE id=?',ownerId);
  if (!live || Number(live.disabled)) throw httpError(401,'Sign-in or API key required.','AUTH_REQUIRED');
  const budget = await first(db,'SELECT count FROM write_budget WHERE user_id=? AND window=?',ownerId,window);
  if (budget && budget.count >= WRITE_BUDGET_PER_HOUR) throw httpError(429,'Too many changes in the last hour. Try again later.','WRITE_RATE_LIMITED');
  assertClaimed({meta:{changes:0}},'resource');
}

function mapKeyRow(k) {
  return {
    id: k.id, ownerId: k.owner_id, name: k.name, scope: k.scope,
    resourceId: k.resource_id || null,
    verifier: k.verifier, salt: k.salt, prefix: k.prefix,
    expiresAt: k.expires_at || null, metadata: k.metadata || '',
    createdAt: k.created_at, lastUsedAt: k.last_used_at || null, revokedAt: k.revoked_at || null
  };
}

async function serveApp(request, env, pathname) {
  // /app UI from static assets with app security headers (script-src 'self').
  const assetPath = pathname === '/app' || pathname === '/app/' ? '/app/index.html' : pathname;
  const url = new URL(request.url);
  const res = await env.ASSETS.fetch(new Request(url.origin + assetPath, { method: request.method }));
  if (!res.ok) return new Response('Not found', { status: 404, headers: { ...baseHeaders(), 'Content-Type': 'text/plain' } });
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(baseHeaders())) headers.set(k, v);
  headers.set('Cache-Control', 'no-store, no-transform');
  headers.set('Content-Security-Policy', APP_CSP);
  return new Response(res.body, { status: res.status, headers });
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      // Canonical-host guard for the app shell (mirrors the /api guard):
      // alternate hosts (workers.dev, previews) keep serving public assets
      // but must not become auth entry points.
      if ((url.pathname === '/app' || url.pathname === '/app/' || url.pathname.startsWith('/app/')) && wrongHost(env, url.origin)) {
        return new Response('Forbidden host.', { status: 403, headers: { ...baseHeaders(), 'Content-Type': 'text/plain' } });
      }
      if (url.pathname === '/app' && request.method === 'GET') {
        return Response.redirect(url.origin + '/app/', 302);
      }
      if (url.pathname === '/app/' || url.pathname.startsWith('/app/')) {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          return new Response('Method not allowed', { status: 405, headers: baseHeaders() });
        }
        return serveApp(request, env, url.pathname);
      }
      if (url.pathname.startsWith('/api/') || url.pathname === '/v1/fabric/mcp' || url.pathname.startsWith('/v1/fabric/')) {
        try {
          return await handleApi(request, env, url);
        } catch (error) {
          if (error && error.status) return json(error.status, { error: error.message, code: error.code || 'BAD_REQUEST' });
          return json(500, { error: 'Request failed.', code: 'INTERNAL' });
        }
      }
      return env.ASSETS.fetch(request);
    } catch {
      return json(500, { error: 'Request failed.', code: 'INTERNAL' });
    }
  }
};
