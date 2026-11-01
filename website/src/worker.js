/* Built with Meta Muse. */
// AIPSTER apex Worker: same-origin control-panel API + /app UI + /admin UI on
// top of the existing static site. Routing: /api/auth/* -> Better Auth,
// /api/* -> JSON API (errors always JSON, never the static 404 page),
// /app* and /admin* -> panel assets, everything else -> ASSETS (landing page
// preserved byte-for-byte).
import { createAuth, oauthConfigured, sessionUser } from './lib/auth.js';
import { all, first, run, pageQuery, cardFor, mapGrant, mapKey, mapJob, mapUsage, audit, rid, rid16, nowIso } from './lib/store.js';
import { mintKey, verifierFor, publicKey, splitPresented, timingSafeEqualStr, KEY_PREFIX, DEMO_KEY_PREFIX } from './lib/keys.js';
import { readJson, readBodyBytes, isId, isName, isScope, isEmail, pagination, httpError, normalizePairCode, PAIR_CODE_ALPHABET, MAX_BODY_BYTES } from './lib/validate.js';
import { checkWriteBudget, assertClaimed, capError, budgetWindow, WRITE_BUDGET_PER_HOUR, MAX_RESOURCES_PER_USER, MAX_KEYS_PER_USER, MAX_GRANTS_PER_USER, MAX_ACTIVE_UPLOADS_PER_USER, MAX_ASSET_FILES_PER_USER, heartbeatBudgets, heartbeatWindow, HEARTBEAT_CAPS_SQL, heartbeatCounterStatements, pruneHeartbeatBuckets, heartbeatBucketCount, secondsUntilNextHour, HEARTBEAT_GLOBAL_ID } from './lib/quotas.js';
import { handleFabric, federationEnabled } from './fabric/router.mjs';
import { handleAdmin } from './admin/router.mjs';
import { dgmPreviewEnabled } from './dgm/router.mjs';
import { advisorEnabled, advisorDescriptor, handleAdvisorPost } from './advisor/router.mjs';
import { ADVISOR_BODY_MAX } from './advisor/validate.mjs';
import { schemaReady } from './lib/schema.js';
import { buildStatus, MAX_STATUS_ITEMS, STALE_AFTER_MS } from './lib/status.mjs';
import { fixtureSearch, fixtureDetail, hubSearch, hubDetail, isFixtureEnv, validateRepoId } from './lib/catalog/hub.mjs';
import { evaluateCompatibility, TELEMETRY_FRESH_MS } from './lib/catalog/estimate.mjs';
import { validateManifestStructure, validateFileBytes, isByteEligible, validateRelPath as catalogRelPath, VALIDATOR_VERSION, MAX_MANIFEST_FILES, MAX_FILE_BYTES, MAX_ASSET_BYTES, MAX_HEADER_PEEK, MAX_MANIFEST_BYTES, MAX_PARTS_PER_UPLOAD, MAX_FINALIZE_FILE_BYTES } from './lib/catalog/validate.mjs';
import { byteStore, storeAvailable, CHUNK_MAX_BYTES, assetPrefix, assetKey } from './lib/catalog/store.mjs';
import { workerTransport, transportAvailable, TERMINAL_STATES, WORKER_STATES } from './lib/catalog/transport.mjs';
import { grantPartiesSameSide, grantUsage } from './lib/access.js';

const VERSION = '0.5.0';
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

async function ownerName(db, userId) {
  const u = await first(db, 'SELECT name FROM "user" WHERE id = ?', userId);
  return (u && u.name) || 'Unknown';
}

// Catalog node access (personal fabric): the caller owns the resource or
// holds a live grant on it. Anything else (including a merely-known id)
// gets null so callers answer 404 without disclosing existence (T1).
async function catalogNodeAccess(db, userId, nodeId) {
  const r = await first(db, 'SELECT * FROM resources WHERE id = ?', nodeId);
  if (!r) return null;
  if (r.owner_id === userId) return r;
  const g = await first(db, 'SELECT * FROM grants WHERE resource_id = ? AND grantee_id = ? AND revoked_at IS NULL', nodeId, userId);
  if (!g || !(await grantPartiesSameSide(db, g))) return null;
  const owner = await first(db, 'SELECT disabled FROM "user" WHERE id = ?', r.owner_id);
  if (!owner || Number(owner.disabled) === 1) return null;
  return r;
}

// Private-asset API shape from a catalog_assets row + its files. The
// owner check happens before this runs; provenance/card text stays
// untrusted content for the client to render inert.
async function privateAssetShape(db, row) {
  const files = await all(db, 'SELECT relpath, bytes, sha256 FROM catalog_asset_files WHERE asset_id = ?', row.id);
  const manifest = JSON.parse(row.manifest_json);
  const license = JSON.parse(row.license_json);
  return {
    id: `priv:${row.id}`,
    source: 'private',
    repo: row.repo,
    revision: row.revision,
    kind: row.kind,
    task: row.task,
    arch: row.arch,
    format: row.format,
    quant: row.quant,
    license,
    gated: false,
    card: manifest.provenance || '',
    files: files.map((f) => ({ relpath: f.relpath, bytes: f.bytes, sha256: f.sha256 })),
    totalBytes: files.reduce((n, f) => n + f.bytes, 0),
    freshnessAt: row.freshness_at,
    validation: row.validation,
    checks: manifest.checks || null,
    tokenizer: manifest.tokenizer || null,
    fixture: false,
    ...(manifest.adapter ? {
      adapter: {
        baseAssetId: manifest.adapter.baseAssetId,
        baseRevision: manifest.adapter.baseRevision,
        peftType: manifest.adapter.peftType || 'LORA',
        targetModules: manifest.adapter.targetModules || [],
        tokenizer: manifest.adapter.tokenizer || null,
      },
    } : {}),
  };
}

// Finalization claim lease (Codex-P2): a finalize over at most 128 MiB
// cannot legitimately run this long, and Worker execution limits
// terminate the holder first - so a promoting row older than this always
// means a dead owner, and a retry may steal the claim.
const FINALIZE_CLAIM_MS = 5 * 60 * 1000;

// Exact part ownership (Codex-P2): part keys are
// `upload/{id}/part/{index8}/{relpath}` with a zero-padded 8-digit
// index. Suffix matching confuses `config.json` with
// `nested/config.json` (413 false-trips, merged assemblies, wrong
// received counts); strip the fixed-length head and compare equality.
// Returns the relpath, or null when the key is outside the prefix.
function uploadPartPath(key, prefix) {
  if (!key.startsWith(prefix) || key[prefix.length + 8] !== '/') return null;
  return key.slice(prefix.length + 9);
}

// Byte equality for idempotent chunk retries. Length is checked by
// callers first; this compares content only.
function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// Reclaim-fence predicate (Codex-sec-P2): true when an asset id is
// committed (or its row is unreadable) and its prefix must NOT be
// reclaimed. Exported for unit tests; the finalizer calls it before every
// attempt-prefix reclaim.
export async function assetPrefixProtected(db, assetId) {
  try {
    return !!(await first(db, 'SELECT id FROM catalog_assets WHERE id = ?', assetId));
  } catch {
    return true;
  }
}

// Lazy upload expiry: sessions past their deadline (and never terminal)
// move to expired, and their quarantine parts are deleted best-effort
// (bounded per call). Runs at the top of upload intake, never on a timer.
async function expireCatalogUploads(db, store, ownerId) {
  // Oldest-first, and swept rejections leave the predicate: rejected rows
  // keep their terminal verdict forever, so without a swept marker they
  // would re-fill every LIMIT 20 batch and starve genuine expiries
  // (Codex-P2). A row leaves the predicate only when fully drained; a
  // partial drain (>2010 parts) stays for the next sweep. Expired rows
  // still draining (byte_ref marker, below) re-enter the same way.
  const stale = await all(db, "SELECT id, state FROM catalog_uploads WHERE owner_id = ? AND ((expires_at <= ? AND state != 'validated') OR (state = 'rejected' AND byte_ref IS NULL) OR (state = 'validated' AND json_extract(manifest_json, '$.cleaned') IS FALSE)) AND (state != 'expired' OR byte_ref = 'expired-draining') AND (state != 'rejected' OR byte_ref IS NULL) ORDER BY expires_at LIMIT 20", ownerId, new Date().toISOString());
  for (const row of stale) {
    const now = new Date().toISOString();
    if (row.state !== 'rejected' && row.state !== 'validated' && row.state !== 'expired') {
      // Claim expiry BEFORE cleanup (Codex-sec-P2): the old order listed
      // and deleted parts first, then flipped state. A chunk PUT in flight
      // across those awaits could reserve, persist, and pass its post-write
      // check while the row still read uploading (200), after which the
      // flip excluded the row from every future sweep - uncharged
      // permanent bytes. Flipping first closes it both ways: a chunk racing
      // the flip either fails reservation (state-gated CAS) or fails its
      // post-write check after the flip (410 + self-delete + rollback); a
      // chunk that already passed (200) persisted before the flip, so this
      // sweep's list - taken after the claim - still sees and deletes its
      // part while the expired row drops its reservation from every quota
      // query. The flip stays conditional on a live state: a promotion that
      // commits (validated + asset byte_ref) before the flip matches zero
      // rows and is skipped, and its leftovers stay with the validated
      // branch. Any other zero-row flip means the row terminally moved
      // under us; that path owns cleanup, never this sweep. Partial drains
      // keep the byte_ref marker (mirroring the rejected 'swept' pattern):
      // the marker is not a fence token, so in-flight finalizers stay
      // fenced out exactly as the old NULL did.
      const flipped = await run(db, "UPDATE catalog_uploads SET state = 'expired', byte_ref = 'expired-draining', updated_at = ? WHERE id = ? AND state IN ('uploading', 'quarantined', 'validating', 'promoting')", now, row.id);
      if (Number(flipped.meta.changes) !== 1) continue;
    }
    let drained = true;
    if (store) {
      const parts = await store.list(`upload/${row.id}/part/`, 2011);
      for (const p of parts.slice(0, 2010)) await store.del(p.key);
      drained = parts.length <= 2010;
    }
    if (!drained) continue;
    if (row.state === 'rejected') {
      await run(db, "UPDATE catalog_uploads SET byte_ref = 'swept', updated_at = ? WHERE id = ? AND state = 'rejected'", now, row.id);
    } else if (row.state === 'validated') {
      // Flagged-leftover drain (Codex-sec-P2): big promotions leave
      // parts behind (see promote cleanup); the sweep converges them.
      // The verdict and asset reference never change here - only the
      // flag clears, and only once the parts reach zero.
      const full = await first(db, 'SELECT manifest_json FROM catalog_uploads WHERE id = ?', row.id);
      const mj = JSON.parse(full.manifest_json);
      mj.cleaned = true;
      await run(db, "UPDATE catalog_uploads SET manifest_json = ?, updated_at = ? WHERE id = ? AND state = 'validated'", JSON.stringify(mj), now, row.id);
    } else {
      // Converged drain marker (Codex-sec-P2): the row was claimed expired
      // before cleanup (above), so reaching here with zero parts left means
      // the drain is complete - clear the marker. Partial drains keep it
      // and re-enter through the predicate.
      await run(db, "UPDATE catalog_uploads SET byte_ref = NULL, updated_at = ? WHERE id = ? AND state = 'expired'", now, row.id);
    }
  }
  return stale.length;
}

// Loads a node's capability snapshot for evaluation. Never invents one:
// no row, unparseable row, or unreadable age all surface as nulls, which
// the estimator reports as unknown (AC07).
async function catalogSnapshot(db, nodeId) {
  const row = await first(db, 'SELECT * FROM node_capabilities WHERE node_id = ?', nodeId);
  if (!row) return { snapshot: null, ageMs: null, reportedAt: null };
  let snapshot = null;
  try {
    snapshot = {
      schema_version: row.schema_version, os: row.os, arch: row.arch,
      runtimes: JSON.parse(row.runtimes_json), mem: JSON.parse(row.mem_json),
      disk: JSON.parse(row.disk_json), workload: JSON.parse(row.workload_json),
    };
  } catch {
    return { snapshot: null, ageMs: null, reportedAt: null };
  }
  const ageMs = Date.now() - Date.parse(row.reported_at);
  return { snapshot, ageMs: Number.isFinite(ageMs) ? ageMs : null, reportedAt: row.reported_at };
}

// Strict capability-report body (schema v1): exact top-level keys, bounded
// strings/arrays, safe-integer byte counts. Unknown fields are rejected —
// a browser or worker cannot smuggle trusted readings past the schema.
function validateCapabilityBody(body) {
  const bad = (error) => ({ error, code: 'BAD_CAPABILITIES' });
  if (!body || typeof body !== 'object' || Array.isArray(body)) return bad('Capability body must be an object.');
  const keys = Object.keys(body);
  const allowed = new Set(['schema_version', 'os', 'arch', 'runtimes', 'mem', 'disk', 'workload']);
  if (keys.some((k) => !allowed.has(k))) return bad('Unknown capability field rejected.');
  if (body.schema_version !== 1) return bad('schema_version must be 1.');
  for (const f of ['os', 'arch']) {
    if (typeof body[f] !== 'string' || !body[f] || body[f].length > 64) return bad(`${f} must be a 1..64 char string.`);
  }
  if (!Array.isArray(body.runtimes) || body.runtimes.length > 16) return bad('runtimes must be an array of at most 16 entries.');
  for (const r of body.runtimes) {
    if (!r || typeof r !== 'object') return bad('Each runtime must be an object.');
    if (typeof r.name !== 'string' || !r.name || r.name.length > 64) return bad('Runtime name must be 1..64 chars.');
    if (r.version !== undefined && (typeof r.version !== 'string' || r.version.length > 32)) return bad('Runtime version must be at most 32 chars.');
    for (const f of ['formats', 'quants', 'adapters']) {
      if (r[f] !== undefined && (!Array.isArray(r[f]) || r[f].length > 32 || r[f].some((v) => typeof v !== 'string' || v.length > 64))) {
        return bad(`Runtime ${f} must be an array of at most 32 short strings.`);
      }
    }
    if (r.maxContext !== undefined && (!Number.isSafeInteger(r.maxContext) || r.maxContext < 0)) return bad('Runtime maxContext must be a safe integer.');
  }
  const bytesOk = (v) => Number.isSafeInteger(v) && v >= 0;
  const mem = body.mem;
  if (!mem || typeof mem !== 'object') return bad('mem must be an object.');
  if (!bytesOk(mem.ramTotalBytes) || !bytesOk(mem.ramAvailBytes) || mem.ramAvailBytes > mem.ramTotalBytes) {
    return bad('mem RAM totals must be safe integers with avail <= total.');
  }
  if (mem.gpu !== undefined) {
    if (!Array.isArray(mem.gpu) || mem.gpu.length > 16) return bad('mem.gpu must be an array of at most 16 entries.');
    for (const g of mem.gpu) {
      if (!g || typeof g !== 'object' || !bytesOk(g.vramTotalBytes) || !bytesOk(g.vramAvailBytes) || g.vramAvailBytes > g.vramTotalBytes) {
        return bad('Each GPU needs vram totals with avail <= total.');
      }
      if (g.name !== undefined && (typeof g.name !== 'string' || g.name.length > 128)) return bad('GPU name must be at most 128 chars.');
    }
  }
  const disk = body.disk;
  if (!disk || typeof disk !== 'object' || !bytesOk(disk.totalBytes) || !bytesOk(disk.availBytes) || disk.availBytes > disk.totalBytes) {
    return bad('disk needs totals with avail <= total.');
  }
  if (body.workload !== undefined) {
    if (!body.workload || typeof body.workload !== 'object') return bad('workload must be an object.');
    if (body.workload.reservations !== undefined) {
      if (!Array.isArray(body.workload.reservations) || body.workload.reservations.length > 64) return bad('workload.reservations holds at most 64 entries.');
      for (const w of body.workload.reservations) {
        if (!w || typeof w !== 'object' || !bytesOk(w.bytes)) return bad('Each reservation needs a byte count.');
      }
    }
  }
  return null;
}

// One resolver for hub/fixture/private refs (compat + plans share it).
// Private refs re-check ownership (404 like any missing id);
// non-validated private bytes cannot evaluate (AC12).
async function resolveCatalogRef(db, env, userId, ref, role, admit = null) {
  const fixture = isFixtureEnv(env);
  let asset = null;
  if (ref.startsWith('priv:')) {
    const row = await first(db, "SELECT * FROM catalog_assets WHERE id = ? AND owner_id = ? AND access = 'private'", ref.slice(5), userId);
    if (row) asset = await privateAssetShape(db, row);
  } else {
    const clean = ref.startsWith('hub:') ? ref.slice(4) : ref;
    asset = fixture ? fixtureDetail(clean) : await hubDetail(clean, { admit });
  }
  if (!asset || asset.gated === true) return { http: json(404, { error: `${role} not found or not visible to you.`, code: 'ASSET_NOT_FOUND' }) };
  if (asset.source === 'private' && asset.validation !== 'validated') {
    return { http: json(422, { error: `${role} is ${asset.validation}, not validated; rejected assets cannot evaluate.`, code: 'ASSET_NOT_VALIDATED' }) };
  }
  return { asset };
}

const b64u = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
const b64uDec = (s) => Uint8Array.from(atob(s.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0));

