/* Built with Meta Muse. */
// Federation control-plane core (F1): nodes, invitations, connections,
// previews, approvals, grants, denies, authorization previews. Pure-ish
// async functions over (db, actor, input); HTTP and MCP layers share them.
// Actor: { kind: 'session'|'key', user, keyId, delegate[] }. Fixture
// transports only; no execution, no network peers in F1.
import { first, all } from '../lib/store.js';
import { verifierFor, timingSafeEqualStr } from '../lib/keys.js';
import { httpError } from '../lib/validate.js';
import { checkWriteBudget } from '../lib/quotas.js';
import { admitFabricOperation } from './admission.mjs';
import { canonicalize, digestJson } from './canonical.mjs';
import { evaluate } from './policy.mjs';
import { opDigest, claimApproval, ensureAudit, ensureHistory, historyIdFor, redactForReplay, freshAttempt, readAttempt, restrictionContext, restrictionCompletion, isCommitFailure, pendingCommit } from './operations.mjs';
import { runBatch, changes, creatorInsert, acceptFlip, acceptConnInsert, acceptRecoverInsert, vetoRestrict, vetoWithdraw, grantInsert, grantRevise, grantStatus } from './transitions.mjs';

const err = (status, code, message) => httpError(status, message, code);
// Maps a failed actor-live predicate: disabled/missing users authorize
// nothing (401), demo sessions are read-only on fabric writes (403).
async function throwActorClosed(db, actor) {
  const u = await first(db, 'SELECT disabled, demo FROM "user" WHERE id = ?', actor.user.id);
  if (!u || Number(u.disabled) === 1) throw err(401, 'AUTH_REQUIRED', 'Sign-in or API key required.');
  if (Number(u.demo) === 1) throw err(403, 'DEMO_RESTRICTED', 'The demo account cannot perform this action.');
  throw err(500, 'INTERNAL', 'Request failed.');
}
const needId = (id, kind) => { if (typeof id !== 'string' || !id) throw err(404, 'NOT_FOUND', `${kind} not found.`); };
// Operation-bound entity ids: when the router supplies its idempotency
// context (key + path), created entities derive their ids from it, so a
// retry of the same operation converges on the existing row instead of
// duplicating it — even when a 5xx landed after the first write committed.
// Direct store callers pass no context and keep random ids.
async function opEntityId(actor, op, prefix) {
  if (!op || typeof op.key !== 'string' || !op.key || typeof op.path !== 'string' || !op.path) {
    return `${prefix}_${randHex(8)}`;
  }
  const h = await digestJson(`${actor.kind}:${actor.user.id}:${op.path}:${op.key}`);
  return `${prefix}_${h.slice(0, 16)}`;
}
const nowIso = () => new Date().toISOString();
const randHex = (n) => [...globalThis.crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');
const randB64 = (n) => {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(n));
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const parseJson = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };

// ---- tokens (invitation + node secrets; same pattern as API keys) ----
function mintToken(prefix) {
  const id = `${prefix}_${randHex(8)}`;
  const secret = `${id}_${randB64(32)}`;
  return { id, secret, salt: randHex(16) };
}
function tokenIdPresented(presented, prefix) {
  if (typeof presented !== 'string') return null;
  const m = new RegExp(`^(${prefix}_[0-9a-f]{16})_(.+)$`).exec(presented);
  return m ? { id: m[1], secret: presented } : null;
}
async function verifyToken(presented, row) {
  return !!row && !!row.verifier && timingSafeEqualStr(await verifierFor(presented, row.salt), row.verifier);
}

// ---- actor authority ----
const isHuman = (actor) => actor && actor.kind === 'session';
const isAgentKey = (actor) => !!(actor && actor.kind === 'key' && actor.delegate && actor.delegate.length);
const canPropose = (actor) => isHuman(actor) || (actor.kind === 'key' && (actor.delegate || []).includes('fabric.propose'));
const canNarrow = (actor, action) => isHuman(actor) || (actor.kind === 'key' && (actor.delegate || []).includes(action));
const needHuman = () => { throw err(403, 'HUMAN_REQUIRED', 'This decision requires an interactive owner session; API keys cannot approve access expansions.'); };

async function ownNode(db, actor, nodeId) {
  if (typeof nodeId !== 'string' || !nodeId) throw err(404, 'NOT_FOUND', 'Node not found or not yours.');
  const node = await first(db, 'SELECT * FROM fabric_nodes WHERE id = ?', nodeId);
  if (!node || node.owner_id !== actor.user.id) throw err(404, 'NOT_FOUND', 'Node not found or not yours.');
  return node;
}
async function auditFabric(db, actor, op, action, target, detail = '') {
  const via = actor.kind === 'key' ? ` via key ${actor.keyId || 'unknown'}${isAgentKey(actor) ? ' (agent)' : ''}` : ' via session';
  await ensureAudit(db, { op: await opDigest(actor, op), action, actorId: actor.user.id, target, detail: (detail + via).slice(0, 300), now: nowIso() });
}

// IN-list chunking: every chunked query stays far under D1's
// per-statement parameter limits at any owner scale.
async function chunkedAll(db, select, ids, extra = '', extraParams = [], chunk = 50) {
  const out = [];
  for (let i = 0; i < ids.length; i += chunk) {
    const part = ids.slice(i, i + chunk);
    const q = part.map(() => '?').join(',');
    out.push(...await all(db, `${select} (${q})${extra}`, ...part, ...extraParams));
  }
  return out;
}

// ---- nodes ----
export async function registerNode(db, actor, input = {}, op = null) {
  if (isAgentKey(actor)) throw err(403, 'FORBIDDEN', 'Agent credentials cannot register nodes.');
  const label = typeof input.label === 'string' ? input.label.trim().slice(0, 80) : '';
  if (!label) throw err(400, 'BAD_LABEL', 'Node label is required.');
  const workspace = typeof input.workspace === 'string' && input.workspace.trim() ? input.workspace.trim().slice(0, 64) : 'default';
  const tok = mintToken('ndkey');
  const now = nowIso();
  const nodeId = await opEntityId(actor, op, 'node');
  const fingerprint = (await digestJson(`node:${nodeId}`)).slice(0, 16);
  const res = await runBatch(db, creatorInsert({
    table: 'fabric_nodes',
    columns: ['id', 'owner_id', 'workspace', 'label', 'fingerprint', 'protocol', 'transport', 'issuer', 'status', 'node_secret_verifier', 'node_secret_salt', 'version', 'created_at', 'updated_at'],
    values: [nodeId, actor.user.id, workspace, label, fingerprint, 'fixture-0', 'fixture', 'fixture-local', 'registered', await verifierFor(tok.secret, tok.salt), tok.salt, 1, now, now],
    id: nodeId, actorId: actor.user.id
  }));
  if (changes(res, 0) === 1) {
    await auditFabric(db, actor, op, 'fabric.node.register', nodeId, label);
    return { status: 201, body: { id: nodeId, workspace, label, fingerprint, protocol: 'fixture-0', transport: 'fixture', status: 'registered', nodeSecret: tok.secret, oneTime: 'This node secret is shown once. It proves node possession when accepting invitations.' } };
  }
  // Zero rows: either this operation already committed (converge) or
  // the actor predicate failed (disabled/demo).
  const existing = await first(db, 'SELECT * FROM fabric_nodes WHERE id = ?', nodeId);
  if (existing && existing.owner_id === actor.user.id) {
    // Reconcile AND repair: the prior attempt may have failed before
    // its audit completion. The secret stays unrecoverable by design.
    await auditFabric(db, actor, op, 'fabric.node.register', nodeId, label);
    return { status: 200, body: { id: existing.id, workspace: existing.workspace, label: existing.label, fingerprint: existing.fingerprint, protocol: existing.protocol, transport: existing.transport, status: existing.status, reconciled: true, note: 'This registration already committed; its one-time secret cannot be re-shown. Register a new node if you need a usable secret.' } };
  }
  await throwActorClosed(db, actor);
}

export async function getNode(db, actor, nodeId) {
  const node = await first(db, 'SELECT * FROM fabric_nodes WHERE id = ?', nodeId);
  if (!node) throw err(404, 'NOT_FOUND', 'Node not found.');
  if (node.owner_id === actor.user.id) {
    const { node_secret_verifier: _v, node_secret_salt: _s, ...pub } = node;
    return { status: 200, body: { ...pub, mine: true } };
  }
  const mine = await all(db, 'SELECT id FROM fabric_nodes WHERE owner_id = ?', actor.user.id);
  for (const m of mine) {
    const conn = await first(db, "SELECT id FROM connections WHERE state = 'active' AND ((a_node = ? AND b_node = ?) OR (a_node = ? AND b_node = ?))", m.id, nodeId, nodeId, m.id);
    if (conn) {
      return { status: 200, body: { id: node.id, label: node.label, fingerprint: node.fingerprint, transport: node.transport, status: node.status, mine: false } };
    }
  }
  throw err(404, 'NOT_FOUND', 'Node not found.');
}

export async function listNodes(db, actor) {
  const rows = await all(db, 'SELECT * FROM fabric_nodes WHERE owner_id = ? ORDER BY created_at DESC', actor.user.id);
  return { status: 200, body: { items: rows.map((n) => { const { node_secret_verifier: _v, node_secret_salt: _s, ...pub } = n; return { ...pub, mine: true }; }), total: rows.length } };
}

// ---- invitations ----
const INV_EXPIRY_MAX_H = 168;
export async function createInvitation(db, actor, input = {}, op = null) {
  if (isAgentKey(actor)) throw err(403, 'FORBIDDEN', 'Agent credentials cannot issue invitations.');
  const issuer = await ownNode(db, actor, input.issuerNode);
  const recipientNode = typeof input.recipientNode === 'string' ? input.recipientNode.trim().slice(0, 64) : '';
  const recipientWorkspace = typeof input.recipientWorkspace === 'string' ? input.recipientWorkspace.trim().slice(0, 64) : '';
  if (!recipientNode || !recipientWorkspace) throw err(400, 'BAD_RECIPIENT', 'Recipient node and workspace are required.');
  const target = await first(db, 'SELECT id FROM fabric_nodes WHERE id = ?', recipientNode);
  if (!target) throw err(404, 'NODE_NOT_FOUND', 'Recipient node is not registered.');
  if (recipientNode === issuer.id) throw err(400, 'SELF_INVITE', 'A node cannot invite itself.');
  const hours = Math.min(Math.max(Number(input.expiryHours) || 24, 1), INV_EXPIRY_MAX_H);
  const purpose = typeof input.purpose === 'string' ? input.purpose.trim().slice(0, 280) : '';
  const invId = await opEntityId(actor, op, 'inv');
  const secret = `${invId}_${randB64(32)}`;
  const salt = randHex(16);
  const now = nowIso();
  const expiry = new Date(Date.now() + hours * 3600e3).toISOString();
  const res = await runBatch(db, creatorInsert({
    table: 'invitations',
    columns: ['id', 'issuer_node', 'recipient_node', 'recipient_workspace', 'purpose', 'token_verifier', 'token_salt', 'state', 'expiry', 'use_record', 'created_by', 'created_at', 'decided_at'],
    values: [invId, issuer.id, recipientNode, recipientWorkspace, purpose, await verifierFor(secret, salt), salt, 'issued', expiry, null, actor.user.id, now, null],
    id: invId, actorId: actor.user.id
  }));
  if (changes(res, 0) === 1) {
    await auditFabric(db, actor, op, 'fabric.invitation.create', invId, `${issuer.id} -> ${recipientNode}`);
    return { status: 201, body: { id: invId, issuerNode: issuer.id, recipientNode, recipientWorkspace, purpose, expiry, token: secret, oneTime: 'This invitation token is shown once. Deliver it to the recipient out of band.' } };
  }
  const existing = await first(db, 'SELECT * FROM invitations WHERE id = ?', invId);
  if (existing && existing.created_by === actor.user.id) {
    await auditFabric(db, actor, op, 'fabric.invitation.create', invId, `${issuer.id} -> ${recipientNode}`);
    return { status: 200, body: { id: existing.id, issuerNode: existing.issuer_node, recipientNode: existing.recipient_node, recipientWorkspace: existing.recipient_workspace, purpose: existing.purpose, expiry: existing.expiry, reconciled: true, note: 'This invitation already committed; its one-time token cannot be re-shown. Issue a new invitation if needed.' } };
  }
  await throwActorClosed(db, actor);
}

async function invitationVisibleTo(db, actor, inv) {
  if (!inv) return false;
  const issuer = await first(db, 'SELECT owner_id FROM fabric_nodes WHERE id = ?', inv.issuer_node);
  if (issuer && issuer.owner_id === actor.user.id) return true;
  const recip = await first(db, 'SELECT owner_id, workspace FROM fabric_nodes WHERE id = ?', inv.recipient_node);
  return !!(recip && recip.owner_id === actor.user.id && recip.workspace === inv.recipient_workspace);
}

