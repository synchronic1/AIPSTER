/* Built with Meta Muse. */
// Federation HTTP + MCP router (F1). Mounts under /v1/fabric/* behind the
// FEDERATION_ENABLED flag (env FEDERATION_ENABLED === '1'; default off).
// Shares src/fabric/store.mjs with the MCP dispatcher for parity by
// construction: one code path, one guard set, two transports.
import { readJson } from '../lib/validate.js';
import { digestJson } from './canonical.mjs';
import * as S from './store.mjs';
import { restrictionOf } from './admission.mjs';

export function federationEnabled(env) {
  return !!env && env.FEDERATION_ENABLED === '1';
}

// Worker actor -> fabric actor. Sessions are human. API keys carry narrowing
// authority derived from scope (inference keys may pause/revoke their own
// owner's grants — fail-safe direction only) plus any stored delegate claims
// allowlisted here. No key ever gains propose/commit/approve/decide power:
// those store paths demand kind === 'session'.
const KEY_DELEGATE_ALLOW = new Set(['fabric.propose', 'fabric.pause', 'fabric.revoke']);
export function fabricActor(actor) {
  if (!actor || actor.kind !== 'key') return actor;
  const claims = new Set();
  if (actor.key && actor.key.scope === 'inference') {
    claims.add('fabric.pause');
    claims.add('fabric.revoke');
  }
  try {
    const stored = JSON.parse(actor.key && actor.key.delegate ? actor.key.delegate : '[]');
    if (Array.isArray(stored)) for (const c of stored) if (KEY_DELEGATE_ALLOW.has(c)) claims.add(c);
  } catch { /* unparseable claims authorize nothing */ }
  return { kind: 'key', user: actor.user, keyId: actor.key ? actor.key.id : null, delegate: [...claims] };
}

function send(ctx, out) {
  return ctx.json(out.status, out.body);
}

function sendErr(ctx, e) {
  const status = Number(e && e.status) || 500;
  const code = (e && e.code) || 'INTERNAL';
  const message = status === 500 ? 'Request failed.' : ((e && e.message) || 'Request failed.');
  return ctx.json(status, { error: message, code });
}

// Mutations require an Idempotency-Key; safe replays return the recorded
// response instead of re-executing. bodyHash binds the key to one request.
async function mutate(ctx, fn) {
  const { request, url, db } = ctx;
  let body;
  try {
    body = await readJson(request);
  } catch (e) { return sendErr(ctx, e); }
  const factor = fabricActor(ctx.actor);
  let replay = null;
  try {
    replay = await S.checkIdempotency(db, factor, request.method, url.pathname, request.headers.get('Idempotency-Key'), await digestJson(body === undefined ? null : body),
      request.method === 'POST' ? restrictionOf(url.pathname, null, body) : null);
  } catch (e) { return sendErr(ctx, e); }
  if (replay) return ctx.json(replay.status, { ...replay.body, replayed: true });
  const key = request.headers.get('Idempotency-Key');
  const op = { key, path: url.pathname, attempt: await S.readAttempt(db, `${factor.kind}:${factor.user.id}`, key) };
  let out;
  try {
    out = await fn(factor, body || {}, op);
  } catch (e) {
    // Terminal (4xx) failures finalize the record so the same key replays
    // the same failure instead of wedging on IDEMPOTENCY_PENDING; unknown
    // (5xx) outcomes release the key for a fresh reconciling retry.
    const status = Number(e && e.status) || 500;
    if (status < 500) {
      const failure = { error: (e && e.message) || 'Request failed.', code: (e && e.code) || 'INTERNAL' };
      try { await S.storeIdempotency(db, factor, key, status, failure, op.attempt); } catch { /* fall through to error */ }
      return ctx.json(status, failure);
    }
    try { await S.releaseIdempotency(db, factor, key, op.attempt); } catch { /* fall through to error */ }
    return sendErr(ctx, e);
  }
  try {
    await S.storeIdempotency(db, factor, key, out.status, out.body, op.attempt);
  } catch (e) { return sendErr(ctx, e); }
  return send(ctx, out);
}