// Deployment plan tokens: HMAC-signed, principal-bound, 15-minute.
// Domain-separated from session secrets. Plans are immutable: execute
// re-resolves every pin and refuses drift (T7).
async function signPlanToken(env, payload) {
  const body = b64u(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('catalog-plan-v1:' + env.BETTER_AUTH_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return body + '.' + b64u(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
}

async function verifyPlanToken(env, token, userId) {
  const bad = (error, code) => ({ http: json(400, { error, code }) });
  if (typeof token !== 'string' || token.length > 8192) return bad('Plan token unreadable.', 'BAD_PLAN');
  const parts = token.split('.');
  if (parts.length !== 2) return bad('Plan token unreadable.', 'BAD_PLAN');
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(b64uDec(parts[0])));
  } catch {
    return bad('Plan token unreadable.', 'BAD_PLAN');
  }
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('catalog-plan-v1:' + env.BETTER_AUTH_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expect = b64u(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(parts[0])));
  if (!timingSafeEqualStr(expect, parts[1])) return bad('Plan token signature invalid.', 'BAD_PLAN');
  if (!payload || payload.v !== 1 || payload.principal !== userId) return bad('Plan token is not yours.', 'BAD_PLAN');
  if (!Number.isSafeInteger(payload.exp) || payload.exp <= Date.now()) return bad('Plan token expired; re-plan from a fresh evaluation.', 'PLAN_EXPIRED');
  return { plan: payload };
}

// Shared deployment guards (single source for compat/plan/execute): a
// primary adapter without an explicit base binding is refused (F6), and
// gated assets are refused at plan AND at execute, since gated-ness can
// change between the two (F7/T11). Each returns a 4xx response or null.
function adapterBaseRequired(asset, adapterRef) {
  if (asset && asset.kind === 'adapter' && !adapterRef) {
    return json(400, { error: 'Adapter weights need an explicit base: use the adapterRef+baseRef form; display names never bind a base.', code: 'ADAPTER_BASE_REQUIRED' });
  }
  return null;
}

function gatedRefusal(asset, adapterAsset) {
  if ((asset && asset.gated) || (adapterAsset && adapterAsset.gated)) {
    return json(403, { error: 'Gated asset: complete the access grant yourself first. Nothing is auto-accepted, and metered access is never assumed.', code: 'GATED_ACCESS_REQUIRED', retryable: false });
  }
  return null;
}

// Deployment transitions: forward-only along the lifecycle, or to
// failed/cancelled/cancelling from anywhere non-terminal (a load that
// finishes first honestly wins as ready). Writes are compare-and-swap:
// a concurrent writer wins and the loser re-reads instead of
// resurrecting (F1). Events land only on success; terminal failures and
// cancels release the reservation (AC15/AC17) unless the caller holds it
// for unreconciled capacity (N1 passes { release: false }). Ready KEEPS
// its reservation: loaded weights occupy memory until an unload API
// exists (documented follow-on).
// Late receipts on terminal jobs are audited, never applied (F9).
const DEPLOY_ORDER = ['queued', 'admitted', 'staging', 'verifying', 'loading', 'ready'];
const DEPLOY_TERMINAL = TERMINAL_STATES;
// A cancelling job the worker never answers fails (reservation HELD) past
// this quiet window; updated_at is the cancelling-entry clock because
// quiet reads never touch it (N1).
const CANCEL_QUIET_MS = 60_000;

// N3 SQL shapes, exported for the D1 runtime contract test
// (catalog-d1-runtime.test.mjs) so drift fails loudly instead of
// silently unproving the batch.
export const TRANSITION_SQL = {
  update: 'UPDATE catalog_deployments SET state = ?, error_json = ?, updated_at = ? WHERE id = ? AND state = ?',
  marker: `INSERT INTO catalog_deployment_events (id, deployment_id, at, from_state, to_state, detail)
      SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM catalog_deployments WHERE id = ? AND state = ? AND updated_at = ?)`,
  release: `UPDATE catalog_reservations SET state = 'released', released_at = ? WHERE deployment_id = ? AND state = 'held'
      AND EXISTS (SELECT 1 FROM catalog_deployment_events WHERE id = ?)
      AND EXISTS (SELECT 1 FROM catalog_deployments WHERE id = ? AND state = ? AND updated_at = ?)`,
};

async function transitionDeployment(db, job, to, detail = '', code = null, opts = {}) {
  const from = job.state;
  if (DEPLOY_TERMINAL.includes(from)) return { ok: false, error: `Deployment is already ${from}.` };
  const forward = to === 'failed' || to === 'cancelled'
    || (to === 'cancelling' && from !== 'cancelling' && !DEPLOY_TERMINAL.includes(from))
    || (from === 'cancelling' && to === 'ready')
    || (DEPLOY_ORDER.includes(from) && DEPLOY_ORDER.includes(to) && DEPLOY_ORDER.indexOf(to) > DEPLOY_ORDER.indexOf(from));
  if (!forward) return { ok: false, error: `Illegal transition ${from} -> ${to}.` };
  const now = nowIso();
  // N3: the state write, its evidence event, and the terminal release
  // commit as one guarded batch (D1 batch is all-or-nothing per
  // qa-d1-contract.test.mjs, but zero-row statements still succeed, so
  // every statement after the UPDATE is conditional):
  // - the event marker lands only when the post-state is exactly this
  //   write (id + state + updated_at), with a deterministic id per
  //   job/from/to;
  // - the release lands only when this write's marker landed AND the
  //   post-state is still this write, so a stale loser can never free
  //   another write's hold (not even an N1 hold behind a pre-existing
  //   marker).
  // A serialized loser zero-rows on the UPDATE and on both EXISTS
  // guards, and returns conflict with nothing committed; callers
  // re-read (F1). A PK conflict needs the same millisecond AND the
  // same target as the winner — vanishingly rare — and rolls back
  // the same way. The marker id is unique per job because
  // transitions are monotonic: forward-only along DEPLOY_ORDER, one
  // cancelling entry (repeat cancels replay), terminal once.
  const markerId = `ev_${job.id}_${from}_${to}`;
  const errJson = to === 'failed' ? JSON.stringify({ code, detail: detail.slice(0, 500) }) : '{}';
  const stmts = [
    db.prepare(TRANSITION_SQL.update)
      .bind(to, errJson, now, job.id, from),
    db.prepare(TRANSITION_SQL.marker)
      .bind(markerId, job.id, now, from, to, detail.slice(0, 500), job.id, to, now),
  ];
  if ((to === 'failed' || to === 'cancelled') && opts.release !== false) {
    stmts.push(db.prepare(TRANSITION_SQL.release)
      .bind(now, job.id, markerId, job.id, to, now));
  }
  let out;
  try {
    out = await db.batch(stmts);
  } catch (batchError) {
    // Same-millisecond same-target losers PK-conflict on the
    // deterministic marker id; re-read to distinguish that from a
    // genuine failure (F2 pattern).
    const current = await first(db, 'SELECT state FROM catalog_deployments WHERE id = ?', job.id);
    if (!current || current.state !== from) return { ok: false, conflict: true, error: `Deployment moved under this write (saw ${from}).` };
    throw batchError;
  }
  if (Number(out && out[0] && out[0].meta ? out[0].meta.changes : 0) !== 1) {
    return { ok: false, conflict: true, error: `Deployment moved under this write (saw ${from}).` };
  }
  return { ok: true };
}

// Late-receipt audit: terminal jobs never transition, but a worker receipt
// that arrives after the fact is evidence, not nothing. Recorded without
// applying; consecutive identical notes are not spammed (F9).
// Idempotent note: appends a non-transition event unless the latest event
// already says the same thing (keeps quiet-worker polling from spamming).
async function noteEvent(db, jobId, detail) {
  const last = await first(db, 'SELECT detail FROM catalog_deployment_events WHERE deployment_id = ? ORDER BY rowid DESC LIMIT 1', jobId);
  if (last && last.detail === detail) return;
  await run(db, 'INSERT INTO catalog_deployment_events (id, deployment_id, at, from_state, to_state, detail) VALUES (?, ?, ?, ?, ?, ?)',
    rid('ev_'), jobId, nowIso(), '', '', detail.slice(0, 500));
}

async function auditLateReceipt(db, jobId, receipt) {
  const last = await first(db, 'SELECT detail FROM catalog_deployment_events WHERE deployment_id = ? ORDER BY rowid DESC LIMIT 1', jobId);
  const detail = `late receipt ignored (job already terminal): ${String(receipt.status).slice(0, 64)}`;
  if (last && last.detail === detail) return;
  await run(db, 'INSERT INTO catalog_deployment_events (id, deployment_id, at, from_state, to_state, detail) VALUES (?, ?, ?, ?, ?, ?)',
    rid('ev_'), jobId, nowIso(), '', '', detail);
}

// Deployment API shapes. The full shape carries the immutable plan
// summary plus the live reservation state; the list shape stays lean.
function catalogDeploymentLite(r) {
  const plan = JSON.parse(r.plan_json);
  return {
    id: r.id, state: r.state, nodeId: r.node_id, runtime: r.runtime,
    assetId: plan.asset.id, revision: plan.asset.revision,
    estimateTotalBytes: plan.estimateTotalBytes,
    error: r.state === 'failed' ? JSON.parse(r.error_json || '{}') : null,
    scripted: !!plan.fixtureScript,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

async function catalogDeploymentShape(db, r) {
  const plan = JSON.parse(r.plan_json);
  const res = await first(db, 'SELECT state, bytes, created_at FROM catalog_reservations WHERE deployment_id = ?', r.id);
  return {
    ...catalogDeploymentLite(r),
    plan: {
      asset: plan.asset, adapter: plan.adapter, base: plan.base,
      nodeId: plan.nodeId, runtime: plan.runtime,
      context: plan.context, concurrency: plan.concurrency,
      planFingerprint: plan.planFingerprint, opId: plan.opId,
    },
    reservation: res ? { state: res.state, bytes: res.bytes, heldSince: res.created_at } : null,
  };
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
    const schemaOk = hasDb && await schemaReady(env.DB, federationEnabled(env), dgmPreviewEnabled(env));
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
      // what existed. Capability snapshots and held reservations reference
      // the node by FK (0018/0019), so their rows are deleted too; without
      // this the batch fails under FK enforcement and the node cannot be
      // removed. Deployment history rows carry no FK and are retained.
      // Pairing claims keep their history with resource_id
      // nulled, which the reclaim path treats as invalid. The heartbeat
      // intake's row-existence check rejects further beats either way.
      const now = nowIso();
      const owned = `EXISTS(SELECT 1 FROM resources r JOIN "user" u ON u.id = r.owner_id WHERE r.id = ? AND r.owner_id = ? AND u.disabled = 0)`;
      const deleted = await db.batch([
        db.prepare(`DELETE FROM node_capabilities WHERE node_id = ? AND ${owned}`).bind(r.id, r.id, me()),
        db.prepare(`DELETE FROM catalog_reservations WHERE node_id = ? AND ${owned}`).bind(r.id, r.id, me()),
        db.prepare(`DELETE FROM jobs WHERE (resource_id = ? OR grant_id IN (SELECT id FROM grants WHERE resource_id = ?)) AND ${owned}`).bind(r.id, r.id, r.id, me()),
        db.prepare(`DELETE FROM grants WHERE resource_id = ? AND ${owned}`).bind(r.id, r.id, me()),
        db.prepare(`UPDATE key_verifiers SET revoked_at = COALESCE(revoked_at, ?), resource_id = NULL WHERE resource_id = ? AND ${owned}`).bind(now, r.id, r.id, me()),
        db.prepare(`UPDATE pairing_codes SET resource_id = NULL WHERE resource_id = ? AND ${owned}`).bind(r.id, r.id, me()),
        db.prepare(`DELETE FROM idempotency_keys WHERE resource_id = ? AND ${owned}`).bind(r.id, r.id, me()),
        db.prepare(`DELETE FROM resources WHERE id = ? AND owner_id = ? AND EXISTS(SELECT 1 FROM "user" WHERE id = ? AND disabled = 0)`).bind(r.id, me(), me()),
        db.prepare(`INSERT INTO audit (id, at, actor_id, action, target, detail) SELECT ?, ?, ?, 'resource.delete', ?, '' WHERE changes() = 1`).bind(rid('a_'), now, me(), r.id)
      ]);
      if (Number(deleted[7].meta.changes) !== 1) return json(404, { error: 'Resource not found or not yours.', code: 'NOT_FOUND' });
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

  // ---- node capabilities (versioned telemetry report; heartbeat-key auth) ----
  // Separate from the heartbeat intake by design (docs/model-catalog/00):
  // the strict {"usable"} admission path keeps its atomic guarantees, and
  // capability snapshots arrive here under the same key binding. Reports
  // are worker-declared evidence, not verified facts; missing or stale
  // snapshots evaluate as unknown, never fit. Bounded 8 KiB, strict shape.
  {
    const m = /^\/api\/resources\/([A-Za-z0-9_-]{1,64})\/capabilities$/.exec(path);
    if (m && method === 'POST') {
      const resourceId = m[1];
      if (actor.kind === 'session') return json(403, { error: 'Capability reports require a heartbeat-scoped API key; sessions cannot post telemetry.', code: 'KEY_REQUIRED' });
      if (actor.kind === 'expired') return json(401, { error: 'API key expired.', code: 'KEY_EXPIRED' });
      if (actor.kind !== 'key') {
        if (await revokedHeartbeatKey(request, db)) return json(401, { error: 'API key revoked.', code: 'KEY_REVOKED' });
        return json(401, { error: 'Heartbeat API key required.', code: 'AUTH_REQUIRED' });
      }
      if (actor.key.scope !== 'heartbeat') return json(403, { error: 'This API key is not heartbeat-scoped.', code: 'KEY_SCOPE' });
      if (actor.key.resource_id !== resourceId) return json(404, { error: 'Resource not found or not yours.', code: 'NOT_FOUND' });
      const target = await first(db, 'SELECT owner_id FROM resources WHERE id = ?', resourceId);
      if (!target || target.owner_id !== actor.key.owner_id) return json(404, { error: 'Resource not found or not yours.', code: 'NOT_FOUND' });
      const owner = await first(db, 'SELECT disabled FROM "user" WHERE id = ?', target.owner_id);
      if (!owner || Number(owner.disabled) === 1) return json(401, { error: 'Sign-in or API key required.', code: 'AUTH_REQUIRED' });
      let body;
      try {
        body = await readJson(request, 8 * 1024);
      } catch (error) {
        if (error && error.status) return json(error.status, { error: error.message, code: error.code || 'BAD_REQUEST' });
        throw error;
      }
      const capError = validateCapabilityBody(body);
      if (capError) return json(400, capError);
      // Cost guard fast path: at most one report per 25s window per node.
      // This probe is an optimization only - the conditional UPDATE below
      // still enforces the window atomically, so racers cannot slip
      // through on a shared prior timestamp.
      const prev = await first(db, 'SELECT reported_at FROM node_capabilities WHERE node_id = ?', resourceId);
      if (prev && prev.reported_at) {
        const last = Date.parse(prev.reported_at);
        if (Number.isFinite(last) && HEARTBEAT_MIN_INTERVAL_MS - (Date.now() - last) > 0) {
          return json(429, { error: 'Capability report too soon; back off and retry.', code: 'CAPABILITIES_TOO_SOON', retryAfterSec: 25 }, { 'Retry-After': '25' });
        }
      }
      // Aggregate ceilings (Codex-sec-P2): reports draw from the shared
      // heartbeat budgets, so N nodes cannot multiply past the owner and
      // global write ceilings. Mirror of the heartbeat intake: read-only
      // fast paths, then ONE batch where the liveness UPDATE carries the
      // window + caps + key checks, the snapshot upsert runs only on
      // admission, and the counters chain behind it. An accepted report
      // moves every statement by exactly one; every loser (cap, window,
      // key, owner or resource) writes zero rows. There is no claim to
      // refund. Tail note: the admission UPDATE moves heartbeat_at while
      // the window reads reported_at, so a same-millisecond collision can
      // spuriously lose admission and classify 404; the next retry wins.
      const budgets = heartbeatBudgets(env);
      const hbWindow = heartbeatWindow();
      const quotaSpent = (code, error) => {
        const retrySec = secondsUntilNextHour();
        return json(429, { error, code, retryAfterSec: retrySec }, { 'Retry-After': String(retrySec) });
      };
      const globalCount = await heartbeatBucketCount(db, HEARTBEAT_GLOBAL_ID, hbWindow);
      if (globalCount !== null && globalCount >= budgets.global) return quotaSpent('HEARTBEAT_GLOBAL_QUOTA', 'Deployment heartbeat budget is spent for the hour; back off and retry.');
      if ((await heartbeatBucketCount(db, actor.key.owner_id, hbWindow) ?? 0) >= budgets.owner) return quotaSpent('HEARTBEAT_OWNER_QUOTA', 'Heartbeat budget for this owner is spent for the hour; back off and retry.');
      if (globalCount === null) await pruneHeartbeatBuckets(db, hbWindow);
      const now = nowIso();
      const windowStart = new Date(Date.now() - HEARTBEAT_MIN_INTERVAL_MS).toISOString();
      const [claimed, , ownerCharge, globalCharge] = await db.batch([
        db.prepare(
          `UPDATE resources SET heartbeat_at = ?, online = 1 WHERE id = ?
             AND owner_id = ?
             AND ((SELECT reported_at FROM node_capabilities WHERE node_id = ?) IS NULL
               OR (SELECT reported_at FROM node_capabilities WHERE node_id = ?) <= ?)
             AND EXISTS (SELECT 1 FROM "user" u WHERE u.id = resources.owner_id AND COALESCE(u.disabled, 0) != 1)
             AND EXISTS (SELECT 1 FROM key_verifiers k WHERE k.id = ? AND k.resource_id = ? AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at >= ?))
             AND ${HEARTBEAT_CAPS_SQL}`)
          .bind(now, resourceId, actor.key.owner_id, resourceId, resourceId, windowStart, actor.key.id, resourceId, now,
            actor.key.owner_id, hbWindow, budgets.owner, hbWindow, budgets.global),
        db.prepare(
          `INSERT INTO node_capabilities (node_id, schema_version, reported_at, os, arch, runtimes_json, mem_json, disk_json, workload_json)
           SELECT ?, 1, ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1
           ON CONFLICT(node_id) DO UPDATE SET schema_version = 1, reported_at = excluded.reported_at, os = excluded.os, arch = excluded.arch,
           runtimes_json = excluded.runtimes_json, mem_json = excluded.mem_json, disk_json = excluded.disk_json, workload_json = excluded.workload_json`)
          .bind(resourceId, now, body.os, body.arch, JSON.stringify(body.runtimes), JSON.stringify(body.mem), JSON.stringify(body.disk), JSON.stringify(body.workload || {})),
        ...heartbeatCounterStatements(db, actor.key.owner_id, hbWindow),
      ]);
      if (Number(claimed.meta.changes) === 1) {
        // The batch has committed the report. If a counter upsert did not
        // register its change (a same-millisecond identical upsert moves
        // zero rows), complete the charge rather than leave an accepted
        // report uncharged. This charges, never refunds.
        const [ownerUpsert, globalUpsert] = heartbeatCounterStatements(db, actor.key.owner_id, hbWindow, { unconditional: true });
        if (Number(ownerCharge.meta.changes) !== 1) await ownerUpsert.run();
        if (Number(globalCharge.meta.changes) !== 1) await globalUpsert.run();
        return json(200, { ok: true, nodeId: resourceId, reportedAt: now, schemaVersion: 1 });
      }
      // Admission lost: nothing was written. Map the reason with read-only
      // probes, mirroring the heartbeat classifier.
      if ((await heartbeatBucketCount(db, HEARTBEAT_GLOBAL_ID, hbWindow) ?? 0) >= budgets.global) return quotaSpent('HEARTBEAT_GLOBAL_QUOTA', 'Deployment heartbeat budget is spent for the hour; back off and retry.');
      if ((await heartbeatBucketCount(db, actor.key.owner_id, hbWindow) ?? 0) >= budgets.owner) return quotaSpent('HEARTBEAT_OWNER_QUOTA', 'Heartbeat budget for this owner is spent for the hour; back off and retry.');
      const keyRow = await first(db, 'SELECT revoked_at, expires_at FROM key_verifiers WHERE id = ?', actor.key.id);
      if (!keyRow || keyRow.revoked_at) return json(401, { error: 'API key revoked.', code: 'KEY_REVOKED' });
      if (keyRow.expires_at && Date.parse(keyRow.expires_at) < Date.now()) return json(401, { error: 'API key expired.', code: 'KEY_EXPIRED' });
      const targetNow = await first(db, 'SELECT owner_id FROM resources WHERE id = ?', resourceId);
      if (!targetNow || targetNow.owner_id !== actor.key.owner_id) return json(404, { error: 'Resource not found or not yours.', code: 'NOT_FOUND' });
      const ownerNow = await first(db, 'SELECT disabled FROM "user" WHERE id = ?', targetNow.owner_id);
      if (!ownerNow || Number(ownerNow.disabled) === 1) return json(401, { error: 'Sign-in or API key required.', code: 'AUTH_REQUIRED' });
      const last = await first(db, 'SELECT reported_at FROM node_capabilities WHERE node_id = ?', resourceId);
      if (last && last.reported_at) {
        const at = Date.parse(last.reported_at);
        if (Number.isFinite(at) && HEARTBEAT_MIN_INTERVAL_MS - (Date.now() - at) > 0) {
          return json(429, { error: 'Capability report too soon; back off and retry.', code: 'CAPABILITIES_TOO_SOON', retryAfterSec: 25 }, { 'Retry-After': '25' });
        }
      }
      return json(404, { error: 'Resource not found or not yours.', code: 'NOT_FOUND' });
    }
    if (m && method === 'GET') {
      const d = needAuthz('read'); if (d) return deny(d);
      const node = await catalogNodeAccess(db, actor.user.id, m[1]);
      if (!node) return json(404, { error: 'Resource not found or not shared with you.', code: 'NOT_FOUND' });
      const row = await first(db, 'SELECT * FROM node_capabilities WHERE node_id = ?', m[1]);
      if (!row) return json(200, { nodeId: m[1], snapshot: null, ageMs: null, fresh: false });
      const ageMs = Date.now() - Date.parse(row.reported_at);
      return json(200, {
        nodeId: m[1],
        snapshot: {
          schema_version: row.schema_version, os: row.os, arch: row.arch,
          runtimes: JSON.parse(row.runtimes_json), mem: JSON.parse(row.mem_json),
          disk: JSON.parse(row.disk_json), workload: JSON.parse(row.workload_json),
        },
        reportedAt: row.reported_at,
        ageMs: Number.isFinite(ageMs) ? ageMs : null,
        fresh: Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= TELEMETRY_FRESH_MS,
      });
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
      const net = await grantUsage(db, g.id);
      items.push({ ...mapGrantLite(g), usedJobs: net.used_jobs, usedTokens: net.used_tokens, resourceName: r ? r.name : '(removed)', ownerName: await ownerName(db, g.owner_id), enforcement: 'recorded', policyNote: 'Inference-only grant recorded by the owner; quotas are checked when dispatch is enabled. Dispatch is currently disabled.' });
    }
    return json(200, { ...page, items });
  }
  if (path === '/api/grants' && method === 'GET') {
    const d = needSession(); if (d) return deny(d);
    const q = pagination(url);
    const page = await pageQuery(db, { select: 'SELECT g.*', from: 'FROM grants g JOIN "user" o ON o.id = g.owner_id JOIN "user" r ON r.id = g.grantee_id WHERE g.owner_id = ? AND o.demo = r.demo', params: [me()], order: 'ORDER BY g.created_at DESC', ...q });
    const items = [];
    for (const g of page.items) {
      const net = await grantUsage(db, g.id);
      items.push({ ...mapGrantLite(g), usedJobs: net.used_jobs, usedTokens: net.used_tokens });
    }
    return json(200, { ...page, items });
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
  // Fabric adviser (flag-gated). Authorization precedes routing: anonymous
  // callers get 401 even when the flag is off, so the flag is not an oracle.
  // Demo sessions are served fixtures by the router, never live calls.
  if (path === '/api/advisor' && (method === 'GET' || method === 'POST')) {
    const d = method === 'GET' ? needSession() : (needSession() || needCsrf());
    if (d) return deny(d);
    if (!advisorEnabled(env)) return json(404, { error: 'Not found.', code: 'NOT_FOUND' });
    if (method === 'GET') return json(200, advisorDescriptor(env, { demo: isDemo() }));
    const body = await readJson(request, ADVISOR_BODY_MAX);
    const out = await handleAdvisorPost({ db, env, actor, demo: isDemo(), body, now: new Date() });
    return json(out.status, out.body);
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

  // ---- model catalog, Phase 1: read-only discovery + compatibility ----
  // Browsing never downloads weights, runs inference, or changes a worker
  // (AC01): search/detail serve metadata only, and compat evaluates a pure
  // estimator over worker-reported snapshots. Demo sessions may browse
  // fixture metadata; evaluation, uploads, and deployment stay denied.
  if (path === '/api/catalog/search' && method === 'GET') {
    const d = needAuthz('read'); if (d) return deny(d);
    const q = pagination(url);
    const params = {
      q: (url.searchParams.get('q') || '').slice(0, 128),
      task: (url.searchParams.get('task') || '').slice(0, 64),
      arch: (url.searchParams.get('arch') || '').slice(0, 64),
      format: (url.searchParams.get('format') || '').slice(0, 32),
      quant: (url.searchParams.get('quant') || '').slice(0, 32),
      runtime: (url.searchParams.get('runtime') || '').slice(0, 64),
      license: (url.searchParams.get('license') || '').slice(0, 64),
      kind: (url.searchParams.get('kind') || '').slice(0, 16),
      limit: q.limit, offset: q.offset,
    };
    if (params.kind && params.kind !== 'model' && params.kind !== 'adapter') {
      return json(400, { error: 'kind must be "model" or "adapter".', code: 'BAD_FILTER' });
    }
    const compat = (url.searchParams.get('compat') || '').slice(0, 24);
    const compatNode = (url.searchParams.get('nodeId') || '').slice(0, 64);
    if (compat && !['compatible', 'blocked', 'unknown'].includes(compat)) {
      return json(400, { error: 'compat must be "compatible", "blocked", or "unknown".', code: 'BAD_FILTER' });
    }
    if (compat) {
      // Compat filtering IS evaluation: demo browses but never evaluates.
      // (Demo-only gate: read API keys keep working, no CSRF on a GET.)
      const demoNoEval = needNotDemo();
      if (demoNoEval) return deny(demoNoEval);
    }
    if (compat && !compatNode) {
      return json(400, { error: 'compat filtering needs nodeId: compatibility is per-node, never global.', code: 'BAD_FILTER' });
    }
    try {
      const fixture = isFixtureEnv(env) || isDemo();
      const result = fixture ? fixtureSearch(params) : await hubSearch(params, { admit: () => checkWriteBudget(db, me()) });
      if (!compat) return json(200, { ...result, fixture });
      // Per-item evaluation against the named node only (AC06: nodes are
      // never combined). Snapshot loads once; evaluation is pure.
      const node = await catalogNodeAccess(db, me(), compatNode);
      if (!node) return json(404, { error: 'Resource not found or not shared with you.', code: 'NOT_FOUND' });
      const snap = await catalogSnapshot(db, compatNode);
      const want = compat === 'compatible' ? 'estimated-compatible' : compat;
      const runtime = params.runtime || 'fixture-llama';
      const items = result.items.filter((asset) => {
        if (asset.kind === 'adapter') return want === 'unknown'; // base binding needs the detail flow
        const dec = evaluateCompatibility({ asset, settings: { context: 4096, concurrency: 1, runtime }, snapshot: snap.snapshot, snapshotAgeMs: snap.ageMs, snapshotAt: snap.reportedAt, nodeId: compatNode, principal: me(), nowMs: Date.now() });
        return dec.state === want;
      });
      return json(200, { ...result, items, total: items.length, unfilteredTotal: result.total, fixture, compatFiltered: true });
    } catch (e) {
      if (e && e.hub) return json(e.status || 502, { error: e.message, code: e.code || 'HUB_ERROR', retryable: e.retryable !== false, action: 'Retry shortly, or narrow the search.' });
      throw e;
    }
  }
  {
    const m = /^\/api\/catalog\/assets\/([^/]{1,400})$/.exec(path);
    if (m && method === 'GET') {
      const d = needAuthz('read'); if (d) return deny(d);
      let repo;
      try {
        repo = decodeURIComponent(m[1]);
      } catch {
        return json(400, { error: 'Asset id is not valid encoding.', code: 'BAD_ASSET' });
      }
      if (repo.startsWith('priv:')) {
        // Owner-only: anything else 404s exactly like a missing id (T1).
        const row = await first(db, "SELECT * FROM catalog_assets WHERE id = ? AND owner_id = ? AND access = 'private'", repo.slice(5), me());
        if (!row) return json(404, { error: 'Asset not found.', code: 'ASSET_NOT_FOUND' });
        return json(200, { ...(await privateAssetShape(db, row)), fixture: false });
      }
      const clean = repo.startsWith('hub:') ? repo.slice(4) : repo;
      if (!validateRepoId(clean)) return json(400, { error: 'Repository must look like org/name.', code: 'BAD_REPO' });
      try {
        const fixture = isFixtureEnv(env) || isDemo();
        const asset = fixture ? fixtureDetail(clean) : await hubDetail(clean, { admit: () => checkWriteBudget(db, me()) });
        if (!asset) return json(404, { error: 'Model not found on the Hub.', code: 'ASSET_NOT_FOUND' });
        return json(200, { ...asset, fixture });
      } catch (e) {
        if (e && e.hub) return json(e.status || 502, { error: e.message, code: e.code || 'HUB_ERROR', retryable: e.retryable !== false, action: 'Retry shortly.' });
        throw e;
      }
    }
  }
  if (path === '/api/catalog/compat' && method === 'POST') {
    const d = needAuthz('read'); if (d) return deny(d);
    if (actor.kind === 'session') { const c = needCsrf(); if (c) return deny(c); }
    const nd = needNotDemo(); if (nd) return deny(nd);
    let body;
    try {
      body = await readJson(request);
    } catch (error) {
      if (error && error.status) return json(error.status, { error: error.message, code: error.code || 'BAD_REQUEST' });
      throw error;
    }
    const repo = typeof body.repo === 'string' ? body.repo.slice(0, 200) : '';
    const assetId = typeof body.assetId === 'string' ? body.assetId.slice(0, 200) : '';
    const nodeId = typeof body.nodeId === 'string' ? body.nodeId.slice(0, 64) : '';
    const runtime = typeof body.runtime === 'string' ? body.runtime.slice(0, 64) : '';
    const context = body.context;
    const concurrency = body.concurrency;
    const refOk = (r) => validateRepoId(r) || /^priv:[A-Za-z0-9_-]{1,64}$/.test(r) || (r.startsWith('hub:') && validateRepoId(r.slice(4)));
    if ((repo && assetId) || (!repo && !assetId)) return json(400, { error: 'Supply exactly one of repo or assetId.', code: 'BAD_ASSET_REF' });
    if ((repo && !validateRepoId(repo)) || (assetId && !refOk(assetId))) return json(400, { error: 'Asset ref must be org/name, hub:org/name, or priv:<id>.', code: 'BAD_REPO' });
    if (!isId(nodeId)) return json(400, { error: 'nodeId is required (1..64 id chars).', code: 'BAD_NODE' });
    if (!runtime) return json(400, { error: 'runtime is required.', code: 'BAD_RUNTIME' });
    if (!Number.isSafeInteger(context) || context <= 0 || context > 1048576) {
      return json(400, { error: 'context must be a positive safe integer (≤ 1048576).', code: 'BAD_SETTINGS' });
    }
    if (!Number.isSafeInteger(concurrency) || concurrency <= 0 || concurrency > 1024) {
      return json(400, { error: 'concurrency must be a positive safe integer (≤ 1024).', code: 'BAD_SETTINGS' });
    }
    const adapterRepo = typeof body.adapterRepo === 'string' ? body.adapterRepo.slice(0, 200) : '';
    const baseRepo = typeof body.baseRepo === 'string' ? body.baseRepo.slice(0, 200) : '';
    const adapterAssetId = typeof body.adapterAssetId === 'string' ? body.adapterAssetId.slice(0, 200) : '';
    const baseAssetId = typeof body.baseAssetId === 'string' ? body.baseAssetId.slice(0, 200) : '';
    for (const [label, v] of [['adapter', adapterRepo || adapterAssetId], ['base', baseRepo || baseAssetId]]) {
      if (v && !refOk(v)) return json(400, { error: `${label} ref must be org/name, hub:org/name, or priv:<id>.`, code: 'BAD_REPO' });
    }
    if ((adapterRepo && adapterAssetId) || (baseRepo && baseAssetId)) {
      return json(400, { error: 'Supply one ref form per role, not both.', code: 'BAD_ASSET_REF' });
    }
    if ((adapterRepo || adapterAssetId) && !(baseRepo || baseAssetId)) {
      return json(400, { error: 'Adapter evaluation needs an explicit base: display names never bind a base.', code: 'ADAPTER_BASE_REQUIRED' });
    }
    const node = await catalogNodeAccess(db, me(), nodeId);
    if (!node) return json(404, { error: 'Resource not found or not shared with you.', code: 'NOT_FOUND' });
    try {
      const fixture = isFixtureEnv(env);
      const ref = async (r, role) => resolveCatalogRef(db, env, me(), r, role, () => checkWriteBudget(db, me()));
      const resolved = await ref(repo || assetId, 'Model');
      if (resolved.http) return resolved.http;
      const asset = resolved.asset;
      const unboundEarly = adapterBaseRequired(asset, adapterRepo || adapterAssetId);
      if (unboundEarly) return unboundEarly;
      let adapterAsset = null;
      let baseAsset = asset;
      const adapterRef = adapterRepo || adapterAssetId;
      if (adapterRef) {
        const a = await ref(adapterRef, 'Adapter');
        if (a.http) return a.http;
        const b = await ref(baseRepo || baseAssetId, 'Adapter base');
        if (b.http) return b.http;
        adapterAsset = a.asset;
        baseAsset = b.asset;
      }
      const snap = await catalogSnapshot(db, nodeId);
      const nowMs = Date.now();
      const decision = evaluateCompatibility({
        asset, adapterAsset, baseAsset,
        settings: { context, concurrency, runtime },
        snapshot: snap.snapshot, snapshotAgeMs: snap.ageMs, snapshotAt: snap.reportedAt,
        nodeId, principal: me(), nowMs,
      });
      // Principal-aware cache: the key binds principal + full input
      // fingerprint, so input or policy changes miss (AC09). 5-minute TTL.
      const fp = JSON.stringify(decision.fingerprint);
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${me()}\n${fp}`));
      const cacheKey = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
      const hit = await first(db, 'SELECT decision_json, expires_at, fingerprint_json FROM catalog_compat_cache WHERE cache_key = ? AND principal = ?', cacheKey, me());
      if (hit && Date.parse(hit.expires_at) > nowMs) {
        // A cached decision must not outlive its telemetry: the
        // fingerprint pins the report timestamp, not its freshness, so
        // re-check the snapshot age on every hit (Codex-P2). Missing or
        // unparseable timestamps miss (fail closed → fresh evaluation).
        let fresh = false;
        try {
          const fp = JSON.parse(hit.fingerprint_json || '{}');
          const at = Date.parse(fp.snapshotAt);
          fresh = Number.isFinite(at) && nowMs - at <= TELEMETRY_FRESH_MS;
        } catch { fresh = false; }
        if (fresh) return json(200, { ...JSON.parse(hit.decision_json), cached: true, fixture });
      }
      const decisionJson = JSON.stringify({ ...decision, cached: false });
      // Miss metering (Codex-sec-P2): every miss costs an INSERT plus two
      // hygiene DELETEs and (for hub refs) a Hub metadata fetch, so misses
      // claim the hourly write budget like any other mutating path - varying
      // context/concurrency can no longer burn unbounded shared D1 and
      // outbound quota. Fresh cache hits return above and stay read-only; a
      // spent budget fails the miss closed (429) instead of writing.
      await checkWriteBudget(db, me());
      await run(db, `INSERT INTO catalog_compat_cache (cache_key, principal, fingerprint_json, decision_json, expires_at)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT(cache_key) DO UPDATE SET decision_json = excluded.decision_json, expires_at = excluded.expires_at`,
        cacheKey, me(), fp, decisionJson, decision.expiresAt);
      // Hygiene: prune expired rows and cap per-principal growth (200,
      // provisional) so the display cache cannot grow unbounded (S-F12).
      await run(db, 'DELETE FROM catalog_compat_cache WHERE principal = ? AND expires_at < ?', me(), decision.expiresAt);
      await run(db, `DELETE FROM catalog_compat_cache WHERE principal = ? AND cache_key NOT IN (
        SELECT cache_key FROM catalog_compat_cache WHERE principal = ? ORDER BY expires_at DESC LIMIT 200)`, me(), me());
      return json(200, { ...decision, cached: false, fixture });
    } catch (e) {
      if (e && e.hub) return json(e.status || 502, { error: e.message, code: e.code || 'HUB_ERROR', retryable: e.retryable !== false, action: 'Retry shortly.' });
      throw e;
    }
  }
  if (path === '/api/catalog/summary' && method === 'GET') {
    const d = needAuthz('read'); if (d) return deny(d);
    const assets = await first(db, "SELECT COUNT(*) n FROM catalog_assets WHERE owner_id = ? AND access = 'private'", me());
    const jobs = await first(db, "SELECT COUNT(*) n FROM catalog_deployments WHERE owner_id = ? AND state NOT IN ('ready', 'failed', 'cancelled')", me());
    const refresh = await first(db, 'SELECT MAX(created_at) at FROM jobs WHERE owner_id = ?', me());
    return json(200, {
      privateAssets: assets ? assets.n : 0,
      activeDeployments: jobs ? jobs.n : 0,
      lastRefresh: (refresh && refresh.at) || null,
      uploadsAvailable: storeAvailable(env),
      deploymentAvailable: transportAvailable(env),
      note: storeAvailable(env) ? 'Uploads persist to the bound store.' : 'Upload bytes wait on object storage (docs/model-catalog/01-plan.md); deployment runs against the fixture worker only.',
    });
  }

  // ---- model catalog, Phase 2: private uploads + validation + My assets ----
  // Uploads stay private to the owner tenant (T1): every route re-checks
  // ownership and answers 404 (never 403) for foreign ids. Bytes live in
  // quarantine until validation passes; without a bound object store the
  // byte routes report STORAGE_UNPROVISIONED instead of pretending.
  // Manifests are explicit file lists: traversal, symlinks, archives,
  // executables, and pickle weights are refused (T5/T6).
  if (path === '/api/catalog/uploads' && method === 'POST') {
    const d = needSession() || needCsrf() || needNotDemo(); if (d) return deny(d);
    let body;
    try {
      body = await readJson(request, MAX_BODY_BYTES);
    } catch (error) {
      if (error && error.status) return json(error.status, { error: error.message, code: error.code || 'BAD_REQUEST' });
      throw error;
    }
    if (!isName(body.name)) return json(400, { error: 'Name is required (1..80 chars).', code: 'BAD_NAME' });
    if (body.kind !== 'model' && body.kind !== 'adapter') return json(400, { error: 'kind must be "model" or "adapter".', code: 'BAD_KIND' });
    const files = Array.isArray(body.files) ? body.files : null;
    if (!files || !files.length || files.length > MAX_MANIFEST_FILES) {
      return json(400, { error: `files must name 1..${MAX_MANIFEST_FILES} explicit paths (no archives).`, code: 'BAD_MANIFEST' });
    }
    let total = 0;
    for (const f of files) {
      const bad = catalogRelPath(f && f.relpath);
      if (bad) return json(400, { error: `Refused file name: ${bad}.`, code: 'BAD_PATH' });
      if (!Number.isSafeInteger(f.bytes) || f.bytes <= 0) return json(400, { error: `Unusable byte count for ${f.relpath}.`, code: 'BAD_MANIFEST' });
      if (f.bytes > MAX_FILE_BYTES) return json(400, { error: `${f.relpath} exceeds the per-file cap.`, code: 'QUOTA_EXCEEDED' });
      if (f.sha256 !== undefined && (typeof f.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(f.sha256))) {
        return json(400, { error: `Unusable sha256 hint for ${f.relpath}; digests are server-computed.`, code: 'BAD_MANIFEST' });
      }
      total += f.bytes;
    }
    if (total > MAX_ASSET_BYTES) return json(400, { error: 'Asset exceeds the per-asset cap.', code: 'QUOTA_EXCEEDED' });
    const adapter = body.kind === 'adapter' ? {
      baseAssetId: typeof body.baseAssetId === 'string' ? body.baseAssetId.slice(0, 64) : '',
      baseRevision: typeof body.baseRevision === 'string' ? body.baseRevision.slice(0, 64) : '',
      peftType: typeof body.peftType === 'string' ? body.peftType.slice(0, 16) : 'LORA',
      targetModules: Array.isArray(body.targetModules) ? body.targetModules.map(String).slice(0, 64) : [],
      tokenizer: typeof body.tokenizer === 'string' ? body.tokenizer.slice(0, 200) : '',
    } : null;
    if (body.kind === 'adapter' && (!adapter.baseAssetId || !adapter.baseRevision)) {
      return json(400, { error: 'Adapters must declare an exact base asset id and revision.', code: 'ADAPTER_BASE_REQUIRED' });
    }
    await expireCatalogUploads(db, byteStore(env), me());
    const owned = await first(db, 'SELECT COALESCE(SUM(bytes), 0) n FROM catalog_asset_files WHERE asset_id IN (SELECT id FROM catalog_assets WHERE owner_id = ?)', me());
    const inflight = await first(db, "SELECT COALESCE(SUM(CAST(json_extract(quotas_json, '$.totalBytes') AS INTEGER)), 0) n FROM catalog_uploads WHERE owner_id = ? AND (state IN ('uploading', 'quarantined', 'validating', 'promoting') OR (state = 'rejected' AND byte_ref IS NULL))", me());
    if ((owned ? owned.n : 0) + (inflight ? inflight.n : 0) + total > MAX_ASSET_BYTES) {
      return json(400, { error: 'Account storage quota exceeded.', code: 'QUOTA_EXCEEDED' });
    }
    // Row-growth defense (Codex-sec-P2): every begin inserts an upload row
    // plus an audit row, and the byte quota cannot bound 1-byte manifests.
    // Claim the hourly write budget (same 120/hour as resources/keys/
    // grants) and cap live sessions, mirroring the grants INSERT guard.
    await checkWriteBudget(db, me());
    const now = nowIso();
    const id = rid('up_');
    const expiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    const manifest = {
      name: body.name.trim(), kind: body.kind,
      task: typeof body.task === 'string' ? body.task.slice(0, 64) : 'unknown',
      arch: typeof body.arch === 'string' ? body.arch.slice(0, 64) : 'unknown',
      format: typeof body.format === 'string' ? body.format.slice(0, 32) : 'unknown',
      quant: typeof body.quant === 'string' ? body.quant.slice(0, 32) : 'unknown',
      license: typeof body.license === 'string' ? body.license.slice(0, 200) : 'unstated:rights-reserved',
      provenance: typeof body.provenance === 'string' ? body.provenance.slice(0, 2000) : '',
      tokenizer: typeof body.tokenizer === 'string' ? body.tokenizer.slice(0, 200) : '',
      adapter,
      files: files.map((f) => ({ relpath: f.relpath, bytes: f.bytes, sha256: f.sha256 ? String(f.sha256).toLowerCase() : null })),
    };
    // Atomic admission (Codex-sec-P2): the read-checks above are a fast
    // path only; concurrent begins race them. The INSERT carries both the
    // session-count cap and the aggregate byte budget in ONE statement, so
    // exactly the fitting prefix of a burst admits and losers insert zero
    // rows. No changes() chaining: each predicate reads committed state.
    const admitted = await run(db, `INSERT INTO catalog_uploads (id, owner_id, state, quotas_json, manifest_json, byte_ref, expires_at, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM catalog_uploads WHERE owner_id = ? AND state IN ('uploading', 'quarantined', 'validating', 'promoting')) < ${MAX_ACTIVE_UPLOADS_PER_USER}
      AND (SELECT COALESCE(SUM(bytes), 0) FROM catalog_asset_files WHERE asset_id IN (SELECT id FROM catalog_assets WHERE owner_id = ?))
        + (SELECT COALESCE(SUM(CAST(json_extract(quotas_json, '$.totalBytes') AS INTEGER)), 0) FROM catalog_uploads WHERE owner_id = ? AND (state IN ('uploading', 'quarantined', 'validating', 'promoting') OR (state = 'rejected' AND byte_ref IS NULL)))
        + ? <= ${MAX_ASSET_BYTES}`,
      id, me(), 'uploading', JSON.stringify({ totalBytes: total, files: files.length, parts: { total: 0, bytes: {} } }), JSON.stringify(manifest), null, expiresAt, now, now,
      me(), me(), me(), total);
    if (Number(admitted.meta.changes) !== 1) {
      // Lost admission: classify with read-only probes so the error names
      // the binding constraint (session cap vs byte budget).
      const live = await first(db, "SELECT COUNT(*) n FROM catalog_uploads WHERE owner_id = ? AND state IN ('uploading', 'quarantined', 'validating', 'promoting')", me());
      if (live && live.n >= MAX_ACTIVE_UPLOADS_PER_USER) throw capError('upload');
      return json(400, { error: 'Account storage quota exceeded by concurrent uploads; retry after cleanup.', code: 'QUOTA_EXCEEDED' });
    }
    await audit(db, me(), 'catalog.upload.begin', id, `${manifest.kind} ${manifest.name} ${files.length} files ${total} bytes`);
    return json(201, { id, state: 'uploading', quotas: { totalBytes: total, files: files.length }, expiresAt, chunkMaxBytes: CHUNK_MAX_BYTES, store: storeAvailable(env) ? 'bound' : 'unprovisioned' });
  }
  {
    const m = /^\/api\/catalog\/uploads\/([A-Za-z0-9_-]{1,64})\/(chunk|finalize)$/.exec(path);
    if (m && (method === 'PUT' || method === 'POST')) {
      const d = needSession() || needCsrf() || needNotDemo(); if (d) return deny(d);
      const uploadId = m[1];
      const op = m[2];
      if (op === 'chunk' && method !== 'PUT') return json(405, { error: 'Chunks use PUT.', code: 'BAD_METHOD' });
      if (op === 'finalize' && method !== 'POST') return json(405, { error: 'Finalize uses POST.', code: 'BAD_METHOD' });
      const store = byteStore(env);
      if (!store) return json(503, { error: 'Object storage is not bound: bytes cannot persist. Manifest intake works; chunk upload waits on provisioning.', code: 'STORAGE_UNPROVISIONED', retryable: false, action: 'Ask the rollout owner to bind object storage (docs/model-catalog/01-plan.md).' });
      const up = await first(db, 'SELECT * FROM catalog_uploads WHERE id = ? AND owner_id = ?', uploadId, me());
      if (!up) return json(404, { error: 'Upload not found.', code: 'NOT_FOUND' });
      if (Date.parse(up.expires_at) <= Date.now() && !['validated', 'rejected'].includes(up.state)) {
        await expireCatalogUploads(db, store, me());
        return json(410, { error: 'Upload session expired; start a new one.', code: 'UPLOAD_EXPIRED' });
      }
      const manifest = JSON.parse(up.manifest_json);
      if (op === 'chunk') {
        if (up.state !== 'uploading') return json(409, { error: `Upload is ${up.state}; chunks are accepted only while uploading.`, code: 'UPLOAD_STATE' });
        const relpath = (url.searchParams.get('path') || '').slice(0, 512);
        const declared = manifest.files.find((f) => f.relpath === relpath);
        if (!declared) return json(400, { error: 'Chunk path is not in the declared manifest.', code: 'BAD_PATH' });
        const index = Number(url.searchParams.get('index'));
        if (!Number.isSafeInteger(index) || index < 0 || index > MAX_PARTS_PER_UPLOAD) return json(400, { error: 'Chunk index must be 0..100000.', code: 'BAD_CHUNK' });
        let bytes;
        try {
          bytes = await readBodyBytes(request, CHUNK_MAX_BYTES);
        } catch (error) {
          if (error && error.status) return json(error.status, { error: error.message, code: error.code || 'BAD_REQUEST' });
          throw error;
        }
        if (!bytes.byteLength) return json(400, { error: 'Empty chunk refused.', code: 'BAD_CHUNK' });
        // O(1) chunk accounting (Codex-sec-P2): a per-PUT full-prefix LIST
        // costs O(n) server work per PUT, quadratic per session, so replace
        // detection is one targeted GET and byte/count budgets ride on row
        // counters instead. Same-index replacement subtracts the old bytes
        // first, so transport retries never false-trip; anything beyond
        // declared can never finalize (finalize requires exact fit).
        // Atomic reservation (Codex-P1): concurrent PUTs must not silently
        // lose each other's accounting. The counters write is compare-and-
        // swap on the previously read quotas_json: a conflict re-reads
        // fresh counters and retries, so every recorded write serializes and
        // exactly the fitting prefix of a burst admits. Only chunk PUTs
        // write quotas_json (begin inserts it; every other path writes
        // state/manifest), so a CAS miss means a rival chunk or a state
        // flip, both re-mapped on the next iteration. Reservation precedes
        // persistence: a refusal stores nothing and needs no rollback.
        // Same-key N-racers can overcount by up to N-1 parts (all pre-read
        // one base before any persists): bounded, fail-closed (refuses
        // early), and finalize stays exact because it assembles from the
        // store, never from counters.
        const key = `upload/${uploadId}/part/${String(index).padStart(8, '0')}/${relpath}`;
        let reserved = false;
        let usedNew = false;
        let usedCredit = 0;
        let metered = false;
        for (let attempt = 0; attempt < 3 && !reserved; attempt += 1) {
          // Fresh replace pre-read per attempt: a conflict means a rival
          // moved, so re-derive the credit instead of reusing a stale one.
          // The winning attempt's values freeze below for rollback.
          const existing = await store.get(key);
          const existingLen = existing ? existing.length : 0;
          const live = await first(db, 'SELECT state, quotas_json FROM catalog_uploads WHERE id = ?', uploadId);
          if (!live || live.state !== 'uploading') {
            if (!live || live.state === 'expired') {
              return json(410, { error: 'Upload session expired during chunk write; start a new one.', code: 'UPLOAD_EXPIRED' });
            }
            return json(409, { error: `Upload is ${live.state}; chunks are accepted only while uploading.`, code: 'UPLOAD_STATE' });
          }
          // No shrinking replaces (Codex-P1): a same-index PUT smaller than
          // the stored part is refused. Replacement credits come from a
          // pre-read that overlapping PUTs can share, so two shrinking
          // replaces would each subtract the original bytes and manufacture
          // negative quota. Same-size retries (the transport's only
          // legitimate replace) and growing replaces net zero or positive
          // per op under any interleave - counters can only meet or exceed
          // truth, never manufacture credit - so only the shrinking
          // direction needs the gate. (A stale pre-read can still land a
          // true shrink against grown truth; the credit then under-counts,
          // which stays fail-closed.) Re-chunking starts a new session.
          if (bytes.byteLength < existingLen) {
            return json(400, { error: `Chunk for ${relpath} index ${index} is smaller than the stored ${existingLen} bytes; same-index re-sends must not shrink - start a new upload to re-chunk.`, code: 'SHRINK_REFUSED', retryable: false });
          }
          // Idempotent exact retry (Codex-sec-P2): a same-index re-send with
          // identical bytes is a transport retry, not new data - the bytes
          // are already stored and counted, so answer 200 with no PUT and no
          // D1 write. Without this, one budgeted session replays into
          // unbounded shared R2/D1 operations. State was verified uploading
          // just above.
          if (existing && existing.length === bytes.byteLength && bytesEqual(existing, bytes)) {
            return json(200, { ok: true, uploadId, path: relpath, index, received: bytes.byteLength });
          }
          // Differing re-send metering (R1): the stored bytes are already
          // counted, so a re-send with different bytes that took the CAS
          // path burned D1/R2 writes with possibly zero progress -
          // unboundedly once the budget is spent, since same-size
          // alternation freezes the counters while every body reserves and
          // persists. Each differing re-send therefore claims the hourly
          // write budget once per PUT (CAS retries share the claim): a
          // spent budget 429s before any D1/R2 write, while byte-identical
          // retries return free above. Fresh indexes stay unclaimed
          // (bounded by declaration plus the session/part caps). A claim
          // burned on a later 413/state refusal is bounded fail-closed.
          if (existing && !metered) {
            await checkWriteBudget(db, me());
            metered = true;
          }
          const quotas = JSON.parse(live.quotas_json);
          const pc = quotas.parts || { total: 0, bytes: {} };
          // Prototype-safe counters (Codex-P1): relpaths are client-controlled
          // and `__proto__`/`constructor` are legal names. On a plain object
          // those read inherited members (budgets become NaN, which admits
          // everything) and the `__proto__` write-back is silently dropped. A
          // null-prototype object plus an own-property read keeps every name
          // a plain counter. (JSON round-trips preserve own `__proto__` data
          // properties, and Object.assign onto a null-prototype target cannot
          // trigger the Object.prototype setter, which is not in its chain.)
          pc.bytes = Object.assign(Object.create(null), pc.bytes || {});
          const have = Object.hasOwn(pc.bytes, relpath) ? pc.bytes[relpath] : 0;
          const fileBytes = have - existingLen + bytes.byteLength;
          if (fileBytes > declared.bytes) {
            return json(413, { error: `Chunk exceeds the declared ${declared.bytes} bytes for ${relpath} (${fileBytes - bytes.byteLength} already stored).`, code: 'QUOTA_EXCEEDED' });
          }
          const newTotal = (pc.total || 0) + (existing ? 0 : 1);
          if (newTotal > MAX_PARTS_PER_UPLOAD) {
            return json(413, { error: `Upload holds more than ${MAX_PARTS_PER_UPLOAD} parts; re-chunk with fewer, larger parts.`, code: 'TOO_MANY_PARTS' });
          }
          pc.total = newTotal;
          pc.bytes[relpath] = fileBytes;
          quotas.parts = pc;
          const wrote = await run(db, 'UPDATE catalog_uploads SET quotas_json = ?, updated_at = ? WHERE id = ? AND state = ? AND quotas_json = ?', JSON.stringify(quotas), nowIso(), uploadId, 'uploading', live.quotas_json);
          if (Number(wrote.meta.changes) === 1) { reserved = true; usedNew = !existing; usedCredit = existingLen; }
        }
        if (!reserved) {
          return json(409, { error: 'Chunk raced concurrent writes; retry the chunk.', code: 'UPLOAD_STATE', retryable: true });
        }
        // Roll back one reservation: called when persistence fails or the
        // session leaves uploading under us. Best-effort CAS with no state
        // conjunct (terminal rows accept the correction; it only shrinks
        // held bytes toward truth). A leftover phantom only false-refuses
        // until expiry - finalize stays exact either way.
        const rollbackReservation = async () => {
          for (let i = 0; i < 3; i += 1) {
            const live = await first(db, 'SELECT quotas_json FROM catalog_uploads WHERE id = ?', uploadId);
            if (!live) return;
            const quotas = JSON.parse(live.quotas_json);
            const pc = quotas.parts || { total: 0, bytes: {} };
            pc.bytes = Object.assign(Object.create(null), pc.bytes || {});
            const have = Object.hasOwn(pc.bytes, relpath) ? pc.bytes[relpath] : 0;
            pc.total = Math.max(0, (pc.total || 0) - (usedNew ? 1 : 0));
            pc.bytes[relpath] = Math.max(0, have - (bytes.byteLength - usedCredit));
            quotas.parts = pc;
            const undone = await run(db, 'UPDATE catalog_uploads SET quotas_json = ? WHERE id = ? AND quotas_json = ?', JSON.stringify(quotas), uploadId, live.quotas_json);
            if (Number(undone.meta.changes) === 1) return;
          }
        };
        // Idempotent rewrite: re-sending an index overwrites it, so
        // transport retries never corrupt the assembly (AC13).
        try {
          await store.put(key, new Uint8Array(bytes));
        } catch (error) {
          await rollbackReservation();
          throw error;
        }
        // Post-persist ownership check (Codex-sec-P2): a sweep or verdict
        // may have moved the session while the body persisted. On anything
        // but uploading, reclaim our part, roll back the reservation, and
        // report the terminal state instead of a 200 that orphans bytes.
        // Skipping the delete on a live state would strand the part: the
        // finalizer's lists run BEFORE its verdict write, so a part landing
        // after the list is missed by verdict cleanup and then marked
        // swept/unflagged forever. Deleting can only remove a part a live
        // finalizer listed, and assembly treats that as a retryable race,
        // never a 500.
        const cur = await first(db, 'SELECT state FROM catalog_uploads WHERE id = ?', uploadId);
        if (!cur || cur.state !== 'uploading') {
          await store.del(key).catch(() => {});
          await rollbackReservation();
          if (!cur || cur.state === 'expired') {
            return json(410, { error: 'Upload session expired during chunk write; start a new one.', code: 'UPLOAD_EXPIRED' });
          }
          return json(409, { error: `Upload is ${cur.state}; chunks are accepted only while uploading.`, code: 'UPLOAD_STATE' });
        }
        return json(200, { ok: true, uploadId, path: relpath, index, received: bytes.byteLength });
      }
      // finalize: assemble (bounded), digest, validate, promote atomically.
      if (up.state === 'validated') {
        const asset = await first(db, 'SELECT id FROM catalog_assets WHERE id = ?', up.byte_ref);
        return json(200, { ok: true, uploadId, state: 'validated', assetId: asset ? asset.id : null, duplicate: true });
      }
      if (up.state === 'rejected') {
        return json(422, { error: 'Asset rejected by validation.', code: 'ASSET_REJECTED', checks: manifest.checks || [], duplicate: true });
      }
      // Exclusive finalization claim (Codex-P2): overlapping finalizes
      // must not double-promote. The claim UPDATE below is the linearizer:
      // exactly one requester moves uploading/validating (or a stale
      // promoting lease) to promoting; losers get a retryable 409 and
      // write nothing. A fresh promoting row short-circuits here; a stale
      // one proceeds to steal the dead owner's claim atomically.
      const cutoff = new Date(Date.now() - FINALIZE_CLAIM_MS).toISOString();
      if (up.state === 'promoting' && up.updated_at > cutoff) {
        return json(409, { error: 'Finalization already in progress; retry shortly.', code: 'FINALIZE_IN_PROGRESS', retryable: true });
      }
      if (up.state !== 'uploading' && up.state !== 'validating' && up.state !== 'promoting') {
        return json(409, { error: `Upload is ${up.state}; nothing to finalize.`, code: 'UPLOAD_STATE' });
      }
      const totalBytes = manifest.files.reduce((n, f) => n + f.bytes, 0);
      if (totalBytes > 128 * 1024 * 1024) {
        return json(413, { error: 'Asset exceeds the 128 MiB scaffold finalize cap; streaming promotion is follow-on work.', code: 'ASSET_TOO_LARGE', retryable: false, action: 'Split the asset or wait for streaming promotion.' });
      }
      for (const f of manifest.files) {
        if (f.bytes > MAX_FINALIZE_FILE_BYTES) {
          return json(413, { error: `File ${f.relpath} exceeds the 32 MiB per-file scaffold finalize cap; streaming promotion is follow-on work.`, code: 'ASSET_TOO_LARGE', retryable: false, action: 'Split the file or wait for streaming promotion.' });
        }
      }
      // Fence token (Codex-P2): Workers have no hard wall-time limit, so
      // a holder stalled past its lease may still be alive when a successor
      // steals the claim. Every commit and reset below is fenced on this
      // per-attempt token (byte_ref carries it while promoting): a stale
      // holder's writes match zero rows instead of clobbering its
      // successor, and maps to the winner's outcome via claimLost.
      const claimToken = rid('clm_');
      const claimed = await run(db, "UPDATE catalog_uploads SET state = 'promoting', byte_ref = ?, updated_at = ? WHERE id = ? AND (state IN ('uploading', 'validating') OR (state = 'promoting' AND updated_at <= ?))", claimToken, nowIso(), uploadId, cutoff);
      if (Number(claimed.meta.changes) !== 1) {
        return json(409, { error: 'Finalization already in progress; retry shortly.', code: 'FINALIZE_IN_PROGRESS', retryable: true });
      }
      // A holder that lost its lease mid-flight maps to the winner's
      // outcome: the completed asset when a successor finished, else a
      // retryable 409. Never resets: the row belongs to another claim (or
      // a terminal verdict) now.
      const claimLost = async () => {
        const cur = await first(db, 'SELECT state, byte_ref FROM catalog_uploads WHERE id = ?', uploadId);
        if (cur && cur.state === 'validated') {
          return json(200, { ok: true, uploadId, state: 'validated', assetId: cur.byte_ref, duplicate: true });
        }
        return json(409, { error: 'Finalization claim lost to a concurrent attempt; retry shortly.', code: 'FINALIZE_IN_PROGRESS', retryable: true });
      };
      // The claim holder runs assembly through commit. Explicit refusal
      // paths below reset to uploading before returning; a throw (store
      // or D1 fault) resets in the catch, so every fault stays retryable
      // instead of stranding the upload in promoting until lease expiry.
      // Attempt-prefix reclaim (Codex-sec-P2): pass-2 blobs land under a
      // fresh per-attempt asset id BEFORE the fenced commit, so a fenced-out
      // commit (lost lease, expiry, count bound), a mid-loop raced return,
      // or a store fault would orphan them outside quota with no rows
      // pointing at them - repeatably reachable via lease/expiry races. The
      // commit-fail branch, pass-2 raced returns, and the fault catch below
      // all reclaim the prefix; the marker clears on commit success, so a
      // post-commit fault never touches live blobs. The prefix holds at
      // most one blob per manifest file, and reclaim is best-effort so
      // cleanup never masks the mapped outcome.
      let attemptAssetId = null;
      const reclaimAttemptPrefix = async () => {
        if (!attemptAssetId || !store) return;
        // Reclaim fence (Codex-sec-P2): the prefix is tenant-scoped and the
        // id was reservation-gated, but a raced twin could still have
        // committed under this id after our gate passed. A committed row -
        // or an unreadable one - skips reclaim: a bounded leak, never a
        // delete of data whose ownership is uncertain.
        if (await assetPrefixProtected(db, attemptAssetId)) return;
        const blobs = await store.list(await assetPrefix(me(), attemptAssetId), MAX_MANIFEST_FILES + 1).catch(() => []);
        for (const b of blobs.slice(0, MAX_MANIFEST_FILES)) {
          await store.del(b.key).catch(() => null);
        }
      };
      try {
        // Attempt budget (Codex-sec-P2): every assembly + hash burns
        // real work, so each claim-winning attempt pays the hourly write
        // budget BEFORE any store reads. Claim losers return free above;
        // only the winner pays. A throw here releases the claim in the
        // catch and rethrows, so budget-exhausted sessions retry next
        // window instead of stranding in promoting.
        await checkWriteBudget(db, me());
        const partPrefix = `upload/${uploadId}/part/`;
        const parts = await store.list(partPrefix, MAX_PARTS_PER_UPLOAD + 1);
        if (parts.length > MAX_PARTS_PER_UPLOAD) {
          // Exact session cap (Codex-sec-P2): the chunk counters are a
          // heuristic bound under races, so the limited assembly list is
          // the exact enforcement: cap + 1 keys means over cap, with no
          // second read. The claim releases so a re-chunked session can
          // proceed after the client trims its part count.
          const resetParts = await run(db, "UPDATE catalog_uploads SET state = 'uploading', updated_at = ? WHERE id = ? AND byte_ref = ?", nowIso(), uploadId, claimToken);
          if (Number(resetParts.meta.changes) !== 1) return claimLost();
          return json(413, { error: `Upload holds more than ${MAX_PARTS_PER_UPLOAD} parts; re-chunk with fewer, larger parts.`, code: 'TOO_MANY_PARTS' });
        }
        // Grouped parts (Codex-sec-P2): one pass builds the per-path groups
        // (no per-file filter over the whole prefix - the finalize twin of
        // the status quadratic). store.list returns key-sorted entries, and
        // part keys carry fixed-width indexes, so each group is already in
        // index order.
        const byRel = new Map();
        for (const p of parts) {
          const rel = uploadPartPath(p.key, partPrefix);
          if (!byRel.has(rel)) byRel.set(rel, []);
          byRel.get(rel).push(p);
        }
        // Single-buffer assembly (Codex-sec-P2): each part lands directly in
        // the file flat instead of a retained array, and the flat releases
        // after its digest/screen (pass 1) or asset put (pass 2) - peak is
        // one flat plus one part, never the whole session. Returns the flat,
        // or a raced-409 response when the listing went stale under us: a
        // part vanishing, growing, or shrinking between list and fetch means
        // a concurrent cleanup moved, so the next attempt re-lists fresh
        // instead of throwing a 500 or burning a digest strike. Pass 2 also
        // passes the pass-1 digest (Codex-P1): a chunk PUT that reserved
        // before the claim can land between the two passes, and a
        // same-length replacement sails through the length guards - so the
        // re-assembled bytes re-hash and must match before anything
        // promotes. Digest-match means byte-identical to the screened
        // bytes, so no re-screening is needed.
        const assembleFile = async (mine, f, expectedSha = null) => {
          const raced = async () => {
            const resetRaced = await run(db, "UPDATE catalog_uploads SET state = 'uploading', updated_at = ? WHERE id = ? AND byte_ref = ?", nowIso(), uploadId, claimToken);
            if (Number(resetRaced.meta.changes) !== 1) return claimLost();
            return json(409, { error: 'Upload changed during assembly; retry finalize.', code: 'FINALIZE_IN_PROGRESS', retryable: true });
          };
          const flat = new Uint8Array(f.bytes);
          let at = 0;
          for (const p of mine) {
            const b = await store.get(p.key);
            if (b === null || b === undefined || at + b.length > flat.length) return raced();
            flat.set(b, at);
            at += b.length;
          }
          if (at !== f.bytes) return raced();
          if (expectedSha !== null) {
            const reDigest = await crypto.subtle.digest('SHA-256', flat);
            const reSha = Array.from(new Uint8Array(reDigest), (x) => x.toString(16).padStart(2, '0')).join('');
            if (reSha !== expectedSha) return raced();
          }
          return flat;
        };
        // Pass 1: assemble + digest + screen each file, releasing after
        // every file. At most one shard-index head (<=1 MiB) is retained
        // for the manifest-level verdict below.
        const byteChecks = [];
        const payloads = new Map();
        let shard = null;
        for (const f of manifest.files) {
          const mine = byRel.get(f.relpath) || [];
          const order = mine.map((p) => Number(p.key.split('/')[3]));
          if (!order.length || !order.every((v, i) => v === i)) {
            const resetContig = await run(db, "UPDATE catalog_uploads SET state = 'uploading', updated_at = ? WHERE id = ? AND byte_ref = ?", nowIso(), uploadId, claimToken);
            if (Number(resetContig.meta.changes) !== 1) return claimLost();
            return json(400, { error: `Incomplete bytes for ${f.relpath}: chunk indexes are not contiguous from 0 (got ${order.join(',')}); never guessed, never skipped.`, code: 'UPLOAD_INCOMPLETE' });
          }
          const got = mine.reduce((n, p) => n + p.size, 0);
          if (got !== f.bytes) {
            const resetBytes = await run(db, "UPDATE catalog_uploads SET state = 'uploading', updated_at = ? WHERE id = ? AND byte_ref = ?", nowIso(), uploadId, claimToken);
            if (Number(resetBytes.meta.changes) !== 1) return claimLost();
            return json(400, { error: `Incomplete bytes for ${f.relpath}: ${got} of ${f.bytes}. Missing chunks are never skipped.`, code: 'UPLOAD_INCOMPLETE' });
          }
          const flat = await assembleFile(mine, f);
          if (!(flat instanceof Uint8Array)) return flat;
          const digest = await crypto.subtle.digest('SHA-256', flat);
          const sha = Array.from(new Uint8Array(digest), (x) => x.toString(16).padStart(2, '0')).join('');
          if (f.sha256 && f.sha256 !== sha) {
            // Digest strikes (Codex-sec-P2): each mismatch burns a full
            // assembly + hash, so three strikes on one session is a terminal
            // reject, not an endless retry loop. The counter persists in the
            // manifest across attempts; incompletes stay retryable (they are
            // the core flow) and are bounded by the attempt budget instead.
            const fails = (manifest.digestFails || 0) + 1;
            manifest.digestFails = fails;
            if (fails >= 3) {
              const doomed = await store.list(`upload/${uploadId}/part/`, 2011);
              for (const p of doomed.slice(0, 2010)) await store.del(p.key);
              const struckMark = doomed.length <= 2010 ? 'swept' : null;
              manifest.checks = [{ code: 'DIGEST_MISMATCH', ok: false, message: `Digest mismatch for ${f.relpath} on 3 attempts: declared bytes differ from received bytes.`, resolve: 'Re-chunk the file and start a new upload.' }];
              manifest.validator = VALIDATOR_VERSION;
              const struckOut = await run(db, 'UPDATE catalog_uploads SET state = ?, manifest_json = ?, byte_ref = ?, updated_at = ? WHERE id = ? AND byte_ref = ?', 'rejected', JSON.stringify(manifest), struckMark, nowIso(), uploadId, claimToken);
              if (Number(struckOut.meta.changes) !== 1) return claimLost();
              await audit(db, me(), 'catalog.upload.reject', uploadId, 'DIGEST_MISMATCH');
              return json(422, { error: 'Asset rejected by validation.', code: 'ASSET_REJECTED', checks: manifest.checks });
            }
            const resetDigest = await run(db, "UPDATE catalog_uploads SET state = 'uploading', manifest_json = ?, updated_at = ? WHERE id = ? AND byte_ref = ?", JSON.stringify(manifest), nowIso(), uploadId, claimToken);
            if (Number(resetDigest.meta.changes) !== 1) return claimLost();
            return json(400, { error: `Digest mismatch for ${f.relpath}: declared bytes differ from received bytes.`, code: 'DIGEST_MISMATCH' });
          }
          f.sha256 = sha;
          if (isByteEligible(f)) {
            const screened = validateFileBytes(f, flat.slice(0, MAX_HEADER_PEEK));
            byteChecks.push(...screened.checks);
            if (Number.isSafeInteger(screened.tensorBytes)) payloads.set(f.relpath.toLowerCase(), screened.tensorBytes);
            if (screened.screened && f.relpath.toLowerCase().endsWith('.index.json')) {
              shard = { relpath: f.relpath, head: flat.slice(0, MAX_MANIFEST_BYTES) };
            }
          }
        }
        const verdictOpts = manifest.kind === 'adapter' ? {
          adapter: {
            baseAssetId: manifest.adapter.baseAssetId, baseRevision: manifest.adapter.baseRevision,
            targetModules: manifest.adapter.targetModules, tokenizer: manifest.adapter.tokenizer,
          },
        } : {};
        verdictOpts.payloads = payloads;
        const verdict = validateManifestStructure(manifest, shard, byteChecks, verdictOpts);
        manifest.checks = verdict.checks;
        manifest.validator = verdict.version;
        if (!verdict.ok) {
          // Reclaim quarantine bytes BEFORE the verdict write (Codex-P1):
          // a fully drained reject is marked byte_ref 'swept' and leaves
          // quota; a partial drain stays NULL so quota stays held until
          // the sweep backstop drains it (Codex-sec-P2). Cleanup-first
          // also keeps a store fault retryable (the session stays
          // promoting; no verdict is half-reported).
          const doomed = await store.list(`upload/${uploadId}/part/`, 2011);
          for (const p of doomed.slice(0, 2010)) await store.del(p.key);
          const sweptMark = doomed.length <= 2010 ? 'swept' : null;
          const verdictWrote = await run(db, 'UPDATE catalog_uploads SET state = ?, manifest_json = ?, byte_ref = ?, updated_at = ? WHERE id = ? AND byte_ref = ?', 'rejected', JSON.stringify(manifest), sweptMark, nowIso(), uploadId, claimToken);
          if (Number(verdictWrote.meta.changes) !== 1) return claimLost();
          await audit(db, me(), 'catalog.upload.reject', uploadId, verdict.checks.filter((c) => !c.ok).map((c) => c.code).join(','));
          return json(422, { error: 'Asset rejected by validation.', code: 'ASSET_REJECTED', checks: verdict.checks });
        }
        // Quota is re-checked at finalize: a concurrent promotion may have
        // landed since begin (F15). owned + inflight (self included) is the
        // post-promote footprint. Two racing finalizes can still both pass
        // (check-then-act): like F8 (see the 0019 header), true admission
        // atomicity needs a live-gate transport — over-admission is bounded
        // to one footprint and visible to every later check (N5).
        const ownedNow = await first(db, 'SELECT COALESCE(SUM(bytes), 0) n FROM catalog_asset_files WHERE asset_id IN (SELECT id FROM catalog_assets WHERE owner_id = ?)', me());
        const inflightNow = await first(db, "SELECT COALESCE(SUM(CAST(json_extract(quotas_json, '$.totalBytes') AS INTEGER)), 0) n FROM catalog_uploads WHERE owner_id = ? AND (state IN ('uploading', 'quarantined', 'validating', 'promoting') OR (state = 'rejected' AND byte_ref IS NULL))", me());
        if ((ownedNow ? ownedNow.n : 0) + (inflightNow ? inflightNow.n : 0) > MAX_ASSET_BYTES) {
          const resetQuota = await run(db, "UPDATE catalog_uploads SET state = 'uploading', updated_at = ? WHERE id = ? AND byte_ref = ?", nowIso(), uploadId, claimToken);
          if (Number(resetQuota.meta.changes) !== 1) return claimLost();
          return json(400, { error: 'Account storage quota exceeded by a concurrent promotion; retry after cleanup.', code: 'QUOTA_EXCEEDED' });
        }
        // Cumulative file cap, fast path (Codex-sec-P2): one 2000-file
        // manifest must not fan out into 2000 durable rows per budget
        // claim without bound. The commit batch re-checks this over fresh
        // committed state (below); this pre-check fails friendly and early.
        // (Ordering vs the adapter-base refusal below is irrelevant: both
        // are pre-work refusals with identical reset shapes.)
        const ownedFiles = await first(db, 'SELECT COUNT(*) n FROM catalog_asset_files WHERE asset_id IN (SELECT id FROM catalog_assets WHERE owner_id = ?)', me());
        if (ownedFiles && ownedFiles.n + manifest.files.length > MAX_ASSET_FILES_PER_USER) {
          const resetFiles = await run(db, "UPDATE catalog_uploads SET state = 'uploading', updated_at = ? WHERE id = ? AND byte_ref = ?", nowIso(), uploadId, claimToken);
          if (Number(resetFiles.meta.changes) !== 1) return claimLost();
          throw capError('files');
        }
        if (manifest.kind === 'adapter') {
          // The declared base must resolve to an owned asset (F18).
          // Hub-form bases pass through: offline verification is impossible
          // and live resolution is a documented live-gate.
          const baseId = manifest.adapter.baseAssetId;
          if (!baseId.includes('/') && !baseId.startsWith('hub:')) {
            const base = await first(db, 'SELECT id FROM catalog_assets WHERE id = ? AND owner_id = ?', baseId, me());
            if (!base) {
              const resetBase = await run(db, "UPDATE catalog_uploads SET state = 'uploading', updated_at = ? WHERE id = ? AND byte_ref = ?", nowIso(), uploadId, claimToken);
              if (Number(resetBase.meta.changes) !== 1) return claimLost();
              return json(422, { error: `Adapter base asset not found: ${baseId}.`, code: 'BASE_NOT_FOUND' });
            }
          }
        }
        // Promote: every file lands under the asset prefix before any row
        // points at it; the DB writes commit in one batch (AC12).
        // Quarantine is cleaned only AFTER the batch commits, so a failed
        // promote stays retryable (Codex-P2). External (`org/model`,
        // `hub:`) adapter bases leave the local base FK null — the
        // manifest keeps the reference — because Hub parents never exist
        // as local rows and FK enforcement would fail the batch.
        const now = nowIso();
        // Exclusive attempt reservation (Codex-sec-P2): pass-2 blobs land
        // before the fenced commit, so the id must be gated before a single
        // blob lands - the D1 primary key only backstops after an overwrite.
        // 128-bit ids under the tenant-scoped prefix, refused when a
        // committed row or any live blob already holds the candidate
        // (bounded retries, then a retryable refusal instead of a reuse). A
        // list fault counts as taken (fail closed); residual same-tenant
        // twin overlap needs a 128-bit collision plus concurrency and is
        // accepted as infeasible (the reclaim fence backstops it anyway).
        let assetId = null;
        for (let i = 0; i < 3 && !assetId; i += 1) {
          const candidate = rid16('a_');
          const taken = await first(db, 'SELECT id FROM catalog_assets WHERE id = ?', candidate);
          if (taken) continue;
          const clashing = await store.list(await assetPrefix(me(), candidate), 1).catch(() => null);
          if (clashing === null || clashing.length) continue;
          assetId = candidate;
        }
        if (!assetId) {
          // Release the claim instead of stranding the session: a lost race
          // here means a successor owns the row, so map to its outcome.
          const reset = await run(db, "UPDATE catalog_uploads SET state = 'uploading', updated_at = ? WHERE id = ? AND byte_ref = ?", nowIso(), uploadId, claimToken);
          if (Number(reset.meta.changes) !== 1) return claimLost();
          return json(503, { error: 'Could not reserve an asset id; retry shortly.', code: 'ID_EXHAUSTED', retryable: true });
        }
        attemptAssetId = assetId;
        const manifestSha = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(manifest.files)));
        const revision = Array.from(new Uint8Array(manifestSha), (x) => x.toString(16).padStart(2, '0')).join('');
        // Pass 2 (Codex-sec-P2): re-assemble each file and put its asset blob,
        // releasing after every put. The verdict above committed to nothing
        // yet, so a failure here stays retryable; a part that moved since
        // pass 1 maps to the same retryable 409 through assembleFile.
        for (const f of manifest.files) {
          const flat = await assembleFile(byRel.get(f.relpath) || [], f, f.sha256);
          if (!(flat instanceof Uint8Array)) { await reclaimAttemptPrefix(); return flat; }
          await store.put(await assetKey(me(), assetId, f.relpath), flat);
        }
        manifest.revision = revision;
        // Pending-cleanup flag commits WITH the verdict (Codex-P2): the
        // inline drain below covers one 2010-slice, and a delete fault or
        // a dead request between commit and a later flag-write would strand
        // quarantine copies on a validated row the sweep never revisits.
        // Small sessions (<= 2010 parts) drain fully inline and carry no
        // flag; a missing key reads as clean.
        if (parts.length > 2010) manifest.cleaned = false;
        const baseIsExternal = manifest.adapter
          ? (manifest.adapter.baseAssetId.includes('/') || manifest.adapter.baseAssetId.startsWith('hub:'))
          : false;
        // Fenced commit (Codex-P2): every statement below is gated on the
        // committed fence token, so a holder that lost its lease mid-flight
        // writes zero rows. No changes() chaining: each predicate reads
        // committed state independently, which is sound on every D1.
        // (Asset blobs put above are reclaimed on a fenced-out commit or
        // any mid-loop raced return by the attempt-prefix cleanup; the
        // marker clears on commit success.)
        const committed = await db.batch([
          db.prepare(`INSERT INTO catalog_assets (id, owner_id, source, repo, revision, kind, task, arch, format, quant, license_json, access, manifest_json, validation, base_asset_id, base_revision, freshness_at, created_at)
            SELECT ?, ?, 'private', ?, ?, ?, ?, ?, ?, ?, ?, 'private', ?, 'validated', ?, ?, ?, ? WHERE (SELECT byte_ref FROM catalog_uploads WHERE id = ? AND state = 'promoting') = ?
            AND (SELECT COUNT(*) FROM catalog_asset_files WHERE asset_id IN (SELECT id FROM catalog_assets WHERE owner_id = ?) AND asset_id != ?) + ? <= ${MAX_ASSET_FILES_PER_USER}`)
            .bind(assetId, me(), manifest.name, revision, manifest.kind, manifest.task, manifest.arch, manifest.format, manifest.quant,
              JSON.stringify({ tags: [manifest.license], evidence: 'owner-declared', note: 'Owner statement, not independently verified.' }),
              JSON.stringify(manifest), manifest.adapter && !baseIsExternal ? manifest.adapter.baseAssetId : null, manifest.adapter ? manifest.adapter.baseRevision : '', now, now, uploadId, claimToken, me(), assetId, manifest.files.length),
          ...manifest.files.map((f) => db.prepare(`INSERT INTO catalog_asset_files (asset_id, relpath, bytes, sha256) SELECT ?, ?, ?, ? WHERE (SELECT byte_ref FROM catalog_uploads WHERE id = ? AND state = 'promoting') = ? AND (SELECT COUNT(*) FROM catalog_asset_files WHERE asset_id IN (SELECT id FROM catalog_assets WHERE owner_id = ?) AND asset_id != ?) + ? <= ${MAX_ASSET_FILES_PER_USER}`)
            .bind(assetId, f.relpath, f.bytes, f.sha256, uploadId, claimToken, me(), assetId, manifest.files.length)),
          db.prepare(`UPDATE catalog_uploads SET state = ?, manifest_json = ?, byte_ref = ?, updated_at = ? WHERE id = ? AND state = 'promoting' AND byte_ref = ? AND (SELECT COUNT(*) FROM catalog_asset_files WHERE asset_id IN (SELECT id FROM catalog_assets WHERE owner_id = ?) AND asset_id != ?) + ? <= ${MAX_ASSET_FILES_PER_USER}`)
            .bind('validated', JSON.stringify(manifest), assetId, now, uploadId, claimToken, me(), assetId, manifest.files.length),
        ]);
        // Every statement above carries the same fence + count predicates
        // (no changes() chaining). The count excludes this batch's own
        // asset id, so each predicate reads committed-others + N no matter
        // how many of the batch's own rows are already visible: they pass
        // or fail together, and failures write zero rows. Residual: two
        // promotions from different uploads share no row to linearize on,
        // so concurrent bursts can jointly overshoot by up to one manifest
        // (bounded; same accepted class as the byte over-admission note
        // above). On failure, a lost token maps to the winner outcome; an
        // intact live claim means the count bound bit.
        if (Number(committed[committed.length - 1].meta.changes) !== 1) {
          // No rows landed, but the blobs did: reclaim the attempt
          // prefix before mapping the outcome, whatever it is.
          await reclaimAttemptPrefix();
          attemptAssetId = null;
          // Count loss holds only while the claim is live (promoting +
          // intact token); any other state means a lost claim (steal,
          // expiry, or a successor verdict) and maps to its outcome.
          const cur = await first(db, 'SELECT state, byte_ref FROM catalog_uploads WHERE id = ?', uploadId);
          if (!cur || cur.state !== 'promoting' || cur.byte_ref !== claimToken) return claimLost();
          throw capError('files');
        }
        // Committed: post-commit faults must not touch these blobs.
        attemptAssetId = null;
        // Incremental quarantine cleanup (Codex-sec-P2): the commit above
        // is durable, but deleting every part inline hangs big sessions
        // (each delete is a store round trip). Drain one sweep slice here;
        // leftovers stay flagged in the manifest (persisted in the commit
        // batch above, so a fault here cannot un-flag them) and the expiry
        // sweep drains them on later intakes, exactly like rejected partial
        // drains. The validated asset already charges quota via its asset
        // files; the quarantine copies converge to zero instead of lingering
        // when a marathon cleanup dies mid-loop.
        for (const p of parts.slice(0, 2010)) await store.del(p.key);
        await audit(db, me(), 'catalog.upload.validate', assetId, `${manifest.kind} ${manifest.name} ${manifest.files.length} files`);
        return json(201, { ok: true, uploadId, state: 'validated', assetId, revision });
      } catch (error) {
        // A fault inside the batch call itself may follow committed rows
        // (the call throws after the writes land), and a real death there
        // runs no cleanup at all: reclaim only when the row positively
        // shows a non-commit. An unreadable row (DB fault) skips reclaim:
        // never delete what might be live.
        const failed = await first(db, 'SELECT state, byte_ref FROM catalog_uploads WHERE id = ?', uploadId).catch(() => null);
        if (failed && (failed.state !== 'validated' || failed.byte_ref !== attemptAssetId)) await reclaimAttemptPrefix();
        await run(db, "UPDATE catalog_uploads SET state = 'uploading', updated_at = ? WHERE id = ? AND state = 'promoting' AND byte_ref = ?", nowIso(), uploadId, claimToken);
        throw error;
      }
    }
  }
  {
    const m = /^\/api\/catalog\/uploads\/([A-Za-z0-9_-]{1,64})$/.exec(path);
    if (m && method === 'GET') {
      const d = needSession(); if (d) return deny(d);
      const up = await first(db, 'SELECT * FROM catalog_uploads WHERE id = ? AND owner_id = ?', m[1], me());
      if (!up) return json(404, { error: 'Upload not found.', code: 'NOT_FOUND' });
      const manifest = JSON.parse(up.manifest_json);
      let received = null;
      let truncated = false;
      const store = byteStore(env);
      if (store && ['uploading', 'quarantined', 'validating', 'promoting'].includes(up.state)) {
        // Metered single-pass received accounting (Codex-sec-P2): the list
        // is capped like the assembly list (`truncated` tells when it cuts),
        // one pass builds the per-path totals (no per-file filter over the
        // whole prefix - 2000 files x 100K parts per unmetered GET before),
        // and the list claims the hourly write budget first. The transport
        // never polls this route (it tracks its own progress), so only
        // manual refreshes pay - repeat abuse 429s instead of re-listing.
        await checkWriteBudget(db, me());
        const partPrefix = `upload/${up.id}/part/`;
        const parts = await store.list(partPrefix, MAX_PARTS_PER_UPLOAD + 1);
        truncated = parts.length > MAX_PARTS_PER_UPLOAD;
        const totals = new Map();
        for (const p of parts) {
          const rel = uploadPartPath(p.key, partPrefix);
          totals.set(rel, (totals.get(rel) || 0) + p.size);
        }
        received = manifest.files.map((f) => ({
          relpath: f.relpath, bytes: f.bytes, got: totals.get(f.relpath) || 0,
        }));
      }
      return json(200, {
        id: up.id, state: up.state, manifest: { ...manifest, checks: manifest.checks || undefined },
        received, truncated, assetId: up.state === 'validated' ? up.byte_ref : null, checks: manifest.checks || null,
        expiresAt: up.expires_at, updatedAt: up.updated_at,
      });
    }
  }
  // Intent (review S-F18): asset listing is session-only while single-asset
  // reads allow read keys — listing across assets is the broader capability.
  if (path === '/api/catalog/my-assets' && method === 'GET') {
    const d = needSession(); if (d) return deny(d);
    const q = pagination(url);
    const page = await pageQuery(db, {
      select: 'SELECT a.*, (SELECT COUNT(*) FROM catalog_asset_files f WHERE f.asset_id = a.id) file_count, (SELECT COALESCE(SUM(bytes), 0) FROM catalog_asset_files f WHERE f.asset_id = a.id) total_bytes',
      from: "FROM catalog_assets a WHERE a.owner_id = ? AND a.access = 'private'", params: [me()], order: 'ORDER BY a.created_at DESC', ...q,
    });
    return json(200, {
      ...page,
      items: page.items.map((a) => ({
        id: `priv:${a.id}`, name: a.repo, kind: a.kind, task: a.task, arch: a.arch,
        format: a.format, quant: a.quant, revision: a.revision, validation: a.validation,
        files: a.file_count, totalBytes: a.total_bytes,
        license: JSON.parse(a.license_json), createdAt: a.created_at,
      })),
    });
  }
  {
    const m = /^\/api\/catalog\/assets\/([A-Za-z0-9_-]{1,64})\/validate$/.exec(path);
    if (m && method === 'POST') {
      const d = needSession() || needCsrf() || needNotDemo(); if (d) return deny(d);
      const store = byteStore(env);
      if (!store) return json(503, { error: 'Object storage is not bound: bytes cannot be re-read.', code: 'STORAGE_UNPROVISIONED', retryable: false });
      const asset = await first(db, "SELECT * FROM catalog_assets WHERE id = ? AND owner_id = ? AND access = 'private'", m[1], me());
      if (!asset) return json(404, { error: 'Asset not found.', code: 'NOT_FOUND' });
      const files = await all(db, 'SELECT relpath, bytes, sha256 FROM catalog_asset_files WHERE asset_id = ?', asset.id);
      const totalBytes = files.reduce((n, f) => n + f.bytes, 0);
      if (totalBytes > 128 * 1024 * 1024) return json(413, { error: 'Asset exceeds the 128 MiB scaffold validation cap.', code: 'ASSET_TOO_LARGE' });
      // Row-growth defense (Codex-sec-P2): revalidation re-reads headers
      // and writes an audit row, so it claims the hourly write budget like
      // every other mutating route - before any store reads or writes. (Two
      // D1 classification SELECTs above necessarily precede it for the
      // 404/413 refusals.)
      await checkWriteBudget(db, me());
      const manifest = JSON.parse(asset.manifest_json);
      // Intent (review F19): revalidation re-reads bounded header peeks, not
      // full bytes — a drift check against stored digests, not a re-ingest.
      // Streaming drift check (Codex-sec-P2): screen each file's bounded head
      // while walking, retaining only the qualifying shard-index head (<=1 MiB)
      // for the verdict - no per-file peek map (2000 x 64 KB before). The index
      // head reads at manifest depth like finalize, so both verdicts agree in
      // the 64KB-1MB band; magic/safetensors screens read the same leading
      // bytes either way.
      const byteChecks = [];
      const payloads = new Map();
      let shard = null;
      for (const f of files) {
        if (!isByteEligible(f)) continue;
        const head = await store.peek(await assetKey(asset.owner_id, asset.id, f.relpath), MAX_HEADER_PEEK);
        const b = validateFileBytes(f, head);
        byteChecks.push(...b.checks);
        if (Number.isSafeInteger(b.tensorBytes)) payloads.set(f.relpath.toLowerCase(), b.tensorBytes);
        if (b.screened && f.relpath.toLowerCase().endsWith('.index.json')) {
          // Fall back to the screened head: asset blobs are immutable once
          // promoted, so a vanishing blob here is unreachable in practice -
          // but a null head must never throw below.
          const full = await store.peek(await assetKey(asset.owner_id, asset.id, f.relpath), MAX_MANIFEST_BYTES);
          shard = { relpath: f.relpath, head: full === null || full === undefined ? head : full };
        }
      }
      const verdictOpts = manifest.kind === 'adapter' ? {
        adapter: {
          baseAssetId: manifest.adapter.baseAssetId, baseRevision: manifest.adapter.baseRevision,
          targetModules: manifest.adapter.targetModules, tokenizer: manifest.adapter.tokenizer,
        },
      } : {};
      verdictOpts.payloads = payloads;
      const verdict = validateManifestStructure({ files }, shard, byteChecks, verdictOpts);
      // Idempotent revalidation (Codex-sec-P2): an unchanged verdict is a
      // replay, not an event - skip the rewrite and the audit row, mirroring
      // the duplicate-finalize path. Only a changed verdict writes.
      const nextState = verdict.ok ? 'validated' : 'rejected';
      if (asset.validation === nextState && manifest.validator === verdict.version
        && JSON.stringify(manifest.checks) === JSON.stringify(verdict.checks)) {
        return json(200, { ok: verdict.ok, assetId: asset.id, validation: nextState, checks: verdict.checks, duplicate: true });
      }
      manifest.checks = verdict.checks;
      manifest.validator = verdict.version;
      await run(db, 'UPDATE catalog_assets SET validation = ?, manifest_json = ? WHERE id = ?', nextState, JSON.stringify(manifest), asset.id);
      await audit(db, me(), 'catalog.asset.revalidate', asset.id, nextState);
      return json(200, { ok: verdict.ok, assetId: asset.id, validation: nextState, checks: verdict.checks });
    }
  }

  // ---- model catalog, Phase 3: qualified deployment + durable jobs ----
  // Plans are immutable, principal-bound, 15-minute HMAC tokens over a
  // FRESH estimated-compatible evaluation. Execute re-resolves every pin
  // (refusing drift), re-checks access/revocation/quotas, reserves node
  // bytes, then dispatches. No real worker lifecycle transport exists, so
  // live dispatch fails closed with WORKER_API_UNAVAILABLE; the durable
  // job machinery runs against the scripted fake transport in fixture
  // environments only. Cancel, revocation, timeout, and partial failure
  // all release reservations and record cleanup (AC15-AC21).
  if (path === '/api/catalog/plans' && method === 'POST') {
    const d = needSession() || needCsrf() || needNotDemo(); if (d) return deny(d);
    let body;
    try {
      body = await readJson(request);
    } catch (error) {
      if (error && error.status) return json(error.status, { error: error.message, code: error.code || 'BAD_REQUEST' });
      throw error;
    }
    const refOf = (v) => (typeof v === 'string' ? v.slice(0, 200) : '');
    const refOk = (r) => validateRepoId(r) || /^priv:[A-Za-z0-9_-]{1,64}$/.test(r) || (r.startsWith('hub:') && validateRepoId(r.slice(4)));
    const assetRef = refOf(body.assetRef || body.repo || body.assetId);
    const adapterRef = refOf(body.adapterRef || body.adapterRepo || body.adapterAssetId);
    const baseRef = refOf(body.baseRef || body.baseRepo || body.baseAssetId);
    const nodeId = typeof body.nodeId === 'string' ? body.nodeId.slice(0, 64) : '';
    const runtime = typeof body.runtime === 'string' ? body.runtime.slice(0, 64) : '';
    const context = body.context;
    const concurrency = body.concurrency;
    if (!assetRef || !refOk(assetRef)) return json(400, { error: 'assetRef must be org/name, hub:org/name, or priv:<id>.', code: 'BAD_REPO' });
    if (adapterRef && !refOk(adapterRef)) return json(400, { error: 'adapterRef is malformed.', code: 'BAD_REPO' });
    if (baseRef && !refOk(baseRef)) return json(400, { error: 'baseRef is malformed.', code: 'BAD_REPO' });
    if (adapterRef && !baseRef) return json(400, { error: 'Adapter plans need an explicit base.', code: 'ADAPTER_BASE_REQUIRED' });
    if (!isId(nodeId) || !runtime) return json(400, { error: 'nodeId and runtime are required.', code: 'BAD_PLAN_INPUT' });
    if (!Number.isSafeInteger(context) || context <= 0 || context > 1048576) return json(400, { error: 'context must be 1..1048576.', code: 'BAD_SETTINGS' });
    if (!Number.isSafeInteger(concurrency) || concurrency <= 0 || concurrency > 1024) return json(400, { error: 'concurrency must be 1..1024.', code: 'BAD_SETTINGS' });
    const fixtureScript = body.fixtureScript === undefined ? null : body.fixtureScript;
    if (fixtureScript !== null) {
      if (!isFixtureEnv(env)) return json(400, { error: 'Scripted worker receipts exist in fixture environments only.', code: 'BAD_PLAN_INPUT' });
      if (!Array.isArray(fixtureScript) || fixtureScript.length > 32) return json(400, { error: 'fixtureScript holds at most 32 receipt steps.', code: 'BAD_PLAN_INPUT' });
      if (JSON.stringify(fixtureScript).length > 2048) return json(400, { error: 'fixtureScript is too large; the plan token would exceed the size the server accepts.', code: 'BAD_PLAN_INPUT' });
      for (const s of fixtureScript) {
        if (!s || typeof s !== 'object' || typeof s.status !== 'string') return json(400, { error: 'Each receipt step needs a status.', code: 'BAD_PLAN_INPUT' });
        if ((s.detail !== undefined && typeof s.detail !== 'string') || (s.code !== undefined && typeof s.code !== 'string')) return json(400, { error: 'Receipt detail and code must be strings when present.', code: 'BAD_PLAN_INPUT' });
      }
    }
    const node = await catalogNodeAccess(db, me(), nodeId);
    if (!node) return json(404, { error: 'Resource not found or not shared with you.', code: 'NOT_FOUND' });
    const ref = async (r, role) => resolveCatalogRef(db, env, me(), r, role, () => checkWriteBudget(db, me()));
    const resolved = await ref(assetRef, 'Model');
    if (resolved.http) return resolved.http;
    const asset = resolved.asset;
    let adapterAsset = null;
    let baseAsset = asset;
    if (adapterRef) {
      const a = await ref(adapterRef, 'Adapter');
      if (a.http) return a.http;
      const b = await ref(baseRef, 'Adapter base');
      if (b.http) return b.http;
      adapterAsset = a.asset;
      baseAsset = b.asset;
    }
    const unbound = adapterBaseRequired(asset, adapterRef);
    if (unbound) return unbound;
    const gated = gatedRefusal(asset, adapterAsset);
    if (gated) return gated;
    const snap = await catalogSnapshot(db, nodeId);
    const decision = evaluateCompatibility({
      asset, adapterAsset, baseAsset, settings: { context, concurrency, runtime },
      snapshot: snap.snapshot, snapshotAgeMs: snap.ageMs, snapshotAt: snap.reportedAt,
      nodeId, principal: me(), nowMs: Date.now(),
    });
    if (decision.state !== 'estimated-compatible') {
      return json(422, { error: `Compatibility is ${decision.state}; only estimated-compatible configurations plan.`, code: 'COMPAT_NOT_MET', decision });
    }
    // Row-growth defense (Codex-sec-P2): every plan inserts an audit row,
    // so creation claims the hourly write budget like every other mutating
    // route (429 when spent, before any write).
    await checkWriteBudget(db, me());
    const nowMs = Date.now();
    const payload = {
      v: 1, principal: me(),
      asset: { ref: assetRef, id: asset.id, revision: asset.revision, totalBytes: asset.totalBytes },
      adapter: adapterAsset ? { ref: adapterRef, id: adapterAsset.id, revision: adapterAsset.revision, totalBytes: adapterAsset.totalBytes } : null,
      base: adapterAsset ? { ref: baseRef, id: baseAsset.id, revision: baseAsset.revision } : null,
      nodeId, runtime, context, concurrency,
      estimateTotalBytes: decision.estimate.totalBytes,
      snapshotAt: snap.reportedAt,
      compatFingerprint: decision.fingerprint,
      fixtureScript,
      iat: nowMs, exp: nowMs + 15 * 60 * 1000,
    };
    const fp = JSON.stringify([payload.asset, payload.adapter, payload.base, nodeId, runtime, context, concurrency]);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(fp));
    payload.planFingerprint = Array.from(new Uint8Array(digest), (x) => x.toString(16).padStart(2, '0')).join('');
    const planToken = await signPlanToken(env, payload);
    await audit(db, me(), 'catalog.plan.create', nodeId, `${asset.id}@${asset.revision.slice(0, 12)} -> ${nodeId} ${runtime}`);
    return json(201, {
      planToken,
      expiresAt: new Date(payload.exp).toISOString(),
      plan: {
        asset: payload.asset, adapter: payload.adapter, base: payload.base,
        nodeId, runtime, context, concurrency,
        estimateTotalBytes: payload.estimateTotalBytes,
        planFingerprint: payload.planFingerprint,
      },
    });
  }
  if (path === '/api/catalog/deployments' && method === 'POST') {
    const d = needSession() || needCsrf() || needNotDemo(); if (d) return deny(d);
    let body;
    try {
      body = await readJson(request);
    } catch (error) {
      if (error && error.status) return json(error.status, { error: error.message, code: error.code || 'BAD_REQUEST' });
      throw error;
    }
    const idempotencyKey = typeof body.idempotencyKey === 'string' ? body.idempotencyKey : '';
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(idempotencyKey)) {
      return json(400, { error: 'idempotencyKey must be 8..128 id chars; mint one per execution.', code: 'BAD_IDEMPOTENCY_KEY' });
    }
    const verified = await verifyPlanToken(env, body.planToken, me());
    if (verified.http) return verified.http;
    const plan = verified.plan;
    // Idempotency binds key + principal + exact plan fingerprint (T8):
    // same key + same plan replays the job; same key + different plan is
    // a client bug, never a second execution.
    const prior = await first(db, 'SELECT * FROM catalog_deployments WHERE owner_id = ? AND idem_key = ?', me(), idempotencyKey);
    if (prior) {
      if (prior.plan_fingerprint !== plan.planFingerprint) {
        return json(409, { error: 'Idempotency key was already used for a different plan; mint a fresh key per execution.', code: 'IDEMPOTENCY_MISMATCH' });
      }
      const events = await all(db, 'SELECT * FROM catalog_deployment_events WHERE deployment_id = ? ORDER BY at ASC', prior.id);
      return json(200, { ...(await catalogDeploymentShape(db, prior)), events, duplicate: true });
    }
    const transport = workerTransport(env);
    if (!transport) {
      return json(503, {
        error: 'No worker lifecycle transport exists: download/verify/load/unload/cancel/report are unimplemented (local-worker/EXECUTION-GAPS.md). Nothing was queued.',
        code: 'WORKER_API_UNAVAILABLE', retryable: false,
        action: 'Qualify a worker lifecycle transport first; the plan stays valid for re-execution.',
      });
    }
    if (plan.fixtureScript && !isFixtureEnv(env)) return json(400, { error: 'Scripted receipts cannot execute outside fixture environments.', code: 'BAD_PLAN' });
    // Execute-time re-verification: the cache never authorizes. Access,
    // pins, snapshot freshness, and the full evaluation re-run now.
    const node = await catalogNodeAccess(db, me(), plan.nodeId);
    if (!node) return json(404, { error: 'Resource not found or not shared with you.', code: 'NOT_FOUND' });
    const ref = async (r, role) => resolveCatalogRef(db, env, me(), r, role, () => checkWriteBudget(db, me()));
    const resolved = await ref(plan.asset.ref, 'Model');
    if (resolved.http) return resolved.http;
    let adapterAsset = null;
    let baseAsset = resolved.asset;
    if (plan.adapter) {
      const a = await ref(plan.adapter.ref, 'Adapter');
      if (a.http) return a.http;
      const b = await ref(plan.base.ref, 'Adapter base');
      if (b.http) return b.http;
      adapterAsset = a.asset;
      baseAsset = b.asset;
      if (a.asset.revision !== plan.adapter.revision || b.asset.revision !== plan.base.revision) {
        return json(422, { error: 'Pinned revisions drifted between plan and execute; re-plan.', code: 'PIN_DRIFT' });
      }
    }
    if (resolved.asset.revision !== plan.asset.revision) {
      return json(422, { error: 'Pinned revision drifted between plan and execute; re-plan.', code: 'PIN_DRIFT' });
    }
    const unboundX = adapterBaseRequired(resolved.asset, plan.adapter ? plan.adapter.ref : null);
    if (unboundX) return unboundX;
    const gatedX = gatedRefusal(resolved.asset, adapterAsset);
    if (gatedX) return gatedX;
    const snap = await catalogSnapshot(db, plan.nodeId);
    const decision = evaluateCompatibility({
      asset: resolved.asset, adapterAsset, baseAsset,
      settings: { context: plan.context, concurrency: plan.concurrency, runtime: plan.runtime },
      snapshot: snap.snapshot, snapshotAgeMs: snap.ageMs, snapshotAt: snap.reportedAt,
      nodeId: plan.nodeId, principal: me(), nowMs: Date.now(),
    });
    if (decision.state !== 'estimated-compatible') {
      return json(422, { error: `Compatibility is now ${decision.state}; re-plan from a fresh evaluation.`, code: 'COMPAT_NOT_MET', decision });
    }
    // Admission quotas (AC18): owner-active cap, node-active cap, and
    // byte reservation against fresh availability minus held reservations.
    const ownerActive = await first(db, "SELECT COUNT(*) n FROM catalog_deployments WHERE owner_id = ? AND state NOT IN ('ready', 'failed', 'cancelled')", me());
    if (ownerActive && ownerActive.n >= 5) return json(409, { error: 'Too many active deployments (5). Cancel or wait for one.', code: 'DEPLOYMENT_QUOTA' });
    const nodeActive = await first(db, "SELECT COUNT(*) n FROM catalog_deployments WHERE owner_id = ? AND node_id = ? AND state NOT IN ('ready', 'failed', 'cancelled')", me(), plan.nodeId);
    if (nodeActive && nodeActive.n >= 2) return json(409, { error: 'Too many active deployments on this node (2).', code: 'DEPLOYMENT_QUOTA' });
    const held = await first(db, "SELECT COALESCE(SUM(bytes), 0) n FROM catalog_reservations WHERE node_id = ? AND state = 'held'", plan.nodeId);
    const gpu = snap.snapshot && Array.isArray(snap.snapshot.mem.gpu) ? snap.snapshot.mem.gpu[0] : null;
    const avail = Math.max(0, (gpu ? snap.snapshot.mem.gpu[0].vramAvailBytes : snap.snapshot.mem.ramAvailBytes)
      - (snap.snapshot.workload.reservations || []).reduce((n, r) => n + (Number.isSafeInteger(r.bytes) ? r.bytes : 0), 0)
      - (held ? held.n : 0));
    // Admission checks exactly what the hold will take: the re-evaluated
    // estimate can exceed the plan figure (re-resolution growth), so a
    // single needBytes feeds both the check and the reservation (N4).
    // TOCTOU on `avail` itself stays F8-class (documented residual).
    const needBytes = Math.max(plan.estimateTotalBytes, decision.estimate.totalBytes);
    if (needBytes > avail) {
      return json(409, { error: 'Node memory is over-reserved by concurrent work; retry when capacity frees.', code: 'RESERVATION_EXHAUSTED', availableBytes: avail, neededBytes: needBytes });
    }
    // Row-growth defense (Codex-sec-P2, adjacent to plans): admission
    // inserts deployment + reservation + event + audit rows. The active
    // caps bound concurrent rows only; terminal rows accumulate. Claim the
    // hourly write budget after all refusals, before the batch. Duplicate
    // replays return above, unbilled: they insert nothing.
    await checkWriteBudget(db, me());
    const now = nowIso();
    const id = rid('dep_');
    const opId = rid('wop_');
    const job = { id, owner_id: me(), state: 'queued', plan_fingerprint: plan.planFingerprint, node_id: plan.nodeId };
    try {
      await db.batch([
        db.prepare(`INSERT INTO catalog_deployments (id, owner_id, plan_json, plan_fingerprint, idem_key, state, node_id, runtime, error_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, '{}', ?, ?)`)
          .bind(id, me(), JSON.stringify({ ...plan, opId }), plan.planFingerprint, idempotencyKey, plan.nodeId, plan.runtime, now, now),
        db.prepare('INSERT INTO catalog_reservations (id, deployment_id, owner_id, node_id, bytes, state, created_at, released_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(rid('res_'), id, me(), plan.nodeId, needBytes, 'held', now, null),
        db.prepare('INSERT INTO catalog_deployment_events (id, deployment_id, at, from_state, to_state, detail) VALUES (?, ?, ?, ?, ?, ?)')
          .bind(rid('ev_'), id, now, '', 'queued', 'admitted; reservation held'),
      ]);
    } catch (error) {
      // Lost an idempotency race: the winner's row is authoritative.
      // Re-read by key — replay on fingerprint match, 409 on mismatch,
      // rethrow when no row exists (a genuinely different failure) (F2).
      const winner = await first(db, 'SELECT * FROM catalog_deployments WHERE owner_id = ? AND idem_key = ?', me(), idempotencyKey);
      if (!winner) throw error;
      if (winner.plan_fingerprint !== plan.planFingerprint) {
        return json(409, { error: 'Idempotency key was already used for a different plan; mint a fresh key per execution.', code: 'IDEMPOTENCY_MISMATCH' });
      }
      const wonEvents = await all(db, 'SELECT * FROM catalog_deployment_events WHERE deployment_id = ? ORDER BY at ASC', winner.id);
      return json(200, { ...(await catalogDeploymentShape(db, winner)), events: wonEvents, duplicate: true });
    }
    const accepted = await transport.dispatch({ opId, jobId: id, nodeId: plan.nodeId, script: plan.fixtureScript || [] });
    if (!accepted || accepted.accepted !== true) {
      await transitionDeployment(db, { ...job, state: 'queued' }, 'failed', 'worker transport refused dispatch', 'DISPATCH_FAILED');
      return json(502, { error: 'Worker transport refused dispatch; reservation released.', code: 'DISPATCH_FAILED' });
    }
    await transitionDeployment(db, { ...job, state: 'queued' }, 'admitted', `dispatched as worker op ${opId}`);
    await audit(db, me(), 'catalog.deploy.execute', id, `${plan.asset.id} -> ${plan.nodeId}`);
    const row = await first(db, 'SELECT * FROM catalog_deployments WHERE id = ?', id);
    const events = await all(db, 'SELECT * FROM catalog_deployment_events WHERE deployment_id = ? ORDER BY at ASC', id);
    return json(202, { ...(await catalogDeploymentShape(db, row)), events, duplicate: false });
  }
  if (path === '/api/catalog/deployments' && method === 'GET') {
    const d = needAuthz('read'); if (d) return deny(d);
    const q = pagination(url);
    const page = await pageQuery(db, {
      select: 'SELECT *', from: 'FROM catalog_deployments WHERE owner_id = ?', params: [me()], order: 'ORDER BY created_at DESC', ...q,
    });
    return json(200, { ...page, items: page.items.map((r) => catalogDeploymentLite(r)) });
  }
  {
    // Intent (review F16): the GET status read advances the job by consuming
    // one pending worker receipt, so read-scoped API keys drive progress.
    // That is deliberate: polling is the only transport, and every advance
    // is idempotent receipt application, never a blind mutation.
    const m = /^\/api\/catalog\/deployments\/([A-Za-z0-9_-]{1,64})(\/cancel)?$/.exec(path);
    if (m && (method === 'GET' || method === 'POST')) {
      const isCancel = !!m[2];
      const d = isCancel ? (needSession() || needCsrf() || needNotDemo()) : needAuthz('read');
      if (d) return deny(d);
      const row = await first(db, 'SELECT * FROM catalog_deployments WHERE id = ? AND owner_id = ?', m[1], me());
      if (!row) return json(404, { error: 'Deployment not found.', code: 'NOT_FOUND' });
      if (isCancel && method !== 'POST') return json(405, { error: 'Cancel uses POST.', code: 'BAD_METHOD' });
      if (!isCancel && method !== 'GET') return json(405, { error: 'Use GET for status, POST …/cancel to cancel.', code: 'BAD_METHOD' });
      const transport = workerTransport(env);
      const plan = JSON.parse(row.plan_json);
      if (isCancel) {
        if (TERMINAL_STATES.includes(row.state)) {
          const events = await all(db, 'SELECT * FROM catalog_deployment_events WHERE deployment_id = ? ORDER BY at ASC', row.id);
          return json(200, { ...(await catalogDeploymentShape(db, row)), events, duplicate: true });
        }
        if (row.state === 'cancelling') {
          if (transport) await transport.cancel(plan.opId);
          const events = await all(db, 'SELECT * FROM catalog_deployment_events WHERE deployment_id = ? ORDER BY at ASC', row.id);
          return json(200, { ...(await catalogDeploymentShape(db, row)), events, duplicate: true });
        }
        // Cancel pends until the worker acknowledges: the state moves to
        // `cancelling` first and the request goes out best-effort only on
        // success, so a lost race sends no phantom worker-cancel (N6). The
        // job waits in `cancelling` with its reservation held. A lost race
        // gets one retry on fresh state, then an honest 409 (F1/F9).
        let moved = await transitionDeployment(db, row, 'cancelling', 'cancel requested by owner; worker cancel best-effort; awaiting acknowledgment');
        if (!moved.ok) {
          const retry = await first(db, 'SELECT * FROM catalog_deployments WHERE id = ?', row.id);
          if (TERMINAL_STATES.includes(retry.state) || retry.state === 'cancelling') {
            const events = await all(db, 'SELECT * FROM catalog_deployment_events WHERE deployment_id = ? ORDER BY at ASC', row.id);
            return json(200, { ...(await catalogDeploymentShape(db, retry)), events, duplicate: true });
          }
          moved = await transitionDeployment(db, retry, 'cancelling', 'cancel requested by owner; worker cancel best-effort; awaiting acknowledgment');
          if (!moved.ok) return json(409, { error: 'Deployment moved under the cancel request; refresh and retry.', code: 'DEPLOYMENT_CONFLICT' });
        }
        if (transport) await transport.cancel(plan.opId);
        await audit(db, me(), 'catalog.deploy.cancel', row.id, row.state);
        const fresh = await first(db, 'SELECT * FROM catalog_deployments WHERE id = ?', row.id);
        const events = await all(db, 'SELECT * FROM catalog_deployment_events WHERE deployment_id = ? ORDER BY at ASC', row.id);
        return json(200, { ...(await catalogDeploymentShape(db, fresh)), events, duplicate: false });
      }
      // Status read with fixture reconciliation: each read peeks one
      // pending worker receipt (fixture transport only) and consumes it
      // only after making progress on it, so a race loser destroys
      // nothing (N2). Revocation is re-checked on every advance: lost
      // access fails the flight (AC20). Every transition below is
      // compare-and-swap: on conflict the read re-reads and returns
      // current state instead of writing stale (F1).
      const finishRead = async (orig) => {
        const fresh = await first(db, 'SELECT * FROM catalog_deployments WHERE id = ?', row.id);
        const events = await all(db, 'SELECT * FROM catalog_deployment_events WHERE deployment_id = ? ORDER BY at ASC', row.id);
        return json(200, { ...(await catalogDeploymentShape(db, fresh)), events, reconciled: fresh.state !== orig.state });
      };
      if (TERMINAL_STATES.includes(row.state)) {
        // Late receipts are audited, never applied (F9). An
        // unconfirmed-cancel job additionally reconciles its held
        // reservation here: a terminal worker report releases it, and so
        // does losing node access — the only two authorities that can
        // speak for unknown execution (N1).
        if (transport) {
          const late = await transport.poll(plan.opId);
          if (late.status !== 'unknown') await auditLateReceipt(db, row.id, late);
          const err = row.state === 'failed' ? JSON.parse(row.error_json || '{}') : null;
          if (err && err.code === 'CANCEL_UNCONFIRMED') {
            const acked = late.status === 'cancelled' || late.status === 'failed';
            const accessNow = acked ? true : await catalogNodeAccess(db, me(), row.node_id);
            if (acked || !accessNow) {
              await run(db, "UPDATE catalog_reservations SET state = 'released', released_at = ? WHERE deployment_id = ? AND state = 'held'", nowIso(), row.id);
              await noteEvent(db, row.id, acked
                ? `cancel acknowledged late (${late.status}); reservation released`
                : 'access revoked after unconfirmed cancel; reservation released');
            }
          }
        }
        return finishRead(row);
      }
      if (!transport) return finishRead(row);
      const access = await catalogNodeAccess(db, me(), row.node_id);
      if (!access) {
        const revoked = await transitionDeployment(db, row, 'failed', 'access to the node was revoked mid-flight; worker cancel requested best-effort; worker state UNCONFIRMED; reservation released speculatively', 'REVOKED');
        if (!revoked.ok) return finishRead(row);
        if (transport) await transport.cancel(plan.opId);
        return finishRead(row);
      }
      let receipt = await transport.peek(plan.opId);
      if (receipt.status === 'unknown') {
        // Reconcile by op id: re-dispatch resumes without duplicating
        // work; a second unknown means the worker truly lost it.
        await transport.dispatch({ opId: plan.opId, jobId: row.id, nodeId: row.node_id, script: plan.fixtureScript || [] });
        receipt = await transport.peek(plan.opId);
      }
      if (row.state === 'cancelling') {
        // Only the worker terminal reports (or a finished load) move a
        // cancelling job; anything else is recorded at most (F9).
        if (receipt.status === 'cancelled') {
          const t = await transitionDeployment(db, row, 'cancelled', 'worker acknowledged cancel; reservation released');
          if (!t.ok) return finishRead(row);
          await transport.poll(plan.opId);
          return finishRead(row);
        }
        if (receipt.status === 'failed') {
          const t = await transitionDeployment(db, row, 'failed', `${receipt.code || 'failed'}: ${receipt.detail || 'worker-reported failure while cancelling'}; server-side cleanup NOT verified; reservation released`, typeof receipt.code === 'string' ? receipt.code.slice(0, 64) : null);
          if (!t.ok) return finishRead(row);
          await transport.poll(plan.opId);
          return finishRead(row);
        }
        if (receipt.status === 'ready') {
          const t = await transitionDeployment(db, row, 'ready', 'worker reported ready while cancelling: load finished before cancel landed; reservation held');
          if (!t.ok) return finishRead(row);
          await transport.poll(plan.opId);
          return finishRead(row);
        }
        if (receipt.status === 'unknown') {
          // A silent worker must not hold a cancelling job forever — but
          // unknown execution must not free potentially occupied capacity
          // either. Past the quiet threshold the job fails WITH its
          // reservation held; the hold frees only on a terminal worker
          // report or lost access (see terminal reconciliation above).
          // Authoritative acks above still win first, at any age.
          const quietMs = Date.now() - Date.parse(row.updated_at);
          if (Number.isFinite(quietMs) && quietMs > CANCEL_QUIET_MS) {
            const t = await transitionDeployment(db, row, 'failed',
              `cancel unacknowledged and worker quiet past ${CANCEL_QUIET_MS / 1000}s; execution state UNKNOWN; reservation HELD pending reconciliation — frees only on a terminal worker report or lost access; reconcile on reconnect`,
              'CANCEL_UNCONFIRMED', { release: false });
            if (!t.ok) return finishRead(row);
            return finishRead(row);
          }
          await noteEvent(db, row.id, 'cancel unacknowledged; worker quiet; reservation held');
          return finishRead(row);
        }
        await noteEvent(db, row.id, `observed ${receipt.status} while cancelling; still awaiting cancel acknowledgment`);
        return finishRead(row);
      }
      if (receipt.status === 'unknown') {
        const t = await transitionDeployment(db, row, 'failed', `reconciliation lost: ${receipt.detail || 'worker quiet'}; partial state UNKNOWN; reservation released speculatively — reconcile on reconnect`, 'RECONCILE_LOST');
        if (!t.ok) return finishRead(row);
        return finishRead(row);
      }
      if (receipt.status === 'failed' || receipt.status === 'cancelled') {
        const t = await transitionDeployment(db, row, receipt.status, `${receipt.code || receipt.status}: ${receipt.detail || 'worker-reported terminal state'}; server-side cleanup NOT verified; reservation released`, typeof receipt.code === 'string' ? receipt.code.slice(0, 64) : null);
        if (!t.ok) return finishRead(row);
        await transport.poll(plan.opId);
        return finishRead(row);
      }
      if (['admitted', 'staging', 'verifying', 'loading', 'ready'].includes(receipt.status)) {
        // Duplicate/stale receipts (resume replays the script from the
        // top) are consumed-but-unapplied when the job is already there
        // or past it; a conflicted read consumes nothing, so there is no
        // lost receipt to audit (N2).
        const seen = WORKER_STATES.indexOf(row.state);
        const got = WORKER_STATES.indexOf(receipt.status);
        if (got > seen) {
          const t = await transitionDeployment(db, row, receipt.status, receipt.detail || `worker reports ${receipt.status}`);
          if (!t.ok) return finishRead(row);
          await transport.poll(plan.opId);
          return finishRead(row);
        }
        await transport.poll(plan.opId);
        return finishRead(row);
      }
      const bad = await transitionDeployment(db, row, 'failed', `unrecognized worker receipt: ${String(receipt.status).slice(0, 64)}`, 'BAD_RECEIPT');
      if (!bad.ok) return finishRead(row);
      await transport.poll(plan.opId);
      return finishRead(row);
    }
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

  // ---- administration API scaffold (deny-by-default; reads unavailable, mutations 501) ----
  if (path.startsWith('/api/admin/v1/')) {
    return handleAdmin({ request, env, url, actor, db, json, needCsrf });
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

function panelBase(pathname) {
  if (pathname === '/admin' || pathname === '/admin/' || pathname.startsWith('/admin/')) return '/admin';
  if (pathname === '/app' || pathname === '/app/' || pathname.startsWith('/app/')) return '/app';
  return null;
}

async function serveApp(request, env, pathname) {
  // Panel UIs (/app, /admin) from static assets with app security headers
  // (script-src 'self'). Server authorization still gates every API call;
  // the shell itself carries no authority.
  const base = panelBase(pathname) || '/app';
  const assetPath = pathname === base || pathname === base + '/' ? base + '/index.html' : pathname;
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
      const panel = panelBase(url.pathname);
      if (panel && wrongHost(env, url.origin)) {
        return new Response('Forbidden host.', { status: 403, headers: { ...baseHeaders(), 'Content-Type': 'text/plain' } });
      }
      if (panel && url.pathname === panel && request.method === 'GET') {
        return Response.redirect(url.origin + panel + '/', 302);
      }
      if (panel && url.pathname !== panel) {
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