export async function getInvitation(db, actor, id) {
  if (typeof id !== 'string' || !id) throw err(404, 'NOT_FOUND', 'Invitation not found.');
  const inv = await first(db, 'SELECT * FROM invitations WHERE id = ?', id);
  if (!inv || !(await invitationVisibleTo(db, actor, inv))) throw err(404, 'NOT_FOUND', 'Invitation not found.');
  const { token_verifier: _v, token_salt: _s, ...pub } = inv;
  return { status: 200, body: pub };
}

export async function listInvitations(db, actor, role = 'both') {
  const mine = await all(db, 'SELECT id, workspace FROM fabric_nodes WHERE owner_id = ?', actor.user.id);
  const ids = mine.map((m) => m.id);
  const byNode = async (col) => {
    if (!ids.length) return [];
    return chunkedAll(db, `SELECT * FROM invitations WHERE ${col} IN`, ids, ' ORDER BY created_at DESC');
  };
  let rows = [];
  if (role === 'outgoing' || role === 'both') rows = rows.concat(await byNode('issuer_node'));
  if (role === 'incoming' || role === 'both') {
    const incoming = await byNode('recipient_node');
    rows = rows.concat(incoming.filter((r) => mine.some((m) => m.id === r.recipient_node && m.workspace === r.recipient_workspace)));
  }
  const seen = new Set();
  rows = rows.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
  return { status: 200, body: { items: rows.map((r) => { const { token_verifier: _v, token_salt: _s, ...pub } = r; return pub; }), total: rows.length } };
}

export async function acceptInvitation(db, actor, input = {}, op = null) {
  // Accept proves: invitation token possession + acceptor-node ownership +
  // node-secret possession. Acceptance alone grants ZERO resource access.
  const presented = tokenIdPresented(input.token, 'inv');
  const inv = presented ? await first(db, 'SELECT * FROM invitations WHERE id = ?', presented.id) : null;
  if (!inv || !(await verifyToken(presented.secret, { verifier: inv.token_verifier, salt: inv.token_salt }))) {
    throw err(404, 'NOT_FOUND', 'Invitation not found or token invalid.');
  }
  const acceptor = await ownNode(db, actor, input.nodeId);
  if (!(await verifyToken(input.nodeKey, { verifier: acceptor.node_secret_verifier, salt: acceptor.node_secret_salt }))) {
    throw err(403, 'BAD_NODE_KEY', 'Node proof invalid.');
  }
  if (acceptor.id !== inv.recipient_node || acceptor.workspace !== inv.recipient_workspace) {
    throw err(403, 'WRONG_RECIPIENT', 'This invitation names a different node and workspace.');
  }
  // All proofs (token, node ownership, node secret, recipient match) were
  // verified above, so reaching this point with an 'accepted' invitation
  // means a prior attempt flipped the state and then failed before (or
  // while) creating the connection. Complete it idempotently instead of
  // burning the invitation: same proofs, at most one connection.
  if (inv.state !== 'issued') {
    if (inv.state === 'accepted') return recoverAcceptance(db, actor, inv, acceptor, op);
    throw err(409, 'INVITATION_USED', `Invitation is ${inv.state}.`);
  }
  if (inv.expiry <= nowIso()) {
    await db.prepare("UPDATE invitations SET state = 'expired', decided_at = ? WHERE id = ? AND state = 'issued'").bind(nowIso(), inv.id).run();
    throw err(410, 'INVITATION_EXPIRED', 'Invitation expired.');
  }
  // Linearization point: one batch flips the invitation and inserts
  // the connection chained on the flip. Either both land or neither.
  const useRecord = JSON.stringify({ byNode: acceptor.id, at: nowIso(), op: (await opDigest(actor, op)).slice(0, 16) });
  const issuerRow = await first(db, 'SELECT workspace FROM fabric_nodes WHERE id = ?', inv.issuer_node);
  const connId = `conn_${randHex(8)}`;
  const now = nowIso();
  let res;
  try {
    res = await runBatch(db, [
      acceptFlip({ invId: inv.id, useRecord, now, actorId: actor.user.id }),
      acceptConnInsert({ connId, invId: inv.id, aNode: inv.issuer_node, bNode: acceptor.id, aWs: issuerRow ? issuerRow.workspace : '', bWs: acceptor.workspace, useRecord, now })
    ]);
  } catch {
    // A thrown batch proves nothing about who won: it may have aborted
    // on the UNIQUE binding (concurrent winner), failed with nothing
    // applied, or committed before the error surfaced. Settle on the
    // durable invitation state; only an accepted invitation is
    // completed, and completion re-checks it in the same statement.
    const cur = await first(db, 'SELECT state FROM invitations WHERE id = ?', inv.id);
    if (cur && cur.state === 'accepted') return recoverAcceptance(db, actor, inv, acceptor, op);
    if (cur && cur.state !== 'issued') throw err(409, 'INVITATION_USED', `Invitation is ${cur.state}.`);
    throw err(500, 'INTERNAL', 'Request failed.');
  }
  if (changes(res, 0) === 1 && changes(res, 1) === 1) {
    await auditFabric(db, actor, op, 'fabric.invitation.accept', inv.id, `connection ${connId}`);
    return { status: 201, body: { id: connId, aNode: inv.issuer_node, bNode: acceptor.id, state: 'active' } };
  }
  if (changes(res, 0) === 1) {
    // Flip landed but the connection did not: a concurrent winner's
    // connection already binds this invitation. Converge on it.
    return recoverAcceptance(db, actor, inv, acceptor, op);
  }
  // Lost the flip race (or actor closed): settle by reading.
  const cur = await first(db, 'SELECT state FROM invitations WHERE id = ?', inv.id);
  if (cur && cur.state === 'accepted') return recoverAcceptance(db, actor, inv, acceptor, op);
  if (!cur || cur.state === 'issued') await throwActorClosed(db, actor);
  throw err(409, 'INVITATION_USED', `Invitation is ${cur ? cur.state : 'gone'}.`);
}

// Complete an accepted-but-connectionless invitation (legacy rows from
// before the flip+insert batch, or a batch whose outcome was unknown),
// or return the existing connection. The insert is conditional on the
// invitation still being accepted for this recipient and on a live
// actor; the UNIQUE created_by_invitation binding makes concurrent
// recoverers converge.
async function recoverAcceptance(db, actor, inv, acceptor, op = null) {
  const done = await insertAcceptance(db, actor, inv, acceptor);
  if (!done.created) return { status: 200, body: { id: done.id, state: 'active', note: 'Connection already existed for this invitation.' } };
  await auditFabric(db, actor, op, 'fabric.invitation.accept', inv.id, `connection ${done.id} (recovered)`);
  return { status: 201, body: { id: done.id, aNode: inv.issuer_node, bNode: acceptor.id, state: 'active' } };
}

async function insertAcceptance(db, actor, inv, acceptor) {
  const issuerRow = await first(db, 'SELECT workspace FROM fabric_nodes WHERE id = ?', inv.issuer_node);
  const connId = `conn_${randHex(8)}`;
  const now = nowIso();
  let res;
  try {
    res = await runBatch(db, [acceptRecoverInsert({ connId, invId: inv.id, aNode: inv.issuer_node, bNode: acceptor.id, aWs: issuerRow ? issuerRow.workspace : '', bWs: acceptor.workspace, now, actorId: actor.user.id })]);
  } catch { /* UNIQUE lost to a concurrent recoverer: settle below */ }
  if (res && changes(res, 0) === 1) return { created: true, id: connId };
  const existing = await first(db, 'SELECT id FROM connections WHERE created_by_invitation = ?', inv.id);
  if (existing) return { created: false, id: existing.id };
  const cur = await first(db, 'SELECT state FROM invitations WHERE id = ?', inv.id);
  if (!cur || cur.state !== 'accepted') throw err(409, 'INVITATION_USED', `Invitation is ${cur ? cur.state : 'gone'}.`);
  await throwActorClosed(db, actor);
}

export async function declineInvitation(db, actor, id, op = null) {
  needId(id, 'Invitation');
  const inv = await first(db, 'SELECT * FROM invitations WHERE id = ?', id);
  if (!inv || !(await invitationVisibleTo(db, actor, inv))) throw err(404, 'NOT_FOUND', 'Invitation not found.');
  const mine = await all(db, 'SELECT id, workspace FROM fabric_nodes WHERE owner_id = ?', actor.user.id);
  if (!mine.some((m) => m.id === inv.recipient_node && m.workspace === inv.recipient_workspace)) {
    throw err(403, 'FORBIDDEN', 'Only the recipient side can decline.');
  }
  const completion = await restrictionContext(db, actor, op, 'fabric.invitation.decline', id, {});
  if (completion.replay) return completion.replay;
  const now = nowIso();
  const res = await runBatch(db, [
    [`UPDATE invitations SET state = 'declined', decided_at = ? WHERE id = ? AND state = 'issued'
      AND EXISTS(SELECT 1 FROM "user" u WHERE u.id = ? AND u.disabled = 0 AND u.demo = 0)`, now, id, actor.user.id],
    ...restrictionCompletion(actor, completion, 'fabric.invitation.decline', id, { id, state: 'declined' }, now)
  ]);
  if (!changes(res, 0)) {
    const recovered = await restrictionContext(db, actor, op, 'fabric.invitation.decline', id, {});
    if (recovered.replay) return recovered.replay;
    const cur = await first(db, 'SELECT state FROM invitations WHERE id = ?', id);
    if (!cur || cur.state === 'issued') await throwActorClosed(db, actor);
    throw err(409, 'INVITATION_USED', 'Invitation is no longer pending.');
  }
  return { status: 200, body: { id, state: 'declined' } };
}

export async function revokeInvitation(db, actor, id, op = null) {
  needId(id, 'Invitation');
  const inv = await first(db, 'SELECT * FROM invitations WHERE id = ?', id);
  if (!inv) throw err(404, 'NOT_FOUND', 'Invitation not found.');
  await ownNode(db, actor, inv.issuer_node);
  const completion = await restrictionContext(db, actor, op, 'fabric.invitation.revoke', id, {});
  if (completion.replay) return completion.replay;
  const now = nowIso();
  const res = await runBatch(db, [
    [`UPDATE invitations SET state = 'revoked', decided_at = ? WHERE id = ? AND state = 'issued'
      AND EXISTS(SELECT 1 FROM "user" u WHERE u.id = ? AND u.disabled = 0 AND u.demo = 0)`, now, id, actor.user.id],
    ...restrictionCompletion(actor, completion, 'fabric.invitation.revoke', id, { id, state: 'revoked' }, now)
  ]);
  if (!changes(res, 0)) {
    const recovered = await restrictionContext(db, actor, op, 'fabric.invitation.revoke', id, {});
    if (recovered.replay) return recovered.replay;
    const cur = await first(db, 'SELECT state FROM invitations WHERE id = ?', id);
    if (!cur || cur.state === 'issued') await throwActorClosed(db, actor);
    throw err(409, 'INVITATION_USED', 'Invitation is no longer pending.');
  }
  return { status: 200, body: { id, state: 'revoked' } };
}

// ---- connections ----
async function ownConnectionSide(db, actor, conn) {
  const a = await first(db, 'SELECT owner_id FROM fabric_nodes WHERE id = ?', conn.a_node);
  const b = await first(db, 'SELECT owner_id FROM fabric_nodes WHERE id = ?', conn.b_node);
  if ((a && a.owner_id === actor.user.id) || (b && b.owner_id === actor.user.id)) return true;
  throw err(404, 'NOT_FOUND', 'Connection not found.');
}

export async function listConnections(db, actor) {
  const mine = await all(db, 'SELECT id FROM fabric_nodes WHERE owner_id = ?', actor.user.id);
  const ids = mine.map((m) => m.id);
  if (!ids.length) return { status: 200, body: { items: [], total: 0 } };
  const rowsA = await chunkedAll(db, 'SELECT * FROM connections WHERE a_node IN', ids, '');
  const rowsB = await chunkedAll(db, 'SELECT * FROM connections WHERE b_node IN', ids, '');
  const seen = new Set();
  const rows = [...rowsA, ...rowsB].filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
  rows.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  return { status: 200, body: { items: rows, total: rows.length } };
}

export async function getConnection(db, actor, id) {
  if (typeof id !== 'string' || !id) throw err(404, 'NOT_FOUND', 'Connection not found.');
  const conn = await first(db, 'SELECT * FROM connections WHERE id = ?', id);
  if (!conn) throw err(404, 'NOT_FOUND', 'Connection not found.');
  await ownConnectionSide(db, actor, conn);
  return { status: 200, body: conn };
}

function checkVersion(row, input) {
  if (input.expectedVersion === undefined || input.expectedVersion === null) {
    throw err(400, 'VERSION_REQUIRED', 'expectedVersion is required.');
  }
  if (Number(input.expectedVersion) !== row.version) throw err(412, 'VERSION_MISMATCH', 'Stale revision; refresh and retry.');
}