// Guards mirror worker.js: session mutations need CSRF; key mutations need
// inference scope (the store re-checks delegate claims); demo fabric is
// read-only — demo users explore their own data but invite/commit nothing.
function guardSessionWrite(ctx) {
  return ctx.needSession() || ctx.needCsrf() || ctx.needNotDemo();
}
function guardNarrow(ctx) {
  const a = ctx.actor;
  if (a.kind === 'session') return ctx.needCsrf() || ctx.needNotDemo();
  if (a.kind === 'key') {
    if (ctx.needNotDemo()) return ctx.needNotDemo();
    if (a.key && a.key.scope === 'inference') return null;
    return ctx.json(403, { error: 'This API key is read-scoped; inference scope required.', code: 'KEY_SCOPE' });
  }
  if (a.kind === 'expired') return ctx.json(401, { error: 'API key expired.', code: 'KEY_EXPIRED' });
  return ctx.json(401, { error: 'Sign-in or API key required.', code: 'AUTH_REQUIRED' });
}

export async function handleFabric(ctx) {
  const { request, url, db } = ctx;
  const path = url.pathname;
  const method = request.method;
  if (!federationEnabled(ctx.env)) {
    return ctx.json(404, { error: 'Unknown API route.', code: 'NOT_FOUND' });
  }
  const factor = () => fabricActor(ctx.actor);
  try {
    // ---- nodes ----
    if (path === '/v1/fabric/nodes' && method === 'POST') {
      const d = guardSessionWrite(ctx); if (d) return d;
      return mutate(ctx, (f, b, op) => S.registerNode(db, f, b, op));
    }
    if (path === '/v1/fabric/nodes' && method === 'GET') {
      const d = ctx.needAuthz('read'); if (d) return d;
      return send(ctx, await S.listNodes(db, factor()));
    }
    {
      const m = /^\/v1\/fabric\/nodes\/([A-Za-z0-9_-]{1,64})$/.exec(path);
      if (m && method === 'GET') {
        const d = ctx.needAuthz('read'); if (d) return d;
        return send(ctx, await S.getNode(db, factor(), m[1]));
      }
    }
    // ---- invitations ----
    if (path === '/v1/fabric/invitations' && method === 'POST') {
      const d = guardSessionWrite(ctx); if (d) return d;
      return mutate(ctx, (f, b, op) => S.createInvitation(db, f, b, op));
    }
    if (path === '/v1/fabric/invitations' && method === 'GET') {
      const d = ctx.needAuthz('read'); if (d) return d;
      const role = url.searchParams.get('role') === 'received' ? 'incoming' : 'outgoing';
      return send(ctx, await S.listInvitations(db, factor(), role));
    }
    if (path === '/v1/fabric/invitations/accept' && method === 'POST') {
      const d = guardSessionWrite(ctx); if (d) return d;
      return mutate(ctx, (f, b, op) => S.acceptInvitation(db, f, b, op));
    }
    {
      const m = /^\/v1\/fabric\/invitations\/([A-Za-z0-9_-]{1,64})\/(decline|revoke)$/.exec(path);
      if (m && method === 'POST') {
        const d = guardSessionWrite(ctx); if (d) return d;
        const id = m[1];
        return mutate(ctx, (f, b, op) => (m[2] === 'decline' ? S.declineInvitation(db, f, id, op) : S.revokeInvitation(db, f, id, op)));
      }
    }
    {
      const m = /^\/v1\/fabric\/invitations\/([A-Za-z0-9_-]{1,64})$/.exec(path);
      if (m && method === 'GET') {
        const d = ctx.needAuthz('read'); if (d) return d;
        return send(ctx, await S.getInvitation(db, factor(), m[1]));
      }
    }
    // ---- connections ----
    if (path === '/v1/fabric/connections' && method === 'GET') {
      const d = ctx.needAuthz('read'); if (d) return d;
      return send(ctx, await S.listConnections(db, factor()));
    }
    {
      const m = /^\/v1\/fabric\/connections\/([A-Za-z0-9_-]{1,64})$/.exec(path);
      if (m && method === 'GET') {
        const d = ctx.needAuthz('read'); if (d) return d;
        return send(ctx, await S.getConnection(db, factor(), m[1]));
      }
    }
    {
      const m = /^\/v1\/fabric\/connections\/([A-Za-z0-9_-]{1,64})\/(suspend|disconnect)$/.exec(path);
      if (m && method === 'POST') {
        const d = guardNarrow(ctx); if (d) return d;
        const id = m[1];
        return mutate(ctx, (f, b, op) => (m[2] === 'suspend' ? S.suspendConnection(db, f, id, b, op) : S.disconnectConnection(db, f, id, b, op)));
      }
    }
    {
      const m = /^\/v1\/fabric\/connections\/([A-Za-z0-9_-]{1,64})\/resume$/.exec(path);
      if (m && method === 'POST') {
        const d = guardSessionWrite(ctx); if (d) return d;
        const id = m[1];
        return mutate(ctx, (f, b, op) => S.resumeConnection(db, f, id, b, op));
      }
    }
    // ---- previews + approvals ----
    if (path === '/v1/fabric/previews' && method === 'POST') {
      const d = guardSessionWrite(ctx); if (d) return d;
      return mutate(ctx, (f, b, op) => S.createPreview(db, f, b, op));
    }
    if (path === '/v1/fabric/approvals' && method === 'POST') {
      const d = guardSessionWrite(ctx); if (d) return d;
      return mutate(ctx, (f, b, op) => S.requestApproval(db, f, b, op));
    }
    if (path === '/v1/fabric/approvals' && method === 'GET') {
      const d = ctx.needAuthz('read'); if (d) return d;
      return send(ctx, await S.listApprovals(db, factor()));
    }
    {
      const m = /^\/v1\/fabric\/approvals\/([A-Za-z0-9_-]{1,64})$/.exec(path);
      if (m && method === 'GET') {
        const d = ctx.needAuthz('read'); if (d) return d;
        return send(ctx, await S.getApproval(db, factor(), m[1]));
      }
    }
    {
      const m = /^\/v1\/fabric\/approvals\/([A-Za-z0-9_-]{1,64})\/decide$/.exec(path);
      if (m && method === 'POST') {
        const d = guardSessionWrite(ctx); if (d) return d;
        const id = m[1];
        return mutate(ctx, (f, b, op) => S.decideApproval(db, f, id, b, op));
      }
    }
    // ---- grants ----
    if (path === '/v1/fabric/grants' && method === 'POST') {
      const d = guardSessionWrite(ctx); if (d) return d;
      return mutate(ctx, (f, b, op) => S.commitGrant(db, f, b, op));
    }
    if (path === '/v1/fabric/grants' && method === 'GET') {
      const d = ctx.needAuthz('read'); if (d) return d;
      const scope = url.searchParams.get('scope');
      return send(ctx, await S.listGrants(db, factor(), scope === 'outgoing' || scope === 'incoming' ? scope : 'all'));
    }
    {
      const m = /^\/v1\/fabric\/grants\/([A-Za-z0-9_-]{1,64})$/.exec(path);
      if (m && method === 'GET') {
        const d = ctx.needAuthz('read'); if (d) return d;
        return send(ctx, await S.getGrant(db, factor(), m[1]));
      }
    }
    {
      const m = /^\/v1\/fabric\/grants\/([A-Za-z0-9_-]{1,64})\/(revise|resume)$/.exec(path);
      if (m && method === 'POST') {
        const d = guardSessionWrite(ctx); if (d) return d;
        const id = m[1];
        return mutate(ctx, (f, b, op) => (m[2] === 'revise' ? S.reviseGrant(db, f, id, b, op) : S.resumeGrant(db, f, id, b, op)));
      }
    }
    {
      const m = /^\/v1\/fabric\/grants\/([A-Za-z0-9_-]{1,64})\/(pause|revoke)$/.exec(path);
      if (m && method === 'POST') {
        const d = guardNarrow(ctx); if (d) return d;
        const id = m[1];
        return mutate(ctx, (f, b, op) => (m[2] === 'pause' ? S.pauseGrant(db, f, id, b, op) : S.revokeGrant(db, f, id, b, op)));
      }
    }
    // ---- denies ----
    if (path === '/v1/fabric/denies' && method === 'POST') {
      const d = guardSessionWrite(ctx); if (d) return d;
      return mutate(ctx, (f, b, op) => S.createDeny(db, f, b, op));
    }
    if (path === '/v1/fabric/denies' && method === 'GET') {
      const d = ctx.needAuthz('read'); if (d) return d;
      return send(ctx, await S.listDenies(db, factor()));
    }
    {
      const m = /^\/v1\/fabric\/denies\/([A-Za-z0-9_-]{1,64})$/.exec(path);
      if (m && method === 'DELETE') {
        const d = guardSessionWrite(ctx); if (d) return d;
        return send(ctx, await S.deleteDeny(db, factor(), m[1], { budgeted: true }));
      }
    }
    // ---- authorization preview + discovery (reads) ----
    if (path === '/v1/fabric/authorization/preview' && method === 'POST') {
      const d = ctx.needAuthz('read'); if (d) return d;
      if (ctx.actor.kind === 'session') { const c = ctx.needCsrf(); if (c) return c; }
      let body;
      try { body = await readJson(request); } catch (e) { return sendErr(ctx, e); }
      return send(ctx, await S.authorizationPreview(db, factor(), body || {}));
    }
    if (path === '/v1/fabric/discovery' && method === 'GET') {
      const d = ctx.needAuthz('read'); if (d) return d;
      return send(ctx, await S.discoverResources(db, factor()));
    }
    // ---- MCP dispatcher (parity: same store calls, same guards) ----
    if (path === '/v1/fabric/mcp' && method === 'POST') {
      return handleMcp(ctx);
    }
  } catch (e) {
    return sendErr(ctx, e);
  }
  return ctx.json(404, { error: 'Unknown API route.', code: 'NOT_FOUND' });
}