// Race-loss outcomes are returned as values, never thrown: when a
// conditional write matches zero rows, we re-read the row, so the outcome
// is an observed completed state, not a validation guess. The HTTP layer
// renders these identically to thrown errors (same status + code), and
// direct store callers can settle concurrent losers without exceptions.
function lostRace() {
  return { status: 412, body: { error: 'Changed concurrently; refresh and retry.', code: 'VERSION_MISMATCH' } };
}

// The acting side's node on this connection (deterministic a-first when
// the actor owns both sides). Callers must have passed ownConnectionSide.
async function actingSideNode(db, actor, conn) {
  for (const side of [conn.a_node, conn.b_node]) {
    const node = await first(db, 'SELECT id, owner_id FROM fabric_nodes WHERE id = ?', side);
    if (node && node.owner_id === actor.user.id) return node.id;
  }
  return null;
}

// Each side that suspends or disconnects holds an independent veto row
// until it withdraws it. A peer transition ADDS a veto; it never
// removes the other side's. Withdrawal is side-owned: the caller must
// own the side AND prove that side's own secret; presenting a peer's
// secret withdraws nothing. The `vetoed_by`/`suspended_by` columns
// mirror the table for forensics and compatibility; the table rules.
async function vetoRows(db, connId) {
  const rows = await all(db, 'SELECT side_node FROM connection_vetoes WHERE connection_id = ? ORDER BY side_node', connId);
  return rows.map((r) => r.side_node);
}

async function restrictConnection(db, actor, id, input, op, toState, auditAction) {
  needId(id, 'Connection');
  const conn = await first(db, 'SELECT * FROM connections WHERE id = ?', id);
  if (!conn) throw err(404, 'NOT_FOUND', 'Connection not found.');
  await ownConnectionSide(db, actor, conn);
  const completion = await restrictionContext(db, actor, op, auditAction, id, input);
  if (completion.replay) return completion.replay;
  checkVersion(conn, input);
  const side = await actingSideNode(db, actor, conn);
  const veto = await vetoRows(db, id);
  if (side && veto.includes(side)) {
    // Already restricted by this side: converge (any state, no new
    // epoch) instead of duplicating the veto.
    return { status: 200, body: { id, state: conn.state, note: 'Your side already restricts this connection.' } };
  }
  if (conn.state === 'disconnected') throw err(409, 'BAD_STATE', 'Connection is already disconnected.');
  const now = nowIso();
  const mirror = JSON.stringify([...new Set([...veto, side].filter(Boolean))].sort());
  let res;
  try {
    res = await runBatch(db, [
      ...vetoRestrict({ connId: id, side, version: conn.version, newState: toState, mirror, now, actorId: actor.user.id }),
      ...restrictionCompletion(actor, completion, auditAction, id, { id, state: toState }, now)
    ]);
  } catch (e) {
    // Only our immutable receipt proves an unknown batch applied. A peer's
    // later veto is not evidence of this operation; persistence failures must
    // remain retryable rather than becoming a fabricated terminal conflict.
    const recovered = await restrictionContext(db, actor, op, auditAction, id, input);
    if (recovered.replay) return recovered.replay;
    throw e;
  }
  if (changes(res, 0) === 1 && changes(res, 1) === 1) {
    return { status: 200, body: { id, state: toState } };
  }
  if (changes(res, 0) === 1) return { status: 500, body: { error: 'Request failed.', code: 'INTERNAL' } };
  // Another attempt of this operation may have committed after our initial
  // receipt read. Recover it before classifying a zero-row CAS from live state.
  const recovered = await restrictionContext(db, actor, op, auditAction, id, input);
  if (recovered.replay) return recovered.replay;
  // Restriction lost: version moved, terminal state, or actor closed.
  const cur = await first(db, 'SELECT version, state FROM connections WHERE id = ?', id);
  if (!cur) throw err(404, 'NOT_FOUND', 'Connection not found.');
  if (cur.version !== conn.version) return lostRace();
  if (cur.state === 'disconnected' && toState === 'disconnected') {
    if (side && (await vetoRows(db, id)).includes(side)) {
      return { status: 200, body: { id, state: cur.state, note: 'Your side already restricts this connection.' } };
    }
    throw err(409, 'BAD_STATE', 'Connection is already disconnected.');
  }
  await throwActorClosed(db, actor);
}

export async function suspendConnection(db, actor, id, input = {}, op = null) {
  return restrictConnection(db, actor, id, input, op, 'suspended', 'fabric.connection.suspend');
}

export async function disconnectConnection(db, actor, id, input = {}, op = null) {
  return restrictConnection(db, actor, id, input, op, 'disconnected', 'fabric.connection.disconnect');
}

export async function resumeConnection(db, actor, id, input = {}, op = null) {
  if (!isHuman(actor)) needHuman();
  needId(id, 'Connection');
  const conn = await first(db, 'SELECT * FROM connections WHERE id = ?', id);
  if (!conn) throw err(404, 'NOT_FOUND', 'Connection not found.');
  await ownConnectionSide(db, actor, conn);
  let completion;
  const recover = async () => {
    const live = await first(db, 'SELECT disabled, demo FROM "user" WHERE id = ?', actor.user.id);
    if (!live || Number(live.disabled) === 1 || Number(live.demo) === 1) await throwActorClosed(db, actor);
    return restrictionContext(db, actor, op, 'fabric.connection.resume', id, input, completion);
  };
  completion = await recover();
  if (completion.replay) return completion.replay;
  try {
    checkVersion(conn, input);
    if (conn.state === 'active') throw err(409, 'BAD_STATE', 'Connection is already active.');
    const veto = await vetoRows(db, id);
    if (!veto.length) throw err(409, 'BAD_STATE', 'This connection has no recorded consent; re-invite to reconnect.');
    // Legacy fail-closed: vetoes without a recorded suspender predate
    // reliable consent tracking; withdrawing is forbidden.
    if (!conn.suspended_by) throw err(409, 'BAD_STATE', 'This connection predates consent tracking; re-invite to reconnect.');
    // Own sides only: the caller's owned sides among the veto set.
    const ownSides = [];
    for (const nodeId of veto) {
      const n = await first(db, 'SELECT owner_id FROM fabric_nodes WHERE id = ?', nodeId);
      if (n && n.owner_id === actor.user.id) ownSides.push(nodeId);
    }
    if (!ownSides.length) {
      const recovered = await recover();
      if (recovered.replay) return recovered.replay;
      return { status: 409, body: { error: 'Your sides hold no veto on this connection.', code: 'NO_OWN_VETO' } };
    }
    // Own proof only: each withdrawn side needs that side's own node proof.
    // A peer proof, however valid, withdraws nothing.
    const presented = [input.nodeKey, ...(Array.isArray(input.nodeKeys) ? input.nodeKeys : [])].filter((s) => typeof s === 'string' && s);
    const proven = [];
    for (const nodeId of ownSides) {
      const n = await first(db, 'SELECT node_secret_verifier, node_secret_salt FROM fabric_nodes WHERE id = ?', nodeId);
      for (const s of presented) {
        if (n && await verifyToken(s, { verifier: n.node_secret_verifier, salt: n.node_secret_salt })) { proven.push(nodeId); break; }
      }
    }
    if (!proven.length) throw err(403, 'FORBIDDEN', 'Withdrawal requires your own node proof for a vetoing side.');
    const remaining = veto.filter((v) => !proven.includes(v)).sort();
    const newState = remaining.length ? conn.state : 'active';
    const now = nowIso();
    const body = { id, state: newState, withdrawn: proven.sort(), remainingVetoes: remaining };
    const res = await runBatch(db, [...vetoWithdraw({
      connId: id, sides: proven.sort(), version: conn.version, newState,
      suspendedBy: remaining.length ? conn.suspended_by : null,
      mirror: remaining.length ? JSON.stringify(remaining) : null,
      remaining: remaining.length, now, actorId: actor.user.id
    }), ...restrictionCompletion(actor, completion, 'fabric.connection.resume', id, body, now,
      `withdrew ${proven.length}, ${remaining.length} remain`)]);
    if (changes(res, 1) === 1) {
      return { status: 200, body };
    }
    const recovered = await recover();
    if (recovered.replay) return recovered.replay;
    // Withdrawal lost: settle by reading.
    const cur = await first(db, 'SELECT version, state, suspended_by FROM connections WHERE id = ?', id);
    if (!cur) throw err(404, 'NOT_FOUND', 'Connection not found.');
    if (cur.version !== conn.version) return lostRace();
    const curVeto = await vetoRows(db, id);
    if (!curVeto.length) {
      if (cur.state === 'active') return { status: 200, body: { id, state: 'active', withdrawn: [], remainingVetoes: [] } };
      throw err(409, 'BAD_STATE', 'This connection has no recorded consent; re-invite to reconnect.');
    }
    if (!curVeto.some((v) => ownSides.includes(v))) {
      return { status: 200, body: { id, state: cur.state, withdrawn: [], remainingVetoes: curVeto } };
    }
    if (!cur.suspended_by) throw err(409, 'BAD_STATE', 'This connection predates consent tracking; re-invite to reconnect.');
    if (curVeto.length !== veto.length) return lostRace();
    await throwActorClosed(db, actor);
  } catch (e) {
    // An older attempt can publish after the first receipt read, including
    // before a fresh-state guard or an unknown batch response is observed.
    const recovered = await recover();
    if (recovered.replay) return recovered.replay;
    throw e;
  }
}

// ---- previews ----
const PREVIEW_TTL_MS = 30 * 60e3;
function buildConfirmation(terms) {
  const models = new Set();
  for (const s of terms.snapshot || []) for (const m of s.models || []) models.add(m);
  return `Share ${(terms.snapshot || []).length} resource(s) with ${terms.importerNode} for ${(terms.consumers || []).length} consumer(s), models ${[...models].join(', ')}, up to ${terms.ceilings.maxTokens} tokens / ${terms.ceilings.maxRequests} requests, until ${terms.expiry}. ${(terms.exclusions || []).length} owned resource(s) excluded. Connection only carries inference; nothing else is shared.`;
}

export async function createPreview(db, actor, input = {}, op = null) {
  if (isAgentKey(actor)) throw err(403, 'FORBIDDEN', 'Agent credentials cannot draft previews.');
  needId(input.connectionId, 'Connection');
  const conn = await first(db, 'SELECT * FROM connections WHERE id = ?', input.connectionId);
  if (!conn) throw err(404, 'NOT_FOUND', 'Connection not found.');
  await ownConnectionSide(db, actor, conn);
  if (conn.state === 'disconnected') throw err(409, 'CONNECTION_DOWN', 'Connection is disconnected.');
  const resourceIds = Array.isArray(input.resourceIds) ? [...new Set(input.resourceIds)] : [];
  if (!resourceIds.length || resourceIds.length > 25) throw err(400, 'BAD_SELECTION', 'Select 1-25 resources.');
  const exporterNodes = (await all(db, 'SELECT id FROM fabric_nodes WHERE owner_id = ?', actor.user.id)).map((n) => n.id);
  const exporterNode = exporterNodes.includes(conn.a_node) ? conn.a_node : exporterNodes.includes(conn.b_node) ? conn.b_node : null;
  if (!exporterNode) throw err(403, 'FORBIDDEN', 'Only a connection side can share.');
  const importerNode = exporterNode === conn.a_node ? conn.b_node : conn.a_node;
  const importer = await first(db, 'SELECT workspace FROM fabric_nodes WHERE id = ?', importerNode);
  const snapshot = [];
  for (const rid of resourceIds) {
    const r = await first(db, 'SELECT id, owner_id, incarnation, imported_from, capabilities_json FROM resources WHERE id = ?', rid);
    if (!r || r.owner_id !== actor.user.id || r.imported_from) {
      throw err(422, 'NOT_SHAREABLE', `Resource ${rid} is not owner-controlled by you.`);
    }
    snapshot.push({ resourceId: r.id, incarnation: r.incarnation, capabilities: parseJson(r.capabilities_json, []), models: Array.isArray(input.models) ? input.models.slice(0, 25) : [] });
  }
  const consumers = Array.isArray(input.consumers) ? [...new Set(input.consumers.map(String).map((s) => s.slice(0, 128)))] : [];
  if (!consumers.length || consumers.length > 50) throw err(400, 'BAD_CONSUMERS', 'Name 1-50 consumers.');
  const models = Array.isArray(input.models) ? [...new Set(input.models.map(String).map((s) => s.slice(0, 128)))] : [];
  if (!models.length) throw err(400, 'BAD_MODELS', 'Name at least one model.');
  const ceilings = { maxTokens: Math.min(Math.max(Number(input.maxTokens) || 0, 1), 1e9), maxRequests: Math.min(Math.max(Number(input.maxRequests) || 0, 1), 1e6) };
  if (!(Number(input.maxTokens) > 0) || !(Number(input.maxRequests) > 0)) throw err(400, 'BAD_CEILINGS', 'Positive maxTokens and maxRequests are required.');
  const days = Math.min(Math.max(Number(input.validDays) || 7, 1), 30);
  const owned = await all(db, 'SELECT id, imported_from FROM resources WHERE owner_id = ?', actor.user.id);
  const exclusions = owned.filter((r) => !resourceIds.includes(r.id)).slice(0, 200)
    .map((r) => ({ resourceId: r.id, reason: r.imported_from ? 'not owner-controlled' : 'not selected' }));
  const now = nowIso();
  const preview = {
    encodingVersion: 'aipster-jcs-0', connectionId: conn.id, exporterNode, importerNode,
    importerWorkspace: importer ? importer.workspace : '', snapshot, consumers, actions: ['infer'],
    route: 'fixture', retention: 'outputs-pinned-7d', ceilings,
    notBefore: now, expiry: new Date(Date.now() + days * 86400e3).toISOString(), exclusions, capturedAt: now
  };
  const digest = await digestJson(preview);
  const revisionVector = { connection: conn.version, policy: 1 };
  const id = await opEntityId(actor, op, 'prev');
  const res = await runBatch(db, creatorInsert({
    table: 'grant_previews',
    columns: ['id', 'connection_id', 'canonical_json', 'digest', 'revision_vector', 'expiry', 'created_by', 'created_at'],
    values: [id, conn.id, canonicalize(preview), digest, JSON.stringify(revisionVector), new Date(Date.now() + PREVIEW_TTL_MS).toISOString(), actor.user.id, now],
    id, actorId: actor.user.id
  }));
  if (changes(res, 0) === 1) {
    await auditFabric(db, actor, op, 'fabric.preview.create', id, `${snapshot.length} resources`);
    return { status: 201, body: { id, digest, preview, revisionVector, confirmation: buildConfirmation(preview) } };
  }
  const existing = await first(db, 'SELECT * FROM grant_previews WHERE id = ?', id);
  if (existing && existing.created_by === actor.user.id) {
    await auditFabric(db, actor, op, 'fabric.preview.create', id, `${snapshot.length} resources`);
    const terms = parseJson(existing.canonical_json, {});
    return { status: 200, body: { id: existing.id, digest: existing.digest, preview: terms, revisionVector: parseJson(existing.revision_vector, {}), confirmation: buildConfirmation(terms), reconciled: true } };
  }
  await throwActorClosed(db, actor);
}