// MCP tools call the same store functions behind the same guards as REST.
// Mutating tools take their idempotency key as `idempotencyKey` in the JSON
// envelope (bound to tool name + params) instead of the HTTP header.
const MCP_TOOLS = {
  'fabric.list_nodes': { guard: 'read', run: (db, f, p) => S.listNodes(db, f) },
  'fabric.get_node': { guard: 'read', run: (db, f, p) => S.getNode(db, f, p.id) },
  'fabric.register_node': { guard: 'session', run: (db, f, p, op) => S.registerNode(db, f, p, op) },
  'fabric.create_invitation': { guard: 'session', run: (db, f, p, op) => S.createInvitation(db, f, p, op) },
  'fabric.list_invitations': { guard: 'read', run: (db, f, p) => S.listInvitations(db, f, p.role) },
  'fabric.get_invitation': { guard: 'read', run: (db, f, p) => S.getInvitation(db, f, p.id) },
  'fabric.accept_invitation': { guard: 'session', run: (db, f, p, op) => S.acceptInvitation(db, f, p, op) },
  'fabric.decline_invitation': { guard: 'session', run: (db, f, p, op) => S.declineInvitation(db, f, p.id, op) },
  'fabric.revoke_invitation': { guard: 'session', run: (db, f, p, op) => S.revokeInvitation(db, f, p.id, op) },
  'fabric.list_connections': { guard: 'read', run: (db, f, p) => S.listConnections(db, f) },
  'fabric.get_connection': { guard: 'read', run: (db, f, p) => S.getConnection(db, f, p.id) },
  'fabric.suspend_connection': { guard: 'narrow', run: (db, f, p, op) => S.suspendConnection(db, f, p.id, p, op) },
  'fabric.disconnect_connection': { guard: 'narrow', run: (db, f, p, op) => S.disconnectConnection(db, f, p.id, p, op) },
  'fabric.resume_connection': { guard: 'session', run: (db, f, p, op) => S.resumeConnection(db, f, p.id, p, op) },
  'fabric.create_preview': { guard: 'session', run: (db, f, p, op) => S.createPreview(db, f, p, op) },
  'fabric.request_approval': { guard: 'session', run: (db, f, p, op) => S.requestApproval(db, f, p, op) },
  'fabric.list_approvals': { guard: 'read', run: (db, f, p) => S.listApprovals(db, f) },
  'fabric.get_approval': { guard: 'read', run: (db, f, p) => S.getApproval(db, f, p.id) },
  'fabric.decide_approval': { guard: 'session', run: (db, f, p, op) => S.decideApproval(db, f, p.id, p, op) },
  'fabric.commit_grant': { guard: 'session', run: (db, f, p, op) => S.commitGrant(db, f, p, op) },
  'fabric.list_grants': { guard: 'read', run: (db, f, p) => S.listGrants(db, f, p.scope) },
  'fabric.get_grant': { guard: 'read', run: (db, f, p) => S.getGrant(db, f, p.id) },
  'fabric.revise_grant': { guard: 'session', run: (db, f, p, op) => S.reviseGrant(db, f, p.id, p, op) },
  'fabric.pause_grant': { guard: 'narrow', run: (db, f, p, op) => S.pauseGrant(db, f, p.id, p, op) },
  'fabric.resume_grant': { guard: 'session', run: (db, f, p, op) => S.resumeGrant(db, f, p.id, p, op) },
  'fabric.revoke_grant': { guard: 'narrow', run: (db, f, p, op) => S.revokeGrant(db, f, p.id, p, op) },
  'fabric.create_deny': { guard: 'session', run: (db, f, p, op) => S.createDeny(db, f, p, op) },
  'fabric.list_denies': { guard: 'read', run: (db, f, p) => S.listDenies(db, f) },
  'fabric.delete_deny': { guard: 'session-no-idem', run: (db, f, p) => S.deleteDeny(db, f, p.id, { budgeted: true }) },
  'fabric.authorization_preview': { guard: 'read', run: (db, f, p) => S.authorizationPreview(db, f, p) },
  'fabric.discover_resources': { guard: 'read', run: (db, f, p) => S.discoverResources(db, f) },
};