// ---- approvals ----
const APPROVAL_TTL_MS = 10 * 60e3;
export async function requestApproval(db, actor, input = {}, op = null) {
  if (!canPropose(actor)) throw err(403, 'FORBIDDEN', 'This credential cannot request approvals.');
  const rawAction = input.action === undefined || input.action === null || input.action === '' ? 'grant.commit' : input.action;
  if (rawAction !== 'grant.commit' && rawAction !== 'grant.revise' && rawAction !== 'grant.resume') {
    throw err(400, 'BAD_ACTION', 'Unknown approval action.');
  }
  const action = rawAction;
  let preview = null;
  let targetGrant = null;
  let revisionVector = {};
  let issueConn = null;
  if (action === 'grant.commit' || action === 'grant.revise') {
    if (typeof input.previewId !== 'string' || !input.previewId) throw err(404, 'NOT_FOUND', 'Preview not found.');
    preview = await first(db, 'SELECT * FROM grant_previews WHERE id = ?', input.previewId);
    if (!preview) throw err(404, 'NOT_FOUND', 'Preview not found.');
    // Nested-reference authorization: only the preview's exporting owner
    // may request (and thereby read the digest of) an approval for it.
    // Anything else is indistinguishable from a missing preview.
    const terms0 = parseJson(preview.canonical_json, null);
    const exporterNode = terms0 ? await first(db, 'SELECT owner_id FROM fabric_nodes WHERE id = ?', terms0.exporterNode) : null;
    if (!terms0 || !exporterNode || exporterNode.owner_id !== actor.user.id) {
      throw err(404, 'NOT_FOUND', 'Preview not found.');
    }
    if (preview.expiry <= nowIso()) throw err(410, 'PREVIEW_STALE', 'Preview expired; regenerate it.');
    const conn = await first(db, 'SELECT * FROM connections WHERE id = ?', preview.connection_id);
    if (!conn || conn.state === 'disconnected') throw err(409, 'CONNECTION_DOWN', 'Connection is gone.');
    issueConn = conn;
    revisionVector = parseJson(preview.revision_vector, {});
  }
  if (action === 'grant.revise' || action === 'grant.resume') {
    if (typeof input.targetId !== 'string' || !input.targetId) throw err(404, 'NOT_FOUND', 'Grant not found.');
    targetGrant = await first(db, 'SELECT * FROM fabric_grants WHERE id = ?', input.targetId);
    if (!targetGrant) throw err(404, 'NOT_FOUND', 'Grant not found.');
    if (targetGrant.quarantine_reason) throw err(409, 'GRANT_QUARANTINED', 'Grant is quarantined; re-issue it.');
    if (!(await actorExportsGrant(db, actor, targetGrant))) throw err(404, 'NOT_FOUND', 'Grant not found.');
    if (action === 'grant.resume') {
      issueConn = await first(db, 'SELECT * FROM connections WHERE id = ?', targetGrant.connection_id);
      revisionVector = { grant: targetGrant.version };
    } else {
      // A revise approval is self-consistent at request: preview and
      // target name the same connection and recipient.
      const terms = parseJson(preview.canonical_json, {});
      if (targetGrant.connection_id !== preview.connection_id || terms.importerNode !== targetGrant.recipient_node || terms.importerWorkspace !== targetGrant.recipient_workspace) {
        throw err(422, 'PREVIEW_MISMATCH', 'This preview names a different connection or recipient.');
      }
      revisionVector = { ...revisionVector, grant: targetGrant.version };
    }
  }
  const id = await opEntityId(actor, op, 'appr');
  const now = nowIso();
  const expiresAt = new Date(Date.now() + APPROVAL_TTL_MS).toISOString();
  const res = await runBatch(db, creatorInsert({
    table: 'approvals',
    columns: ['id', 'action', 'target_id', 'preview_id', 'preview_digest', 'revision_vector', 'approver', 'interaction_ref', 'decision', 'expiry', 'consumed_at', 'created_by', 'created_at', 'issued_connection', 'issued_version', 'issued_grant_gen', 'bound_grant_id', 'bound_grant_version'],
    values: [id, action, input.targetId || null, preview ? preview.id : null, preview ? preview.digest : null, JSON.stringify(revisionVector), null, null, 'requested', expiresAt, null, actor.user.id, now, issueConn ? issueConn.id : null, issueConn ? issueConn.version : null, issueConn ? issueConn.grant_gen : null, targetGrant ? targetGrant.id : null, targetGrant ? targetGrant.version : null],
    id, actorId: actor.user.id
  }));
  if (changes(res, 0) === 1) {
    await auditFabric(db, actor, op, 'fabric.approval.request', id, action);
    return { status: 201, body: { id, action, previewId: preview ? preview.id : null, previewDigest: preview ? preview.digest : null, revisionVector, expiresAt } };
  }
  const existing = await first(db, 'SELECT * FROM approvals WHERE id = ?', id);
  if (existing && existing.created_by === actor.user.id) {
    await auditFabric(db, actor, op, 'fabric.approval.request', id, action);
    return { status: 200, body: { id: existing.id, action: existing.action, previewId: existing.preview_id, previewDigest: existing.preview_digest, revisionVector: parseJson(existing.revision_vector, {}), expiresAt: existing.expiry, reconciled: true } };
  }
  await throwActorClosed(db, actor);
}

export async function decideApproval(db, actor, id, input = {}, op = null) {
  if (!isHuman(actor)) needHuman();
  needId(id, 'Approval');
  const appr = await first(db, 'SELECT * FROM approvals WHERE id = ?', id);
  if (!appr) throw err(404, 'NOT_FOUND', 'Approval not found.');
  // The decider must own the exporting side (or the grant being resumed).
  let exporterOk = false;
  if ((appr.action === 'grant.commit' || appr.action === 'grant.revise') && appr.preview_id) {
    const preview = await first(db, 'SELECT * FROM grant_previews WHERE id = ?', appr.preview_id);
    const conn = preview ? await first(db, 'SELECT * FROM connections WHERE id = ?', preview.connection_id) : null;
    if (preview && conn) {
      const terms = parseJson(preview.canonical_json, {});
      const node = await first(db, 'SELECT owner_id FROM fabric_nodes WHERE id = ?', terms.exporterNode);
      exporterOk = !!(node && node.owner_id === actor.user.id);
    }
  } else if (appr.action === 'grant.resume' && appr.target_id) {
    const grant = await first(db, 'SELECT * FROM fabric_grants WHERE id = ?', appr.target_id);
    exporterOk = !!(grant && await actorExportsGrant(db, actor, grant));
  }
  if (!exporterOk) throw err(403, 'FORBIDDEN', 'Only the exporting owner can decide.');
  if (appr.decision !== 'requested') throw err(409, 'ALREADY_DECIDED', `Approval is ${appr.decision}.`);
  if (appr.expiry <= nowIso()) {
    const expired = await db.prepare(`UPDATE approvals SET decision = 'expired', decided_at = ?
      WHERE id = ? AND decision = 'requested'
      AND EXISTS(SELECT 1 FROM "user" u WHERE u.id = ? AND u.disabled = 0 AND u.demo = 0)`)
      .bind(nowIso(), id, actor.user.id).run();
    if (!expired.meta.changes) await throwActorClosed(db, actor);
    throw err(410, 'APPROVAL_EXPIRED', 'Approval expired.');
  }
  const decision = input.decision === 'approve' ? 'approved' : input.decision === 'reject' ? 'rejected' : null;
  if (!decision) throw err(400, 'BAD_DECISION', "Decision must be 'approve' or 'reject'.");
  const now = nowIso();
  const upd = await db.prepare(`UPDATE approvals SET decision = ?, approver = ?, interaction_ref = ?, decided_at = ? WHERE id = ? AND decision = 'requested' AND expiry > ? AND EXISTS(SELECT 1 FROM "user" u WHERE u.id = ? AND u.disabled = 0 AND u.demo = 0)`)
    .bind(decision, actor.user.id, `session:${actor.user.id}:${now}`, now, id, now, actor.user.id).run();
  if (!upd.meta.changes) {
    const cur = await first(db, 'SELECT decision, expiry FROM approvals WHERE id = ?', id);
    if (!cur) throw err(404, 'NOT_FOUND', 'Approval not found.');
    if (cur.decision !== 'requested') throw err(409, 'ALREADY_DECIDED', `Approval is ${cur.decision}.`);
    if (cur.expiry <= nowIso()) throw err(410, 'APPROVAL_EXPIRED', 'Approval expired.');
    await throwActorClosed(db, actor);
  }
  await auditFabric(db, actor, op, `fabric.approval.${decision}`, id);
  return { status: 200, body: { id, decision } };
}

export async function listApprovals(db, actor) {
  const rows = await all(db, 'SELECT * FROM approvals WHERE created_by = ? OR approver = ? ORDER BY created_at DESC', actor.user.id, actor.user.id);
  return { status: 200, body: { items: rows, total: rows.length } };
}

export async function getApproval(db, actor, id) {
  if (typeof id !== 'string' || !id) throw err(404, 'NOT_FOUND', 'Approval not found.');
  const appr = await first(db, 'SELECT * FROM approvals WHERE id = ?', id);
  if (!appr || (appr.created_by !== actor.user.id && appr.approver !== actor.user.id)) {
    throw err(404, 'NOT_FOUND', 'Approval not found.');
  }
  return { status: 200, body: appr };
}

// ---- grants ----
async function grantVisibleTo(db, actor, grant) {
  const conn = await first(db, 'SELECT * FROM connections WHERE id = ?', grant.connection_id);
  if (!conn) return false;
  try { await ownConnectionSide(db, actor, conn); return true; } catch { return false; }
}

// Only the exact consuming operation may reconcile a committed grant. Callers
// must first authorize the exporter and validate the supplied preview binding.
async function completeCommit(db, actor, appr, preview, op, operationId) {
  if (!appr || appr.consumed_by_op !== operationId || appr.consumed_action !== 'grant.commit' || appr.consumed_target !== null) return null;
  const live = await first(db, 'SELECT disabled, demo FROM "user" WHERE id = ?', actor.user.id);
  if (!live || Number(live.disabled) === 1 || Number(live.demo) === 1) await throwActorClosed(db, actor);
  const existing = await first(db, 'SELECT id FROM fabric_grants WHERE approval_id = ? AND exporter_id = ? AND connection_id = ?',
    appr.id, actor.user.id, preview.connection_id);
  if (!existing) {
    // The exact consuming operation may still have an outstanding grant batch.
    // Its missing effect is not proof of failure: keep the router lease
    // reconcilable instead of terminalizing409 before that batch can commit.
    // Legacy spent claims whose effect never landed also stay fail-closed;
    // a fresh approved operation is required to authorize another effect.
    const pending = pendingCommit();
    throw err(pending.status, pending.body.code, pending.body.error);
  }
  await auditFabric(db, actor, op, 'fabric.grant.commit', existing.id, 'reconciled');
  return { status: 200, body: { id: existing.id, note: 'Approval was already consumed for this grant.' } };
}