export async function handleMcp(ctx) {
  const { request, db } = ctx;
  let body;
  try { body = await readJson(request); } catch (e) { return sendErr(ctx, e); }
  const tool = body && body.tool;
  // Baseline auth before the tool lookup: every tool needs at least read
  // credentials, and checking the name first would let anonymous callers
  // enumerate the tool namespace by status code.
  const base = ctx.needAuthz('read');
  if (base) return base;
  const spec = MCP_TOOLS[tool];
  if (!spec) return ctx.json(400, { error: `Unknown tool '${String(tool).slice(0, 64)}'.`, code: 'BAD_TOOL' });
  const params = (body && typeof body.params === 'object' && body.params) || {};
  const f = fabricActor(ctx.actor);
  try {
    if (spec.guard === 'read') {
      const d = ctx.needAuthz('read'); if (d) return d;
      if (ctx.actor.kind === 'session') { const c = ctx.needCsrf(); if (c) return c; }
      const out = await spec.run(db, f, params);
      return ctx.json(out.status, { ok: true, tool, result: out.body });
    }
    if (spec.guard === 'session-no-idem') {
      const d = guardSessionWrite(ctx); if (d) return d;
      const out = await spec.run(db, f, params);
      return ctx.json(out.status, { ok: true, tool, result: out.body });
    }
    const d = spec.guard === 'narrow' ? guardNarrow(ctx) : guardSessionWrite(ctx);
    if (d) return d;
    const key = body.idempotencyKey;
    const ipath = `/v1/fabric/mcp:${tool}`;
    const replay = await S.checkIdempotency(db, f, 'POST', ipath, key, await digestJson(params), restrictionOf(ipath, tool, params));
    if (replay) {
      // Terminal failures replay the same raw error shape as the initial
      // call — never a success envelope — matching REST semantics.
      if (replay.status >= 400) return ctx.json(replay.status, { ...replay.body, replayed: true });
      return ctx.json(replay.status, { ok: true, tool, result: replay.body, replayed: true });
    }
    const mop = { key, path: ipath, attempt: await S.readAttempt(db, `${f.kind}:${f.user.id}`, key) };
    try {
      const out = await spec.run(db, f, params, mop);
      await S.storeIdempotency(db, f, key, out.status, out.body, mop.attempt);
      if (out.status >= 400) return ctx.json(out.status, out.body);
      return ctx.json(out.status, { ok: true, tool, result: out.body });
    } catch (e) {
      const status = Number(e && e.status) || 500;
      if (status < 500) {
        const failure = { error: (e && e.message) || 'Request failed.', code: (e && e.code) || 'INTERNAL' };
        try { await S.storeIdempotency(db, f, key, status, failure, mop.attempt); } catch { /* fall through */ }
        return ctx.json(status, failure);
      }
      try { await S.releaseIdempotency(db, f, key, mop.attempt); } catch { /* fall through */ }
      return sendErr(ctx, e);
    }
  } catch (e) {
    return sendErr(ctx, e);
  }
}