export async function commitGrant(db, actor, input = {}, op = null) {
  if (!isHuman(actor)) needHuman();
  if (typeof input.approvalId !== 'string' || !input.approvalId) throw err(409, 'NOT_APPROVED', 'An approved approval is required.');
  const appr = await first(db, 'SELECT * FROM approvals WHERE id = ?', input.approvalId);
  if (!appr || appr.action !== 'grant.commit') throw err(404, 'NOT_FOUND', 'Approval not found.');
  if (appr.created_by !== actor.user.id) {
    throw err(403, 'FORBIDDEN', 'This approval belongs to a different owner.');
  }
  if (appr.decision !== 'approved') throw err(409, 'NOT_APPROVED', `Approval is ${appr.decision}.`);
  if (appr.approver !== actor.user.id) throw err(403, 'FORBIDDEN', 'This approval belongs to a different owner.');
  const preview = await first(db, 'SELECT * FROM grant_previews WHERE id = ?', appr.preview_id);
  if (!preview) throw err(409, 'PREVIEW_STALE', 'Preview is gone.');
  if (input.previewHash !== appr.preview_digest || appr.preview_digest !== preview.digest) {
    throw err(412, 'PREVIEW_STALE', 'Preview hash mismatch; regenerate the preview.');
  }
  if ((await digestJson(parseJson(preview.canonical_json, null))) !== preview.digest) {
    throw err(500, 'INTERNAL', 'Preview integrity failure.');
  }
  if (!appr.issued_connection || appr.issued_connection !== preview.connection_id) {
    throw err(409, 'NOT_APPROVED', 'Approval cannot be validated against this connection; re-approve.');
  }
  const terms = parseJson(preview.canonical_json, {});
  await ownNode(db, actor, terms.exporterNode);
  const live = await first(db, 'SELECT disabled, demo FROM "user" WHERE id = ?', actor.user.id);
  if (!live || Number(live.disabled) === 1 || Number(live.demo) === 1) await throwActorClosed(db, actor);
  const opd = await opDigest(actor, op);
  if (appr.consumed_at) {
    const completed = await completeCommit(db, actor, appr, preview, op, opd);
    if (completed) return completed;
    return { status: 409, body: { error: 'Approval was already consumed.', code: 'APPROVAL_CONSUMED' } };
  }
  let conn;
  try {
    if (appr.expiry <= nowIso()) throw err(410, 'APPROVAL_EXPIRED', 'Approval expired.');
    conn = await first(db, 'SELECT * FROM connections WHERE id = ?', preview.connection_id);
    if (!conn || conn.state !== 'active') throw err(409, 'CONNECTION_DOWN', 'Connection is not active.');
    const vector = parseJson(appr.revision_vector, {});
    if (vector.connection !== conn.version) throw err(412, 'PREVIEW_STALE', 'Connection changed since the preview; regenerate it.');
    if (appr.issued_version !== conn.version) throw err(412, 'PREVIEW_STALE', 'Connection changed since the approval; re-approve.');
    // Revalidate every snapshot entry against live state (fast-fail; the
    // batch re-pins the whole snapshot at write time).
    for (const s of terms.snapshot || []) {
      const r = await first(db, 'SELECT owner_id, incarnation, imported_from FROM resources WHERE id = ?', s.resourceId);
      if (!r || r.owner_id !== actor.user.id || r.imported_from || r.incarnation !== s.incarnation) {
        throw err(412, 'PREVIEW_STALE', `Resource ${s.resourceId} changed since the preview.`);
      }
    }
  } catch (e) {
    // The approval snapshot may predate an older attempt's claim. A fresh
    // expiry/state/snapshot failure cannot terminalize that same operation
    // while its grant batch is outstanding (or its effect already applied).
    const raced = await first(db, 'SELECT id, consumed_by_op, consumed_action, consumed_target FROM approvals WHERE id = ?', appr.id);
    const recovered = await completeCommit(db, actor, raced, preview, op, opd);
    if (recovered) return recovered;
    throw e;
  }
  // The shared claim: exactly one of commit/revise/resume wins this
  // approval. Losers change nothing.
  const claimNow = nowIso();
  // Stable direct callers carry the same terminal fence even without a router
  // attempt. Calls without any stable op identity are independent operations.
  const ledger = op && typeof op.key === 'string' && op.key && typeof op.path === 'string' && op.path
    ? { actor: `${actor.kind}:${actor.user.id}`, key: op.key, path: op.path } : null;
  if (!(await claimApproval(db, { id: appr.id, action: 'grant.commit', target: null, op: opd, now: claimNow, ledger }))) {
    const raced = await first(db, 'SELECT id, consumed_by_op, consumed_action, consumed_target FROM approvals WHERE id = ?', appr.id);
    const recovered = await completeCommit(db, actor, raced, preview, op, opd);
    if (recovered) return recovered;
    return { status: 409, body: { error: 'Approval was already consumed.', code: 'APPROVAL_CONSUMED' } };
  }
  const id = `fg_${randHex(8)}`;
  const now = nowIso();
  const snapshotJson = JSON.stringify(terms.snapshot || []);
  let res;
  try {
    res = await runBatch(db, grantInsert({
      row: { id, connection_id: conn.id, recipient_node: terms.importerNode, recipient_workspace: terms.importerWorkspace, consumers: JSON.stringify(terms.consumers), snapshot: snapshotJson, actions: JSON.stringify(terms.actions), models: JSON.stringify(modelsOf(terms)), ceilings: JSON.stringify(terms.ceilings), route: terms.route, retention: terms.retention, expiry: terms.expiry, status: 'enforced', version: 1, preview_hash: preview.digest, approval_id: appr.id, exporter_id: actor.user.id, last_approval_id: appr.id, created_at: now, updated_at: now },
      snapshotJson, exporterId: actor.user.id, connId: conn.id, connVersion: conn.version, actorId: actor.user.id
    }));
  } catch {
    throw err(500, 'INTERNAL', 'Request failed.');
  }
  if (changes(res, 0) === 1) {
    await auditFabric(db, actor, op, 'fabric.grant.commit', id, `${(terms.snapshot || []).length} resources`);
    return { status: 201, body: { id, status: 'enforced', version: 1 } };
  }
  // Effect lost after a won claim (fail-closed burn): map precisely.
  const cur = await first(db, 'SELECT state, version FROM connections WHERE id = ?', conn.id);
  if (!cur || cur.state !== 'active') return { status: 409, body: { error: 'Connection is not active.', code: 'CONNECTION_DOWN' } };
  if (cur.version !== conn.version) return lostRace();
  const missing = await first(db, `SELECT 1 AS n FROM json_each(?) AS j LEFT JOIN resources r ON r.id = json_extract(j.value, '$.resourceId') WHERE r.id IS NULL OR r.owner_id != ? OR r.incarnation != json_extract(j.value, '$.incarnation') OR r.imported_from IS NOT NULL`, snapshotJson, actor.user.id);
  if (missing) return { status: 412, body: { error: 'A resource changed since the preview.', code: 'PREVIEW_STALE' } };
  const u = await first(db, 'SELECT disabled, demo FROM "user" WHERE id = ?', actor.user.id);
  if (!u || Number(u.disabled) === 1 || Number(u.demo) === 1) { await throwActorClosed(db, actor); }
  throw err(500, 'INTERNAL', 'Request failed.');
}

function modelsOf(terms) {
  const set = new Set();
  for (const s of terms.snapshot || []) for (const m of s.models || []) set.add(m);
  return [...set];
}

// Complete only a committed operation, never infer a previous revision from
// mutable grant state. Receipt identity also survives later valid revisions.
async function completeRevision(db, actor, id, operationId, requestHash) {
  const receipt = await first(db, 'SELECT * FROM fabric_revision_receipts WHERE operation_id = ?', operationId);
  if (!receipt) return null;
  if (receipt.actor_id !== actor.user.id || receipt.grant_id !== id || receipt.request_hash !== requestHash) {
    throw err(409, 'IDEMPOTENCY_CONFLICT', 'Operation is bound to a different request.');
  }
  const before = JSON.parse(receipt.before_json);
  const after = JSON.parse(receipt.after_json);
  const termsJson = JSON.stringify({ consumers: parseJson(before.consumers, []), snapshot: parseJson(before.snapshot, []),
    ceilings: parseJson(before.ceilings, {}), before, after, operationId, approval: JSON.parse(receipt.approval_json) });
  await ensureHistory(db, { grantId: id, version: receipt.before_version, termsJson,
    approvalId: receipt.approval_id, now: receipt.applied_at });
  const history = await first(db, 'SELECT * FROM fabric_grant_revisions WHERE id = ?', historyIdFor(id, receipt.before_version, receipt.approval_id));
  if (!history || history.terms_json !== termsJson || history.superseded_at !== receipt.applied_at
    || history.grant_id !== id || history.version !== receipt.before_version || history.approval_id !== receipt.approval_id) {
    throw err(500, 'HISTORY_CONFLICT', 'Revision history conflicts with its operation receipt.');
  }
  await ensureAudit(db, { op: operationId, action: 'fabric.grant.revise', actorId: receipt.actor_id,
    target: id, detail: `v${receipt.after_version} via session`, now: receipt.applied_at });
  return { status: 200, body: { id, version: receipt.after_version } };
}

async function fenceRevision(db, approvalId, id, operationId, requestHash, outcome = {
  status: 409, body: { error: 'Revision failed without applying; re-approve a fresh operation.', code: 'APPROVAL_CONSUMED' }
}) {
  await db.prepare(`INSERT OR IGNORE INTO fabric_revision_failures (operation_id, approval_id, grant_id, request_hash, response_code, response_body, failed_at)
    SELECT ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS(SELECT 1 FROM fabric_revision_receipts WHERE operation_id = ?)
    AND EXISTS(SELECT 1 FROM approvals WHERE id = ? AND consumed_by_op = ? AND consumed_action = 'grant.revise' AND consumed_target = ?)`)
    .bind(operationId, approvalId, id, requestHash, outcome.status, JSON.stringify(outcome.body), nowIso(), operationId, approvalId, operationId, id).run();
}

async function unresolvedRevision(db, approvalId, id, operationId, requestHash) {
  const failed = await first(db, 'SELECT * FROM fabric_revision_failures WHERE operation_id = ? AND approval_id = ? AND grant_id = ?', operationId, approvalId, id);
  if (failed) {
    if (failed.request_hash !== requestHash) throw err(409, 'IDEMPOTENCY_CONFLICT', 'Operation is bound to a different request.');
    return { status: failed.response_code, body: JSON.parse(failed.response_body) };
  }
  const claim = await first(db, 'SELECT consumed_by_op, consumed_action, consumed_target FROM approvals WHERE id = ?', approvalId);
  if (claim && claim.consumed_by_op === operationId && claim.consumed_action === 'grant.revise' && claim.consumed_target === id) {
    // The winner may still be running after a processing-lease takeover.
    // Never finalize a terminal 409 over an effect that could still commit.
    // A claim with no committed receipt cannot prove either success or a
    // historical before-image; keep the router operation uncertain.
    throw err(503, 'REVISION_UNCERTAIN', 'Revision outcome is not recorded; retry reconciliation or re-approve a fresh operation.');
  }
  return { status: 409, body: { error: 'Approval was already consumed.', code: 'APPROVAL_CONSUMED' } };
}

export async function reviseGrant(db, actor, id, input = {}, op = null) {
  if (!isHuman(actor)) needHuman();
  needId(id, 'Grant');
  const grant = await first(db, 'SELECT * FROM fabric_grants WHERE id = ?', id);
  if (!grant || !(await grantVisibleTo(db, actor, grant))) throw err(404, 'NOT_FOUND', 'Grant not found.');
  if (grant.quarantine_reason) throw err(409, 'GRANT_QUARANTINED', 'Grant is quarantined; re-issue it.');
  if (!await actorExportsGrant(db, actor, grant)) throw err(403, 'FORBIDDEN', 'Only the exporting owner can revise.');
  const live = await first(db, 'SELECT disabled, demo FROM "user" WHERE id = ?', actor.user.id);
  if (!live || Number(live.disabled) === 1 || Number(live.demo) === 1) await throwActorClosed(db, actor);
  const opd = await opDigest(actor, op);
  const requestHash = await digestJson(input);
  const completed = await completeRevision(db, actor, id, opd, requestHash);
  if (completed) return completed;
  // A committed receipt describes history, not fresh authority. Complete its
  // history/audit even after a later revoke, while keeping new revisions closed.
  if (grant.status === 'revoked') throw err(409, 'BAD_STATE', 'Revoked grants cannot be revised.');
  if (typeof input.approvalId !== 'string' || !input.approvalId) throw err(409, 'NOT_APPROVED', 'A fresh approved, unconsumed approval is required.');
  const appr = await first(db, 'SELECT * FROM approvals WHERE id = ?', input.approvalId);
  if (!appr || (appr.action !== 'grant.commit' && appr.action !== 'grant.revise') || appr.decision !== 'approved') {
    throw err(409, 'NOT_APPROVED', 'A fresh approved, unconsumed approval is required.');
  }
  if (appr.consumed_at) {
    // A concurrent winner may have committed since the first receipt read.
    const recovered = await completeRevision(db, actor, id, opd, requestHash);
    if (recovered) return recovered;
    return unresolvedRevision(db, appr.id, id, opd, requestHash);
  }
  if (appr.expiry <= nowIso()) throw err(410, 'APPROVAL_EXPIRED', 'Approval expired.');
  if (appr.created_by !== actor.user.id || appr.approver !== actor.user.id) {
    throw err(403, 'FORBIDDEN', 'This approval belongs to a different owner.');
  }
  const preview = await first(db, 'SELECT * FROM grant_previews WHERE id = ?', appr.preview_id);
  if (!preview || appr.preview_digest !== preview.digest || input.previewHash !== preview.digest) {
    throw err(412, 'PREVIEW_STALE', 'Preview mismatch; regenerate it.');
  }
  if ((await digestJson(parseJson(preview.canonical_json, null))) !== preview.digest) {
    throw err(500, 'INTERNAL', 'Preview integrity failure.');
  }
  const terms = parseJson(preview.canonical_json, {});
  if (terms.connectionId !== grant.connection_id || terms.importerNode !== grant.recipient_node || terms.importerWorkspace !== grant.recipient_workspace) {
    throw err(422, 'PREVIEW_MISMATCH', 'This preview names a different connection or recipient.');
  }
  const conn = await first(db, 'SELECT * FROM connections WHERE id = ?', grant.connection_id);
  if (!conn || conn.state !== 'active') throw err(409, 'CONNECTION_DOWN', 'Connection is not active.');
  // Scope: the approval must have been issued for this connection.
  if (!appr.issued_connection || appr.issued_connection !== grant.connection_id) {
    throw err(409, 'NOT_APPROVED', 'Approval was issued for a different connection; re-approve.');
  }
  if (appr.issued_version !== conn.version) throw err(412, 'PREVIEW_STALE', 'Connection changed since the approval; re-approve.');
  // Binding: exact (target, reviewed revision) for grant.revise;
  // causal grant-generation for legacy targetless grant.commit.
  if (appr.action === 'grant.revise') {
    if (appr.bound_grant_id !== id || appr.bound_grant_version !== grant.version) {
      throw err(412, 'PREVIEW_STALE', 'Grant changed since the approval; re-approve the current terms.');
    }
  } else {
    if (appr.issued_grant_gen === null || appr.issued_grant_gen === undefined || appr.issued_grant_gen !== conn.grant_gen) {
      throw err(412, 'PREVIEW_STALE', 'Grant changed since the approval; re-approve the current terms.');
    }
  }
  for (const s of terms.snapshot || []) {
    const r = await first(db, 'SELECT owner_id, incarnation, imported_from FROM resources WHERE id = ?', s.resourceId);
    if (!r || r.owner_id !== actor.user.id || r.imported_from || r.incarnation !== s.incarnation) {
      throw err(412, 'PREVIEW_STALE', `Resource ${s.resourceId} changed since the preview.`);
    }
  }
  // The shared claim: exactly one of commit/revise/resume wins this
  // approval. Losers change nothing. A won claim followed by an
  // effect failure leaves the approval spent (fail-closed reapproval).
  const claimNow = nowIso();
  if (!(await claimApproval(db, { id: appr.id, action: 'grant.revise', target: id, op: opd, now: claimNow }))) {
    const recovered = await completeRevision(db, actor, id, opd, requestHash);
    if (recovered) return recovered;
    return unresolvedRevision(db, appr.id, id, opd, requestHash);
  }
  const now = nowIso();
  const snapshotJson = JSON.stringify(terms.snapshot || []);
  const sets = { consumers: JSON.stringify(terms.consumers), snapshot: snapshotJson, models: JSON.stringify(modelsOf(terms)),
    ceilings: JSON.stringify(terms.ceilings), expiry: terms.expiry, previewHash: preview.digest, now };
  const after = { ...grant, consumers: sets.consumers, snapshot: sets.snapshot, models: sets.models, ceilings: sets.ceilings,
    expiry: sets.expiry, version: grant.version + 1, preview_hash: sets.previewHash, last_approval_id: appr.id, updated_at: now };
  let res;
  try {
    res = await runBatch(db, grantRevise({
      id, version: grant.version,
      sets, snapshotJson, exporterId: actor.user.id, connId: conn.id, connVersion: conn.version, apprId: appr.id, actorId: actor.user.id,
      receipt: { operationId: opd, requestHash, beforeJson: JSON.stringify(grant), afterJson: JSON.stringify(after),
        approvalJson: JSON.stringify({ ...appr, consumed_at: claimNow, consumed_by_op: opd, consumed_action: 'grant.revise', consumed_target: id }) }
    }));
  } catch {
    // This single conditional write races atomically with the effect batch.
    // Receipt first => no fence. Fence first => even a delayed batch cannot
    // apply. If the fence itself is uncertain, retries remain 503 until a
    // persisted receipt or fence establishes the outcome.
    try {
      await fenceRevision(db, appr.id, id, opd, requestHash);
    } catch { /* preserve unknown outcome; never invent history */ }
    throw err(500, 'INTERNAL', 'Request failed.');
  }
  if (changes(res, 0) === 1) {
    return completeRevision(db, actor, id, opd, requestHash);
  }
  // No effect committed: persist its classified terminal result before the
  // router can lose finalization. Otherwise a known CAS loss becomes 503 on
  // every retry merely because the HTTP ledger write failed.
  const recovered = await completeRevision(db, actor, id, opd, requestHash);
  if (recovered) return recovered;
  const outcome = await (async () => {
    const cur = await first(db, 'SELECT status, version, quarantine_reason, connection_id FROM fabric_grants WHERE id = ?', id);
    if (!cur) throw err(404, 'NOT_FOUND', 'Grant not found.');
    if (cur.quarantine_reason) return { status: 409, body: { error: 'Grant is quarantined; re-issue it.', code: 'GRANT_QUARANTINED' } };
    if (cur.status === 'revoked') return { status: 409, body: { error: 'Grant is revoked.', code: 'BAD_STATE' } };
    const curConn = await first(db, 'SELECT state, version FROM connections WHERE id = ?', cur.connection_id);
    if (!curConn || curConn.state !== 'active') return { status: 409, body: { error: 'Connection is not active.', code: 'CONNECTION_DOWN' } };
    if (cur.version !== grant.version || curConn.version !== conn.version) return lostRace();
    const u = await first(db, 'SELECT disabled, demo FROM "user" WHERE id = ?', actor.user.id);
    if (!u || Number(u.disabled) === 1 || Number(u.demo) === 1) { await throwActorClosed(db, actor); }
    return { status: 412, body: { error: 'A resource changed since the preview.', code: 'PREVIEW_STALE' } };
  })().catch(e => {
    if (!e.status || e.status >= 500) throw e;
    return { status: e.status, body: { error: e.message, code: e.code } };
  });
  await fenceRevision(db, appr.id, id, opd, requestHash, outcome);
  return outcome;
}

export async function pauseGrant(db, actor, id, input = {}, op = null) {
  if (!canNarrow(actor, 'fabric.pause')) throw err(403, 'FORBIDDEN', 'This credential cannot pause grants.');
  needId(id, 'Grant');
  const grant = await first(db, 'SELECT * FROM fabric_grants WHERE id = ?', id);
  if (!grant || !(await grantVisibleTo(db, actor, grant))) throw err(404, 'NOT_FOUND', 'Grant not found.');
  if (grant.quarantine_reason) throw err(409, 'GRANT_QUARANTINED', 'Grant is quarantined; re-issue it.');
  if (!await actorExportsGrant(db, actor, grant)) throw err(403, 'FORBIDDEN', 'Only the exporting owner can pause.');
  const completion = await restrictionContext(db, actor, op, 'fabric.grant.pause', id, input);
  if (completion.replay) return completion.replay;
  checkVersion(grant, input);
  if (grant.status !== 'enforced') throw err(409, 'BAD_STATE', `Grant is ${grant.status}.`);
  const now = nowIso();
  const res = await runBatch(db, [
    ...grantStatus({ id, version: grant.version, to: 'paused', from: 'enforced', apprId: null, connId: null, grantConnId: grant.connection_id, now, actorId: actor.user.id }),
    ...restrictionCompletion(actor, completion, 'fabric.grant.pause', id, { id, status: 'paused' }, now)
  ]);
  if (changes(res, 0) === 1) {
    return { status: 200, body: { id, status: 'paused' } };
  }
  const recovered = await restrictionContext(db, actor, op, 'fabric.grant.pause', id, input);
  if (recovered.replay) return recovered.replay;
  const cur = await first(db, 'SELECT status, version, quarantine_reason FROM fabric_grants WHERE id = ?', id);
  if (!cur) throw err(404, 'NOT_FOUND', 'Grant not found.');
  if (cur.quarantine_reason) return { status: 409, body: { error: 'Grant is quarantined; re-issue it.', code: 'GRANT_QUARANTINED' } };
  if (cur.status === 'paused' && cur.version !== grant.version) return { status: 200, body: { id, status: 'paused' } };
  if (cur.version !== grant.version) return lostRace();
  if (cur.status !== 'enforced') return { status: 409, body: { error: `Grant is ${cur.status}.`, code: 'BAD_STATE' } };
  await throwActorClosed(db, actor);
}

export async function resumeGrant(db, actor, id, input = {}, op = null) {
  if (!isHuman(actor)) needHuman();
  needId(id, 'Grant');
  const grant = await first(db, 'SELECT * FROM fabric_grants WHERE id = ?', id);
  if (!grant || !(await grantVisibleTo(db, actor, grant))) throw err(404, 'NOT_FOUND', 'Grant not found.');
  if (grant.quarantine_reason) throw err(409, 'GRANT_QUARANTINED', 'Grant is quarantined; re-issue it.');
  if (!await actorExportsGrant(db, actor, grant)) throw err(403, 'FORBIDDEN', 'Only the exporting owner can resume.');
  // The shared status receipt ledger is action-bound, not an admission grant:
  // resumes remain charged expansions and require a fresh owner approval.
  // Its immutable response survives later pause/revoke, revision or disconnect.
  const recover = async () => {
    const live = await first(db, 'SELECT disabled, demo FROM "user" WHERE id = ?', actor.user.id);
    if (!live || Number(live.disabled) === 1 || Number(live.demo) === 1) await throwActorClosed(db, actor);
    return restrictionContext(db, actor, op, 'fabric.grant.resume', id, input);
  };
  const completion = await recover();
  if (completion.replay) return completion.replay;
  const body = { id, status: 'enforced' };
  try {
    const conn = await first(db, 'SELECT * FROM connections WHERE id = ?', grant.connection_id);
    if (!conn || conn.state !== 'active') throw err(409, 'CONNECTION_DOWN', 'Connection is not active.');
    checkVersion(grant, input);
    if (grant.status !== 'paused') throw err(409, 'BAD_STATE', `Grant is ${grant.status}.`);
    if (typeof input.approvalId !== 'string' || !input.approvalId) throw err(409, 'NOT_APPROVED', 'A fresh approved resume approval is required.');
    const appr = await first(db, 'SELECT * FROM approvals WHERE id = ?', input.approvalId);
    if (!appr || appr.action !== 'grant.resume' || appr.target_id !== id || appr.decision !== 'approved') {
      throw err(409, 'NOT_APPROVED', 'A fresh approved resume approval is required.');
    }
    if (appr.created_by !== actor.user.id || appr.approver !== actor.user.id) throw err(403, 'FORBIDDEN', 'This approval belongs to a different owner.');
    if (appr.consumed_at) {
      if (appr.consumed_by_op === completion.operationId && appr.consumed_action === 'grant.resume' && appr.consumed_target === id) {
        throw err(503, 'RESUME_UNCERTAIN', 'Resume outcome is not recorded; retry reconciliation or re-approve a fresh operation.');
      }
      throw err(409, 'NOT_APPROVED', 'A fresh approved resume approval is required.');
    }
    if (appr.expiry <= nowIso()) throw err(410, 'APPROVAL_EXPIRED', 'Approval expired.');
    if (appr.bound_grant_id !== id || appr.bound_grant_version !== grant.version) throw err(412, 'PREVIEW_STALE', 'Grant changed since the approval.');
    if (!appr.issued_connection || appr.issued_connection !== grant.connection_id || appr.issued_version !== conn.version) {
      throw err(412, 'PREVIEW_STALE', 'Connection changed since the approval; re-approve.');
    }
    const vector = parseJson(appr.revision_vector, {});
    if (vector.grant !== grant.version) throw err(412, 'PREVIEW_STALE', 'Grant changed since the approval.');
    const now = nowIso();
    const status = grantStatus({ id, version: grant.version, to: 'enforced', from: 'paused', apprId: appr.id, connId: conn.id, connVersion: conn.version, grantConnId: conn.id, now, actorId: actor.user.id });
    // The approval CAS and all effects commit together. A lost/failed batch
    // cannot spend consent without its exact effect/receipt, or apply a
    // different operation's already-consumed approval.
    status[0][0] += ` AND changes() = 1 AND EXISTS(SELECT 1 FROM approvals WHERE id = ? AND consumed_by_op = ? AND consumed_action = 'grant.resume' AND consumed_target = ?)`;
    status[0].push(appr.id, completion.operationId, id);
    const res = await runBatch(db, [
      [`UPDATE approvals SET consumed_at = ?, consumed_by_op = ?, consumed_action = 'grant.resume', consumed_target = ?
        WHERE id = ? AND consumed_at IS NULL AND decision = 'approved' AND expiry > ?
        AND action = 'grant.resume' AND target_id = ? AND created_by = ? AND approver = ?
        AND bound_grant_id = ? AND bound_grant_version = ? AND issued_connection = ? AND issued_version = ?
        AND EXISTS(SELECT 1 FROM "user" WHERE id = ? AND disabled = 0 AND demo = 0)
        AND EXISTS(SELECT 1 FROM fabric_grants WHERE id = ? AND version = ? AND status = 'paused' AND quarantine_reason IS NULL AND exporter_id = ?)
        AND EXISTS(SELECT 1 FROM connections WHERE id = ? AND version = ? AND state = 'active')`,
        now, completion.operationId, id, appr.id, now, id, actor.user.id, actor.user.id, id, grant.version, conn.id, conn.version,
        actor.user.id, id, grant.version, actor.user.id, conn.id, conn.version],
      ...status,
      ...restrictionCompletion(actor, completion, 'fabric.grant.resume', id, body, now)
    ]);
    if (changes(res, 1) === 1) return { status: 200, body };
    const recovered = await recover();
    if (recovered.replay) return recovered.replay;
    const prior = await first(db, 'SELECT consumed_at, consumed_by_op, consumed_action, consumed_target, expiry FROM approvals WHERE id = ?', appr.id);
    if (prior && prior.consumed_at) {
      if (prior.consumed_by_op === completion.operationId && prior.consumed_action === 'grant.resume' && prior.consumed_target === id) {
        throw err(503, 'RESUME_UNCERTAIN', 'Resume outcome is not recorded; retry reconciliation or re-approve a fresh operation.');
      }
      return { status: 409, body: { error: 'A fresh approved resume approval is required.', code: 'NOT_APPROVED' } };
    }
    const cur = await first(db, 'SELECT status, version, quarantine_reason FROM fabric_grants WHERE id = ?', id);
    if (!cur) throw err(404, 'NOT_FOUND', 'Grant not found.');
    if (cur.quarantine_reason) return { status: 409, body: { error: 'Grant is quarantined; re-issue it.', code: 'GRANT_QUARANTINED' } };
    if (cur.status === 'revoked') return { status: 409, body: { error: 'Grant is revoked.', code: 'BAD_STATE' } };
    if (cur.version !== grant.version) return lostRace();
    const curConn = await first(db, 'SELECT state, version FROM connections WHERE id = ?', grant.connection_id);
    if (!curConn || curConn.state !== 'active') return { status: 409, body: { error: 'Connection is not active.', code: 'CONNECTION_DOWN' } };
    if (curConn.version !== conn.version) return lostRace();
    if (prior && prior.expiry <= nowIso()) throw err(410, 'APPROVAL_EXPIRED', 'Approval expired.');
    await throwActorClosed(db, actor);
  } catch (e) {
    // An overlapping original attempt can publish its receipt after our first
    // read, even before a fresh-state precheck or after a zero-row CAS.
    const recovered = await recover();
    if (recovered.replay) return recovered.replay;
    throw e;
  }
}

export async function revokeGrant(db, actor, id, input = {}, op = null) {
  if (!canNarrow(actor, 'fabric.revoke')) throw err(403, 'FORBIDDEN', 'This credential cannot revoke grants.');
  needId(id, 'Grant');
  const grant = await first(db, 'SELECT * FROM fabric_grants WHERE id = ?', id);
  if (!grant || !(await grantVisibleTo(db, actor, grant))) throw err(404, 'NOT_FOUND', 'Grant not found.');
  if (grant.quarantine_reason) throw err(409, 'GRANT_QUARANTINED', 'Grant is quarantined; re-issue it.');
  if (!await actorExportsGrant(db, actor, grant)) throw err(403, 'FORBIDDEN', 'Only the exporting owner can revoke.');
  const completion = await restrictionContext(db, actor, op, 'fabric.grant.revoke', id, input);
  if (completion.replay) return completion.replay;
  checkVersion(grant, input);
  if (grant.status === 'revoked') return { status: 200, body: { id, status: 'revoked', note: 'Already revoked.' } };
  const now = nowIso();
  const res = await runBatch(db, [
    ...grantStatus({ id, version: grant.version, to: 'revoked', from: 'not-revoked', apprId: null, connId: null, grantConnId: grant.connection_id, now, actorId: actor.user.id }),
    ...restrictionCompletion(actor, completion, 'fabric.grant.revoke', id, { id, status: 'revoked' }, now)
  ]);
  if (changes(res, 0) === 1) {
    return { status: 200, body: { id, status: 'revoked' } };
  }
  const recovered = await restrictionContext(db, actor, op, 'fabric.grant.revoke', id, input);
  if (recovered.replay) return recovered.replay;
  const cur = await first(db, 'SELECT status, version, quarantine_reason FROM fabric_grants WHERE id = ?', id);
  if (!cur) throw err(404, 'NOT_FOUND', 'Grant not found.');
  if (cur.status === 'revoked') return { status: 200, body: { id, status: 'revoked', note: 'Already revoked.' } };
  if (cur.quarantine_reason) return { status: 409, body: { error: 'Grant is quarantined; re-issue it.', code: 'GRANT_QUARANTINED' } };
  if (cur.version !== grant.version) return lostRace();
  await throwActorClosed(db, actor);
}

async function actorExportsGrant(db, actor, grant) {
  // The exporter is the recorded issuing authority: exact match only.
  // Quarantined, issuer-ambiguous, or exporter-less rows authorize no
  // mutation for anyone. No live-ownership fallback: a current owner
  // who did not issue the grant cannot mutate it.
  if (!grant || grant.quarantine_reason) return false;
  if (!grant.exporter_id) return false;
  return grant.exporter_id === actor.user.id;
}

export async function listGrants(db, actor, scope = 'all') {
  const mine = (await all(db, 'SELECT id FROM fabric_nodes WHERE owner_id = ?', actor.user.id)).map((n) => n.id);
  if (!mine.length) return { status: 200, body: { items: [], total: 0 } };
  let rows = [];
  if (scope === 'outgoing' || scope === 'all') {
    rows = rows.concat(await chunkedAll(db, 'SELECT g.* FROM fabric_grants g JOIN connections c ON c.id = g.connection_id WHERE c.a_node IN', mine, ''));
    rows = rows.concat(await chunkedAll(db, 'SELECT g.* FROM fabric_grants g JOIN connections c ON c.id = g.connection_id WHERE c.b_node IN', mine, ''));
  }
  if (scope === 'incoming' || scope === 'all') {
    rows = rows.concat(await chunkedAll(db, 'SELECT * FROM fabric_grants WHERE recipient_node IN', mine, ' ORDER BY created_at DESC'));
  }
  const seen = new Set();
  rows = rows.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
  // Outgoing = I export (recipient is a peer node); incoming = granted to my node.
  if (scope === 'outgoing') rows = rows.filter((r) => !mine.includes(r.recipient_node));
  if (scope === 'incoming') rows = rows.filter((r) => mine.includes(r.recipient_node));
  return { status: 200, body: { items: rows.map(decorateGrant), total: rows.length } };
}

function decorateGrant(g) {
  return { ...g, consumers: parseJson(g.consumers, []), snapshot: parseJson(g.snapshot, []), actions: parseJson(g.actions, []), models: parseJson(g.models, []), ceilings: parseJson(g.ceilings, {}), expiredNow: g.expiry <= nowIso() };
}

export async function getGrant(db, actor, id) {
  if (typeof id !== 'string' || !id) throw err(404, 'NOT_FOUND', 'Grant not found.');
  const grant = await first(db, 'SELECT * FROM fabric_grants WHERE id = ?', id);
  if (!grant || !(await grantVisibleTo(db, actor, grant))) throw err(404, 'NOT_FOUND', 'Grant not found.');
  return { status: 200, body: decorateGrant(grant) };
}

// ---- denies ----
export async function createDeny(db, actor, input = {}, op = null) {
  if (isAgentKey(actor)) throw err(403, 'FORBIDDEN', 'Agent credentials cannot manage denies.');
  const resourceId = typeof input.resourceId === 'string' ? input.resourceId.slice(0, 64) : null;
  if (resourceId) {
    const r = await first(db, 'SELECT owner_id FROM resources WHERE id = ?', resourceId);
    if (!r || r.owner_id !== actor.user.id) throw err(404, 'NOT_FOUND', 'Resource not found or not yours.');
  }
  const id = await opEntityId(actor, op, 'fdeny');
  const res = await runBatch(db, creatorInsert({
    table: 'fabric_denies',
    columns: ['id', 'owner_id', 'principal', 'resource_id', 'action', 'created_at'],
    values: [id, actor.user.id, input.principal ? String(input.principal).slice(0, 128) : null, resourceId, input.action ? String(input.action).slice(0, 32) : null, nowIso()],
    id, actorId: actor.user.id
  }));
  if (changes(res, 0) === 1) {
    await auditFabric(db, actor, op, 'fabric.deny.create', id);
    return { status: 201, body: { id } };
  }
  const existing = await first(db, 'SELECT id, owner_id FROM fabric_denies WHERE id = ?', id);
  if (existing && existing.owner_id === actor.user.id) {
    await auditFabric(db, actor, op, 'fabric.deny.create', id);
    return { status: 200, body: { id, reconciled: true } };
  }
  await throwActorClosed(db, actor);
}

export async function listDenies(db, actor) {
  const rows = await all(db, 'SELECT * FROM fabric_denies WHERE owner_id = ? ORDER BY created_at DESC', actor.user.id);
  return { status: 200, body: { items: rows, total: rows.length } };
}

export async function deleteDeny(db, actor, id, op = null) {
  needId(id, 'Deny');
  const row = await first(db, 'SELECT * FROM fabric_denies WHERE id = ?', id);
  if (!row || row.owner_id !== actor.user.id) throw err(404, 'NOT_FOUND', 'Deny not found.');
  if (op?.budgeted) await checkWriteBudget(db, actor.user.id);
  const del = await db.prepare('DELETE FROM fabric_denies WHERE id = ? AND EXISTS(SELECT 1 FROM "user" u WHERE u.id = ? AND u.disabled = 0 AND u.demo = 0)').bind(id, actor.user.id).run();
  if (!del.meta.changes) {
    const gone = await first(db, 'SELECT id FROM fabric_denies WHERE id = ?', id);
    if (!gone) throw err(404, 'NOT_FOUND', 'Deny not found.');
    await throwActorClosed(db, actor);
  }
  await auditFabric(db, actor, op, 'fabric.deny.delete', id);
  return { status: 200, body: { id, deleted: true } };
}

// ---- authorization preview (explainable, no terms leak) ----
export async function authorizationPreview(db, actor, input = {}) {
  const node = await ownNode(db, actor, input.nodeId);
  const request = {
    resourceId: String(input.resourceId || ''), incarnation: String(input.incarnation || ''),
    action: String(input.action || 'infer'), model: String(input.model || ''),
    peerNode: node.id, peerWorkspace: node.workspace,
    consumer: String(input.consumer || actor.user.id),
    maxTokens: Number(input.maxTokens) || 0, route: 'fixture', at: nowIso()
  };
  // Live identity gate (fail-closed): the grant snapshot authorizes a
  // specific resource incarnation. If the authoritative row is gone or its
  // incarnation moved on (replacement/re-registration), no stored snapshot
  // may authorize, however the caller phrases the request.
  const live = await first(db, 'SELECT owner_id, incarnation FROM resources WHERE id = ?', request.resourceId);
  const rows = await all(db, `SELECT g.* FROM fabric_grants g JOIN connections c ON c.id = g.connection_id
    WHERE g.recipient_node = ? AND g.recipient_workspace = ? AND g.status = 'enforced' AND c.state = 'active'`, node.id, node.workspace);
  const grants = [];
  if (live) {
    for (const g of rows) {
      const hit = parseJson(g.snapshot, []).find((s) => s.resourceId === request.resourceId);
      if (!hit || hit.incarnation !== live.incarnation) continue;
      // Issuing-authority binding: a grant authorizes only while the live
      // row is still held by the recorded exporter. Ownership drift fails
      // closed even when the incarnation is unchanged.
      if (!g.exporter_id || g.quarantine_reason || live.owner_id !== g.exporter_id) continue;
      grants.push({
        id: g.id, status: g.status, recipientNode: g.recipient_node, recipientWorkspace: g.recipient_workspace,
        consumers: parseJson(g.consumers, []), resourceId: hit.resourceId, incarnation: hit.incarnation,
        actions: parseJson(g.actions, []), models: parseJson(g.models, []),
        notBefore: g.created_at, expiry: g.expiry, ceilings: parseJson(g.ceilings, {}), route: g.route, revision: g.version
      });
    }
  }
  // Deny scope: only the live resource owner's denies apply (no
  // cross-tenant deny bleed, and no denies for a removed resource).
  const denies = live ? (await all(db, 'SELECT principal, resource_id AS resourceId, action FROM fabric_denies WHERE owner_id = ? AND (resource_id = ? OR resource_id IS NULL)', live.owner_id, request.resourceId))
    .map((d) => ({ principal: d.principal ?? undefined, resourceId: d.resourceId ?? undefined, action: d.action ?? undefined })) : [];
  const out = evaluate(request, { grants, denies });
  return { status: 200, body: { decision: out.decision, code: out.code, witness: out.witness, evaluated: out.evaluated } };
}

// ---- discovery (policy-filtered) ----
export async function discoverResources(db, actor) {
  const mine = (await all(db, 'SELECT id, workspace FROM fabric_nodes WHERE owner_id = ?', actor.user.id));
  const ids = mine.map((m) => m.id);
  const own = await all(db, 'SELECT id, name, incarnation FROM resources WHERE owner_id = ?', actor.user.id);
  const items = own.map((r) => ({ id: r.id, name: r.name, incarnation: r.incarnation, via: 'owned' }));
  if (ids.length) {
    const wsOf = new Map(mine.map((m) => [m.id, m.workspace]));
    const grants = await chunkedAll(db, 'SELECT g.consumers, g.snapshot, g.exporter_id, g.quarantine_reason, g.recipient_workspace, g.recipient_node FROM fabric_grants g JOIN connections c ON c.id = g.connection_id WHERE g.recipient_node IN', ids,
      " AND g.status = 'enforced' AND c.state = 'active' AND g.expiry > ?", [nowIso()]);
    const seen = new Set(items.map((i) => i.id));
    for (const g of grants) {
      if (wsOf.get(g.recipient_node) !== g.recipient_workspace) continue;
      const consumers = parseJson(g.consumers, []);
      for (const s of parseJson(g.snapshot, [])) {
        if (seen.has(s.resourceId)) continue;
        // Effective visibility, mirroring the authorization matcher: the
        // live row must still be the snapshotted incarnation, and at least
        // one grant consumer must be undenied for inference — otherwise
        // discovery would advertise what authorization refuses. Live
        // name/incarnation are reported, never stale copies. Deduplication
        // happens only for visible witnesses: an ineligible grant must not
        // mask the same resource granted eligibly elsewhere.
        const r = await first(db, 'SELECT name, owner_id, incarnation FROM resources WHERE id = ?', s.resourceId);
        if (!r || r.incarnation !== s.incarnation) continue;
        if (!g.exporter_id || g.quarantine_reason || r.owner_id !== g.exporter_id) continue;
        let visible = false;
        for (const c of consumers) {
          const blocked = await first(db, `SELECT id FROM fabric_denies WHERE owner_id = ? AND (resource_id = ? OR resource_id IS NULL)
            AND (principal IS NULL OR principal = ?) AND (action IS NULL OR action = ?)`, r.owner_id, s.resourceId, String(c), 'infer');
          if (!blocked) { visible = true; break; }
        }
        if (!visible) continue;
        seen.add(s.resourceId);
        items.push({ id: s.resourceId, name: r.name, incarnation: r.incarnation, via: 'grant' });
      }
    }
  }
  return { status: 200, body: { items, total: items.length, note: 'Fixture discovery: owned resources plus effectively visible grant resources for your nodes only.' } };
}

// ---- idempotency (router uses these around mutations) ----
// States: processing -> completed (immutable) or uncertain (5xx seen,
// hash retained) -> processing (reclaimed) -> completed. Quarantined
// rows never replay or execute. Binding (method/path/body-hash) is
// compared FIRST for every existing state; any difference is 409.
const IDEM_TTL_MS = 10 * 60e3;
export async function checkIdempotency(db, actor, method, path, key, bodyHash, restriction = null) {
  if (!key || typeof key !== 'string' || key.length > 128) throw err(400, 'IDEMPOTENCY_REQUIRED', 'Idempotency-Key header is required for this mutation.');
  // Existing outcomes are still owner-authenticated reads. Check current DB
  // authority before returning a replay or taking its processing lease, not
  // only when admitting a new operation.
  const live = await first(db, 'SELECT disabled, demo FROM "user" WHERE id = ?', actor.user.id);
  if (!live || Number(live.disabled) === 1 || Number(live.demo) === 1) await throwActorClosed(db, actor);
  const actorKey = `${actor.kind}:${actor.user.id}`;
  const existing = await first(db, 'SELECT * FROM idempotency_records WHERE idem_key = ? AND actor = ?', key, actorKey);
  if (!existing) {
    await admitFabricOperation(db, actor, method, path, key, bodyHash, restriction);
    try {
      await db.prepare('INSERT INTO idempotency_records (idem_key, actor, method, path, request_hash, status, response_code, response_body, created_at, attempt) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)')
        .bind(key, actorKey, method, path, bodyHash, 'processing', nowIso(), freshAttempt()).run();
    } catch {
      const raced = await first(db, 'SELECT * FROM idempotency_records WHERE idem_key = ? AND actor = ?', key, actorKey);
      if (!raced) throw err(500, 'INTERNAL', 'Request failed.');
      return finishIdempotentRead(db, actorKey, raced, method, path, bodyHash);
    }
    return null;
  }
  return finishIdempotentRead(db, actorKey, existing, method, path, bodyHash);
}

async function finishIdempotentRead(db, actorKey, rec, method, path, bodyHash) {
  if (rec.method !== method || rec.path !== path || rec.request_hash !== bodyHash) {
    throw err(409, 'IDEMPOTENCY_MISMATCH', 'Idempotency-Key was already used with a different request.');
  }
  if (rec.status === 'quarantined') {
    throw err(409, 'IDEMPOTENCY_QUARANTINED', 'This operation record was quarantined; retry with a new key.');
  }
  // Read-path redaction backstops the write path and migrations: even a
  // pre-repair persisted top-level secret is stripped before replay.
  if (rec.status === 'completed') return { status: rec.response_code, body: redactForReplay(parseJson(rec.response_body, {})), replayed: true };
  // Reclaimable: a stale processing record (crashed attempt, not an
  // in-flight one) or any uncertain record (5xx seen, effect unknown).
  // Reclaim is conditional on the exact observed row, so only one
  // reclaimer proceeds, and carries a fresh attempt token.
  const age = Date.now() - Date.parse(rec.created_at);
  const stale = rec.status === 'processing' && Number.isFinite(age) && age > IDEM_TTL_MS;
  if (rec.status === 'uncertain' || stale) {
    const token = freshAttempt();
    const now = nowIso();
    const steal = await db.prepare('UPDATE idempotency_records SET status = ?, attempt = ?, created_at = ? WHERE idem_key = ? AND actor = ? AND status = ? AND created_at = ?')
      .bind('processing', token, now, keyOf(rec), actorKey, rec.status, rec.created_at).run();
    if (steal.meta.changes) return null;
    const reread = await first(db, 'SELECT * FROM idempotency_records WHERE idem_key = ? AND actor = ?', keyOf(rec), actorKey);
    if (reread && reread.status === 'completed' && reread.method === method && reread.path === path && reread.request_hash === bodyHash) {
      return { status: reread.response_code, body: redactForReplay(parseJson(reread.response_body, {})), replayed: true };
    }
  }
  throw err(409, 'IDEMPOTENCY_PENDING', 'Same key is already processing; retry.');
}

function keyOf(rec) {
  return rec.idem_key;
}

export { readAttempt };

// Finalize: processing -> completed ONLY. Completed rows are immutable:
// a late or duplicate finalization changes zero rows instead of
// overwriting the recorded outcome. The router passes the attempt it
// claimed; legacy direct callers omit it (status-only fencing).
export async function storeIdempotency(db, actor, key, status, body, attempt = null) {
  const actorKey = `${actor.kind}:${actor.user.id}`;
  if (status === 401 || status === 403) {
    // Authority can change after the router gate and before store execution.
    // Deny that caller, but never replace a proved applied outcome with its
    // temporary authorization error. The HTTP/MCP caller keeps its 401/403;
    // these local arguments only control durable operation bookkeeping.
    const rec = await first(db, 'SELECT * FROM idempotency_records WHERE idem_key = ? AND actor = ?', key, actorKey);
    if (rec && rec.status === 'processing' && (attempt === null || attempt === undefined || rec.attempt === attempt)) {
      const operationId = await opDigest(actor, { key, path: rec.path });
      const applied = await first(db, `SELECT response_body FROM fabric_restriction_receipts
        WHERE operation_id = ? AND actor_id = ? AND request_hash = ?`, operationId, actor.user.id, rec.request_hash);
      if (applied) {
        // Status effects, exact response and audit are one transaction.
        status = 200; body = JSON.parse(applied.response_body);
      } else {
        const revision = await first(db, `SELECT operation_id FROM fabric_revision_receipts
          WHERE operation_id = ? AND actor_id = ? AND request_hash = ?`, operationId, actor.user.id, rec.request_hash);
        const commit = !revision && await first(db, `SELECT g.id FROM approvals a JOIN fabric_grants g ON g.approval_id = a.id
          WHERE a.consumed_by_op = ? AND a.consumed_action = 'grant.commit' AND a.consumed_target IS NULL
          AND a.created_by = ? AND a.approver = ? AND g.exporter_id = ? AND g.connection_id = a.issued_connection`,
          operationId, actor.user.id, actor.user.id, actor.user.id);
        const ownerClosed = (status === 401 && body && body.code === 'AUTH_REQUIRED')
          || (status === 403 && body && body.code === 'DEMO_RESTRICTED');
        if (revision || commit || ownerClosed) {
          // Forensic completion needs an authorized retry. Temporary owner
          // closure can also precede an older in-flight effect/receipt, so it
          // cannot prove a terminal outcome even when no receipt exists yet.
          // Other authorization failures remain terminal; the pre-ledger live
          // check prevents closed users repeatedly reclaiming this operation.
          await releaseIdempotency(db, actor, key, attempt);
          return;
        }
      }
    }
  }
  // Replays return the recorded response (4xx terminal failures included),
  // minus one-time secret fields. Bodies derive from 64 KiB-capped
  // requests, so TEXT stays bounded.
  const redacted = JSON.stringify(redactForReplay(body));
  let commitFence = '', commitArgs = [];
  if (status >= 400 && status < 500 && status !== 401 && status !== 403) {
    const rec = await first(db, 'SELECT path FROM idempotency_records WHERE idem_key = ? AND actor = ?', key, actorKey);
    if (rec && isCommitFailure(rec.path, status)) {
      const operationId = await opDigest(actor, { key, path: rec.path });
      // Paired with the commit approval-CAS fence: failure first forbids a
      // delayed claim; claim first forbids a terminal failure. This predicate
      // is evaluated by SQLite/D1 inside the write, never from a stale read.
      commitFence = ` AND NOT EXISTS(SELECT 1 FROM approvals WHERE consumed_by_op = ?
        AND consumed_action = 'grant.commit' AND consumed_target IS NULL AND created_by = ? AND approver = ?)`;
      commitArgs = [operationId, actor.user.id, actor.user.id];
    }
  }
  const attemptArgs = attempt === null || attempt === undefined ? [] : [attempt];
  const result = await db.prepare(`UPDATE idempotency_records SET status = ?, response_code = ?, response_body = ?
    WHERE idem_key = ? AND actor = ? AND status = ?${attemptArgs.length ? ' AND attempt = ?' : ''}${commitFence}`)
    .bind('completed', status, redacted, key, actorKey, 'processing', ...attemptArgs, ...commitArgs).run();
  if (commitFence && Number(result.meta.changes) === 0) {
    // A consumed claim or a newer attempt owns the unknown outcome. Do not
    // cache the caller's fresh-precondition error over that pending effect.
    await releaseIdempotency(db, actor, key, attempt);
    return pendingCommit();
  }
}

// Unknown (5xx) outcomes are NOT recorded as terminal and the record is
// NOT deleted: it is marked uncertain with its request binding intact,
// so a retry with the same key either reclaims (same binding) or
// conflicts (changed binding). Per-operation recovery converges without
// duplicating side effects.
export async function releaseIdempotency(db, actor, key, attempt = null) {
  const actorKey = `${actor.kind}:${actor.user.id}`;
  if (attempt === null || attempt === undefined) {
    await db.prepare('UPDATE idempotency_records SET status = ? WHERE idem_key = ? AND actor = ? AND status = ?').bind('uncertain', key, actorKey, 'processing').run();
  } else {
    await db.prepare('UPDATE idempotency_records SET status = ? WHERE idem_key = ? AND actor = ? AND status = ? AND attempt = ?').bind('uncertain', key, actorKey, 'processing', attempt).run();
  }
}
