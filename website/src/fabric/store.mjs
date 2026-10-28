/* Built with Meta Muse. */
// Federation control-plane core (F1): nodes, invitations, connections,
// previews, approvals, grants, denies, authorization previews. Pure-ish
// async functions over (db, actor, input); HTTP and MCP layers share them.
// Actor: { kind: 'session'|'key', user, keyId, delegate[] }. Fixture
// transports only; no execution, no network peers in F1.
import { first, all, audit } from '../lib/store.js';
import { verifierFor, timingSafeEqualStr } from '../lib/keys.js';
import { httpError } from '../lib/validate.js';
import { canonicalize, digestJson } from './canonical.mjs';
import { evaluate } from './policy.mjs';

const err = (status, code, message) => httpError(status, message, code);
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
async function auditFabric(db, actor, action, target, detail = '') {
  const via = actor.kind === 'key' ? ` via key ${actor.keyId || 'unknown'}${isAgentKey(actor) ? ' (agent)' : ''}` : ' via session';
  await audit(db, actor.user.id, action, target, (detail + via).slice(0, 300));
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
  try {
    await db.prepare('INSERT INTO fabric_nodes (id, owner_id, workspace, label, fingerprint, protocol, transport, issuer, status, node_secret_verifier, node_secret_salt, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)')
      .bind(nodeId, actor.user.id, workspace, label, fingerprint, 'fixture-0', 'fixture', 'fixture-local', 'registered', await verifierFor(tok.secret, tok.salt), tok.salt, now, now).run();
  } catch {
    // Same operation id already exists: a prior attempt committed this
    // node and then failed (5xx) before responding. Converge on the one
    // row instead of registering a second node. The original secret is
    // unrecoverable by design (verifier-only custody), so the reconciled
    // response carries metadata only.
    const existing = await first(db, 'SELECT * FROM fabric_nodes WHERE id = ?', nodeId);
    if (existing && existing.owner_id === actor.user.id) {
      return { status: 200, body: { id: existing.id, workspace: existing.workspace, label: existing.label, fingerprint: existing.fingerprint, protocol: existing.protocol, transport: existing.transport, status: existing.status, reconciled: true, note: 'This registration already committed; its one-time secret cannot be re-shown. Register a new node if you need a usable secret.' } };
    }
    throw err(500, 'INTERNAL', 'Request failed.');
  }
  await auditFabric(db, actor, 'fabric.node.register', nodeId, label);
  return { status: 201, body: { id: nodeId, workspace, label, fingerprint, protocol: 'fixture-0', transport: 'fixture', status: 'registered', nodeSecret: tok.secret, oneTime: 'This node secret is shown once. It proves node possession when accepting invitations.' } };
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
  try {
    await db.prepare('INSERT INTO invitations (id, issuer_node, recipient_node, recipient_workspace, purpose, token_verifier, token_salt, state, expiry, use_record, created_by, created_at, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL)')
      .bind(invId, issuer.id, recipientNode, recipientWorkspace, purpose, await verifierFor(secret, salt), salt, 'issued', expiry, actor.user.id, now).run();
  } catch {
    // Same operation id already exists: converge on the one invitation.
    // The original token is unrecoverable (verifier-only custody).
    const existing = await first(db, 'SELECT * FROM invitations WHERE id = ?', invId);
    if (existing && existing.created_by === actor.user.id) {
      return { status: 200, body: { id: existing.id, issuerNode: existing.issuer_node, recipientNode: existing.recipient_node, recipientWorkspace: existing.recipient_workspace, purpose: existing.purpose, expiry: existing.expiry, reconciled: true, note: 'This invitation already committed; its one-time token cannot be re-shown. Issue a new invitation if needed.' } };
    }
    throw err(500, 'INTERNAL', 'Request failed.');
  }
  await auditFabric(db, actor, 'fabric.invitation.create', invId, `${issuer.id} -> ${recipientNode}`);
  return { status: 201, body: { id: invId, issuerNode: issuer.id, recipientNode, recipientWorkspace, purpose, expiry, token: secret, oneTime: 'This invitation token is shown once. Deliver it to the recipient out of band.' } };
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
    const rows = await all(db, `SELECT * FROM invitations WHERE ${col} IN (${ids.map(() => '?').join(',')}) ORDER BY created_at DESC`, ...ids);
    return rows;
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

export async function acceptInvitation(db, actor, input = {}) {
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
    if (inv.state === 'accepted') return recoverAcceptance(db, actor, inv, acceptor);
    throw err(409, 'INVITATION_USED', `Invitation is ${inv.state}.`);
  }
  if (inv.expiry <= nowIso()) {
    await db.prepare("UPDATE invitations SET state = 'expired', decided_at = ? WHERE id = ? AND state = 'issued'").bind(nowIso(), inv.id).run();
    throw err(410, 'INVITATION_EXPIRED', 'Invitation expired.');
  }
  // Linearization point: single conditional UPDATE (atomic on D1 + shim).
  const flip = await db.prepare("UPDATE invitations SET state = 'accepted', use_record = ?, decided_at = ? WHERE id = ? AND state = 'issued'").bind(JSON.stringify({ byNode: acceptor.id, at: nowIso() }), nowIso(), inv.id).run();
  if (!flip.meta.changes) {
    // Lost the flip race: settle by reading. A concurrent winner's
    // acceptance is completed/returned, never duplicated.
    const cur = await first(db, 'SELECT state FROM invitations WHERE id = ?', inv.id);
    if (cur && cur.state === 'accepted') return recoverAcceptance(db, actor, inv, acceptor);
    throw err(409, 'INVITATION_USED', `Invitation is ${cur ? cur.state : 'gone'}.`);
  }
  const done = await insertAcceptance(db, inv, acceptor);
  if (!done.created) return { status: 200, body: { id: done.id, state: 'active', note: 'Connection already existed for this invitation.' } };
  await auditFabric(db, actor, 'fabric.invitation.accept', inv.id, `connection ${done.id}`);
  return { status: 201, body: { id: done.id, aNode: inv.issuer_node, bNode: acceptor.id, state: 'active' } };
}

// Complete an accepted-but-connectionless invitation (crash between the
// flip and the insert), or return the existing connection. Guarded by the
// UNIQUE created_by_invitation binding: concurrent recoverers converge.
async function recoverAcceptance(db, actor, inv, acceptor) {
  const done = await insertAcceptance(db, inv, acceptor);
  if (!done.created) return { status: 200, body: { id: done.id, state: 'active', note: 'Connection already existed for this invitation.' } };
  await auditFabric(db, actor, 'fabric.invitation.accept', inv.id, `connection ${done.id} (recovered)`);
  return { status: 201, body: { id: done.id, aNode: inv.issuer_node, bNode: acceptor.id, state: 'active' } };
}

async function insertAcceptance(db, inv, acceptor) {
  const issuerRow = await first(db, 'SELECT workspace FROM fabric_nodes WHERE id = ?', inv.issuer_node);
  const now = nowIso();
  try {
    const connId = `conn_${randHex(8)}`;
    await db.prepare('INSERT INTO connections (id, a_node, b_node, a_workspace, b_workspace, state, version, created_by_invitation, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)')
      .bind(connId, inv.issuer_node, acceptor.id, issuerRow ? issuerRow.workspace : '', acceptor.workspace, 'active', inv.id, now, now).run();
    return { created: true, id: connId };
  } catch {
    const existing = await first(db, 'SELECT id FROM connections WHERE created_by_invitation = ?', inv.id);
    if (existing) return { created: false, id: existing.id };
    throw err(500, 'INTERNAL', 'Request failed.');
  }
}

export async function declineInvitation(db, actor, id) {
  needId(id, 'Invitation');
  const inv = await first(db, 'SELECT * FROM invitations WHERE id = ?', id);
  if (!inv || !(await invitationVisibleTo(db, actor, inv))) throw err(404, 'NOT_FOUND', 'Invitation not found.');
  const mine = await all(db, 'SELECT id, workspace FROM fabric_nodes WHERE owner_id = ?', actor.user.id);
  if (!mine.some((m) => m.id === inv.recipient_node && m.workspace === inv.recipient_workspace)) {
    throw err(403, 'FORBIDDEN', 'Only the recipient side can decline.');
  }
  const upd = await db.prepare("UPDATE invitations SET state = 'declined', decided_at = ? WHERE id = ? AND state = 'issued'").bind(nowIso(), id).run();
  if (!upd.meta.changes) throw err(409, 'INVITATION_USED', 'Invitation is no longer pending.');
  await auditFabric(db, actor, 'fabric.invitation.decline', id);
  return { status: 200, body: { id, state: 'declined' } };
}

export async function revokeInvitation(db, actor, id) {
  needId(id, 'Invitation');
  const inv = await first(db, 'SELECT * FROM invitations WHERE id = ?', id);
  if (!inv) throw err(404, 'NOT_FOUND', 'Invitation not found.');
  await ownNode(db, actor, inv.issuer_node);
  const upd = await db.prepare("UPDATE invitations SET state = 'revoked', decided_at = ? WHERE id = ? AND state = 'issued'").bind(nowIso(), id).run();
  if (!upd.meta.changes) throw err(409, 'INVITATION_USED', 'Invitation is no longer pending.');
  await auditFabric(db, actor, 'fabric.invitation.revoke', id);
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
  const q = ids.map(() => '?').join(',');
  const rows = await all(db, `SELECT * FROM connections WHERE a_node IN (${q}) OR b_node IN (${q}) ORDER BY created_at DESC`, ...ids, ...ids);
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

// Each side that suspends or disconnects holds an independent veto until
// it consents to resume. A peer transition (e.g. Bob disconnecting Alice's
// suspension) ADDS a veto; it never removes the other side's. Resume
// requires one node-secret proof per vetoing side, so no sequence can
// restore admission without every restricting side's authority.
function vetoSet(conn) {
  const v = parseJson(conn.vetoed_by, null);
  if (Array.isArray(v)) return [...new Set(v.filter((x) => typeof x === 'string' && x))];
  // Pre-veto rows fall back to the single recorded suspender, if any.
  return conn.suspended_by ? [conn.suspended_by] : [];
}

export async function suspendConnection(db, actor, id, input = {}) {
  needId(id, 'Connection');
  const conn = await first(db, 'SELECT * FROM connections WHERE id = ?', id);
  if (!conn) throw err(404, 'NOT_FOUND', 'Connection not found.');
  await ownConnectionSide(db, actor, conn);
  checkVersion(conn, input);
  if (conn.state !== 'active') throw err(409, 'BAD_STATE', `Connection is ${conn.state}.`);
  const side = await actingSideNode(db, actor, conn);
  const veto = [...new Set([...vetoSet(conn), side].filter(Boolean))];
  const upd = await db.prepare('UPDATE connections SET state = ?, suspended_by = ?, vetoed_by = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ? AND state = ?')
    .bind('suspended', side, JSON.stringify(veto), nowIso(), id, conn.version, 'active').run();
  if (!upd.meta.changes) return lostRace();
  await auditFabric(db, actor, 'fabric.connection.suspend', id);
  return { status: 200, body: { id, state: 'suspended' } };
}

export async function disconnectConnection(db, actor, id, input = {}) {
  needId(id, 'Connection');
  const conn = await first(db, 'SELECT * FROM connections WHERE id = ?', id);
  if (!conn) throw err(404, 'NOT_FOUND', 'Connection not found.');
  await ownConnectionSide(db, actor, conn);
  checkVersion(conn, input);
  if (conn.state === 'disconnected') throw err(409, 'BAD_STATE', 'Connection is already disconnected.');
  const side = await actingSideNode(db, actor, conn);
  const veto = [...new Set([...vetoSet(conn), side].filter(Boolean))];
  const upd = await db.prepare("UPDATE connections SET state = ?, suspended_by = ?, vetoed_by = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ? AND state != 'disconnected'")
    .bind('disconnected', side, JSON.stringify(veto), nowIso(), id, conn.version).run();
  if (!upd.meta.changes) return lostRace();
  await auditFabric(db, actor, 'fabric.connection.disconnect', id);
  return { status: 200, body: { id, state: 'disconnected' } };
}

export async function resumeConnection(db, actor, id, input = {}) {
  needId(id, 'Connection');
  const conn = await first(db, 'SELECT * FROM connections WHERE id = ?', id);
  if (!conn) throw err(404, 'NOT_FOUND', 'Connection not found.');
  await ownConnectionSide(db, actor, conn);
  checkVersion(conn, input);
  if (conn.state === 'active') throw err(409, 'BAD_STATE', 'Connection is already active.');
  if (!conn.suspended_by) throw err(409, 'BAD_STATE', 'This connection predates consent tracking; re-invite to reconnect.');
  const veto = vetoSet(conn);
  if (!veto.length) throw err(409, 'BAD_STATE', 'This connection has no recorded consent; re-invite to reconnect.');
  // Bearer proofs: one node secret per vetoing side, delivered out of band
  // like invitation tokens. The resumer must own a side (checked above);
  // each vetoing side consents by its secret, regardless of who holds it.
  const presented = [input.nodeKey, ...(Array.isArray(input.nodeKeys) ? input.nodeKeys : [])].filter((s) => typeof s === 'string' && s);
  for (const nodeId of veto) {
    const n = await first(db, 'SELECT node_secret_verifier, node_secret_salt FROM fabric_nodes WHERE id = ?', nodeId);
    let proven = false;
    for (const s of presented) {
      if (n && await verifyToken(s, { verifier: n.node_secret_verifier, salt: n.node_secret_salt })) { proven = true; break; }
    }
    if (!proven) throw err(403, 'FORBIDDEN', 'Resume requires every vetoing side\u2019s node secret.');
  }
  const upd = await db.prepare("UPDATE connections SET state = ?, suspended_by = NULL, vetoed_by = NULL, version = version + 1, updated_at = ? WHERE id = ? AND version = ? AND state != 'active'")
    .bind('active', nowIso(), id, conn.version).run();
  if (!upd.meta.changes) return lostRace();
  await auditFabric(db, actor, 'fabric.connection.resume', id);
  return { status: 200, body: { id, state: 'active' } };
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
  try {
    await db.prepare('INSERT INTO grant_previews (id, connection_id, canonical_json, digest, revision_vector, expiry, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, conn.id, canonicalize(preview), digest, JSON.stringify(revisionVector), new Date(Date.now() + PREVIEW_TTL_MS).toISOString(), actor.user.id, now).run();
  } catch {
    // Same operation id already exists: converge on the committed preview
    // (fully reconstructible from the row — no secrets involved).
    const existing = await first(db, 'SELECT * FROM grant_previews WHERE id = ?', id);
    if (existing && existing.created_by === actor.user.id) {
      const terms = parseJson(existing.canonical_json, {});
      return { status: 200, body: { id: existing.id, digest: existing.digest, preview: terms, revisionVector: parseJson(existing.revision_vector, {}), confirmation: buildConfirmation(terms), reconciled: true } };
    }
    throw err(500, 'INTERNAL', 'Request failed.');
  }
  await auditFabric(db, actor, 'fabric.preview.create', id, `${snapshot.length} resources`);
  return { status: 201, body: { id, digest, preview, revisionVector, confirmation: buildConfirmation(preview) } };
}

// ---- approvals ----
const APPROVAL_TTL_MS = 10 * 60e3;
export async function requestApproval(db, actor, input = {}, op = null) {
  if (!canPropose(actor)) throw err(403, 'FORBIDDEN', 'This credential cannot request approvals.');
  const action = input.action === 'grant.resume' ? 'grant.resume' : 'grant.commit';
  let preview = null;
  let revisionVector = {};
  if (action === 'grant.commit') {
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
    revisionVector = parseJson(preview.revision_vector, {});
  } else {
    if (typeof input.targetId !== 'string' || !input.targetId) throw err(404, 'NOT_FOUND', 'Grant not found.');
    const grant = await first(db, 'SELECT * FROM fabric_grants WHERE id = ?', input.targetId);
    if (!grant || !(await actorExportsGrant(db, actor, grant))) throw err(404, 'NOT_FOUND', 'Grant not found.');
    revisionVector = { grant: grant.version };
  }
  const id = await opEntityId(actor, op, 'appr');
  const now = nowIso();
  const expiresAt = new Date(Date.now() + APPROVAL_TTL_MS).toISOString();
  try {
    await db.prepare('INSERT INTO approvals (id, action, target_id, preview_id, preview_digest, revision_vector, approver, interaction_ref, decision, expiry, consumed_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL, ?, ?)')
      .bind(id, action, input.targetId || null, preview ? preview.id : null, preview ? preview.digest : null, JSON.stringify(revisionVector), 'requested', expiresAt, actor.user.id, now).run();
  } catch {
    // Same operation id already exists: converge on the committed
    // approval (fully reconstructible — no secrets involved).
    const existing = await first(db, 'SELECT * FROM approvals WHERE id = ?', id);
    if (existing && existing.created_by === actor.user.id) {
      return { status: 200, body: { id: existing.id, action: existing.action, previewId: existing.preview_id, previewDigest: existing.preview_digest, revisionVector: parseJson(existing.revision_vector, {}), expiresAt: existing.expiry, reconciled: true } };
    }
    throw err(500, 'INTERNAL', 'Request failed.');
  }
  await auditFabric(db, actor, 'fabric.approval.request', id, action);
  return { status: 201, body: { id, action, previewId: preview ? preview.id : null, previewDigest: preview ? preview.digest : null, revisionVector, expiresAt } };
}

export async function decideApproval(db, actor, id, input = {}) {
  if (!isHuman(actor)) needHuman();
  needId(id, 'Approval');
  const appr = await first(db, 'SELECT * FROM approvals WHERE id = ?', id);
  if (!appr) throw err(404, 'NOT_FOUND', 'Approval not found.');
  if (appr.decision !== 'requested') throw err(409, 'ALREADY_DECIDED', `Approval is ${appr.decision}.`);
  if (appr.expiry <= nowIso()) {
    await db.prepare("UPDATE approvals SET decision = 'expired' WHERE id = ? AND decision = 'requested'").bind(id).run();
    throw err(410, 'APPROVAL_EXPIRED', 'Approval expired.');
  }
  // The decider must own the exporting side (or the grant being resumed).
  let exporterOk = false;
  if (appr.action === 'grant.commit' && appr.preview_id) {
    const preview = await first(db, 'SELECT * FROM grant_previews WHERE id = ?', appr.preview_id);
    const conn = preview ? await first(db, 'SELECT * FROM connections WHERE id = ?', preview.connection_id) : null;
    if (preview && conn) {
      const terms = parseJson(preview.canonical_json, {});
      const node = await first(db, 'SELECT owner_id FROM fabric_nodes WHERE id = ?', terms.exporterNode);
      exporterOk = !!(node && node.owner_id === actor.user.id);
    }
  } else if (appr.action === 'grant.resume' && appr.target_id) {
    const grant = await first(db, 'SELECT snapshot FROM fabric_grants WHERE id = ?', appr.target_id);
    exporterOk = !!(grant && await actorExportsGrant(db, actor, grant));
  }
  if (!exporterOk) throw err(403, 'FORBIDDEN', 'Only the exporting owner can decide.');
  const decision = input.decision === 'approve' ? 'approved' : input.decision === 'reject' ? 'rejected' : null;
  if (!decision) throw err(400, 'BAD_DECISION', "Decision must be 'approve' or 'reject'.");
  const now = nowIso();
  const upd = await db.prepare('UPDATE approvals SET decision = ?, approver = ?, interaction_ref = ? WHERE id = ? AND decision = ?')
    .bind(decision, actor.user.id, `session:${actor.user.id}:${now}`, id, 'requested').run();
  if (!upd.meta.changes) throw err(409, 'ALREADY_DECIDED', 'Approval was already decided.');
  await auditFabric(db, actor, `fabric.approval.${decision}`, id);
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

export async function commitGrant(db, actor, input = {}) {
  if (!isHuman(actor)) needHuman();
  if (typeof input.approvalId !== 'string' || !input.approvalId) throw err(409, 'NOT_APPROVED', 'An approved approval is required.');
  const appr = await first(db, 'SELECT * FROM approvals WHERE id = ?', input.approvalId);
  if (!appr || appr.action !== 'grant.commit') throw err(404, 'NOT_FOUND', 'Approval not found.');
  if (appr.decision !== 'approved') throw err(409, 'NOT_APPROVED', `Approval is ${appr.decision}.`);
  if (appr.expiry <= nowIso()) throw err(410, 'APPROVAL_EXPIRED', 'Approval expired.');
  if (appr.consumed_at) {
    const existing = await first(db, 'SELECT id FROM fabric_grants WHERE approval_id = ?', appr.id);
    if (existing) return { status: 200, body: { id: existing.id, note: 'Approval was already consumed for this grant.' } };
    throw err(409, 'APPROVAL_CONSUMED', 'Approval was already consumed.');
  }
  const preview = await first(db, 'SELECT * FROM grant_previews WHERE id = ?', appr.preview_id);
  if (!preview) throw err(409, 'PREVIEW_STALE', 'Preview is gone.');
  if (input.previewHash !== appr.preview_digest || appr.preview_digest !== preview.digest) {
    throw err(412, 'PREVIEW_STALE', 'Preview hash mismatch; regenerate the preview.');
  }
  if ((await digestJson(parseJson(preview.canonical_json, null))) !== preview.digest) {
    throw err(500, 'INTERNAL', 'Preview integrity failure.');
  }
  const conn = await first(db, 'SELECT * FROM connections WHERE id = ?', preview.connection_id);
  if (!conn || conn.state !== 'active') throw err(409, 'CONNECTION_DOWN', 'Connection is not active.');
  const vector = parseJson(appr.revision_vector, {});
  if (vector.connection !== conn.version) throw err(412, 'PREVIEW_STALE', 'Connection changed since the preview; regenerate it.');
  const terms = parseJson(preview.canonical_json, {});
  // Revalidate every snapshot entry against live state (no TOCTOU).
  for (const s of terms.snapshot || []) {
    const r = await first(db, 'SELECT owner_id, incarnation, imported_from FROM resources WHERE id = ?', s.resourceId);
    if (!r || r.owner_id !== actor.user.id || r.imported_from || r.incarnation !== s.incarnation) {
      throw err(412, 'PREVIEW_STALE', `Resource ${s.resourceId} changed since the preview.`);
    }
  }
  const id = `fg_${randHex(8)}`;
  const now = nowIso();
  try {
    await db.prepare('INSERT INTO fabric_grants (id, connection_id, recipient_node, recipient_workspace, consumers, snapshot, actions, models, ceilings, route, retention, expiry, status, version, preview_hash, approval_id, exporter_id, last_approval_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)')
      .bind(id, conn.id, terms.importerNode, terms.importerWorkspace, JSON.stringify(terms.consumers), JSON.stringify(terms.snapshot), JSON.stringify(terms.actions), JSON.stringify(modelsOf(terms)), JSON.stringify(terms.ceilings), terms.route, terms.retention, terms.expiry, 'enforced', preview.digest, appr.id, actor.user.id, appr.id, now, now).run();
  } catch {
    const existing = await first(db, 'SELECT id FROM fabric_grants WHERE approval_id = ?', appr.id);
    if (existing) return { status: 200, body: { id: existing.id, note: 'Approval was already consumed for this grant.' } };
    throw err(500, 'INTERNAL', 'Request failed.');
  }
  await db.prepare('UPDATE approvals SET consumed_at = ? WHERE id = ?').bind(nowIso(), appr.id).run();
  await auditFabric(db, actor, 'fabric.grant.commit', id, `${terms.snapshot.length} resources`);
  return { status: 201, body: { id, status: 'enforced', version: 1 } };
}

function modelsOf(terms) {
  const set = new Set();
  for (const s of terms.snapshot || []) for (const m of s.models || []) set.add(m);
  return [...set];
}

export async function reviseGrant(db, actor, id, input = {}) {
  if (!isHuman(actor)) needHuman();
  needId(id, 'Grant');
  const grant = await first(db, 'SELECT * FROM fabric_grants WHERE id = ?', id);
  if (!grant || !(await grantVisibleTo(db, actor, grant))) throw err(404, 'NOT_FOUND', 'Grant not found.');
  if (grant.status === 'revoked') throw err(409, 'BAD_STATE', 'Revoked grants cannot be revised.');
  if (!await actorExportsGrant(db, actor, grant)) throw err(403, 'FORBIDDEN', 'Only the exporting owner can revise.');
  // No client expectedVersion: staleness is detected from the approval's
  // own revision vector, and the conditional update below linearizes
  // against concurrent writers on the version read here.
  if (typeof input.approvalId !== 'string' || !input.approvalId) throw err(409, 'NOT_APPROVED', 'A fresh approved, unconsumed approval is required.');
  const appr = await first(db, 'SELECT * FROM approvals WHERE id = ?', input.approvalId);
  if (!appr || appr.action !== 'grant.commit' || appr.decision !== 'approved') {
    throw err(409, 'NOT_APPROVED', 'A fresh approved, unconsumed approval is required.');
  }
  if (appr.consumed_at) {
    // Reconcile, don't duplicate: if this approval already revised this
    // grant (5xx after the write), report the current terms instead of
    // failing. A foreign consumption stays a conflict.
    if (grant.last_approval_id === appr.id) {
      return { status: 200, body: { id, version: grant.version, note: 'This approval was already applied to this grant.' } };
    }
    throw err(409, 'NOT_APPROVED', 'A fresh approved, unconsumed approval is required.');
  }
  if (appr.expiry <= nowIso()) throw err(410, 'APPROVAL_EXPIRED', 'Approval expired.');
  // The approval must be the acting exporter's own end-to-end decision:
  // requested by them, decided by them, for this exact recipient.
  if (appr.created_by !== actor.user.id || appr.approver !== actor.user.id) {
    throw err(403, 'FORBIDDEN', 'This approval belongs to a different owner.');
  }
  // Freshness gate (Lamport clock on approval insertion order): an approval
  // reviewed the grant as of some earlier revision. Once this grant has
  // moved on under a newer approval, older approvals go stale instead of
  // silently reverting narrowing changes. Grants that predate tracking
  // accept one binding revision, then join the clock.
  if (grant.last_approval_id) {
    const newer = await first(db, 'SELECT id FROM approvals WHERE id = ? AND rowid > (SELECT rowid FROM approvals WHERE id = ?)', appr.id, grant.last_approval_id);
    if (!newer) throw err(412, 'PREVIEW_STALE', 'Approval predates the latest grant change; re-approve the current terms.');
  }
  const preview = await first(db, 'SELECT * FROM grant_previews WHERE id = ?', appr.preview_id);
  if (!preview || appr.preview_digest !== preview.digest || input.previewHash !== preview.digest) {
    throw err(412, 'PREVIEW_STALE', 'Preview mismatch; regenerate it.');
  }
  if ((await digestJson(parseJson(preview.canonical_json, null))) !== preview.digest) {
    throw err(500, 'INTERNAL', 'Preview integrity failure.');
  }
  const terms = parseJson(preview.canonical_json, {});
  // Bind the revision to the target grant: same connection, same recipient
  // node and workspace. A preview approved for another relationship —
  // even between the same owners — cannot rewrite this grant.
  if (terms.connectionId !== grant.connection_id || terms.importerNode !== grant.recipient_node || terms.importerWorkspace !== grant.recipient_workspace) {
    throw err(422, 'PREVIEW_MISMATCH', 'This preview names a different connection or recipient.');
  }
  const conn = await first(db, 'SELECT * FROM connections WHERE id = ?', grant.connection_id);
  if (!conn || conn.state !== 'active') throw err(409, 'CONNECTION_DOWN', 'Connection is not active.');
  const vector = parseJson(appr.revision_vector, {});
  if (vector.connection !== conn.version) throw err(412, 'PREVIEW_STALE', 'Connection changed since the preview; regenerate it.');
  // Revalidate every new snapshot entry against live state (no TOCTOU):
  // owner-controlled by the actor, still present, incarnation unchanged.
  for (const s of terms.snapshot || []) {
    const r = await first(db, 'SELECT owner_id, incarnation, imported_from FROM resources WHERE id = ?', s.resourceId);
    if (!r || r.owner_id !== actor.user.id || r.imported_from || r.incarnation !== s.incarnation) {
      throw err(412, 'PREVIEW_STALE', `Resource ${s.resourceId} changed since the preview.`);
    }
  }
  const now = nowIso();
  // Claim-first, then mutate: the approval is consumed by conditional
  // update before the grant changes, so one approval can never revise two
  // targets concurrently — exactly one claim wins and losers change
  // nothing. (If the grant write then loses a race, the approval is spent
  // and the caller re-approves: fail-closed, never double-applied.)
  const claim = await db.prepare("UPDATE approvals SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL AND decision = 'approved'")
    .bind(now, appr.id).run();
  if (!claim.meta.changes) return { status: 409, body: { error: 'Approval was already consumed.', code: 'APPROVAL_CONSUMED' } };
  // Linearization point: conditional update on id + version + live status.
  // A concurrent pause/revoke/earlier revise wins instead of being lost.
  const upd = await db.prepare("UPDATE fabric_grants SET consumers = ?, snapshot = ?, models = ?, ceilings = ?, expiry = ?, version = version + 1, preview_hash = ?, last_approval_id = ?, updated_at = ? WHERE id = ? AND version = ? AND status != 'revoked'")
    .bind(JSON.stringify(terms.consumers), JSON.stringify(terms.snapshot), JSON.stringify(modelsOf(terms)), JSON.stringify(terms.ceilings), terms.expiry, preview.digest, appr.id, now, id, grant.version).run();
  if (!upd.meta.changes) return lostRace();
  await db.prepare('INSERT INTO fabric_grant_revisions (id, grant_id, version, terms_json, approval_id, superseded_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(`fgr_${randHex(8)}`, id, grant.version, JSON.stringify({ consumers: parseJson(grant.consumers, []), snapshot: parseJson(grant.snapshot, []), ceilings: parseJson(grant.ceilings, {}) }), appr.id, now).run();
  await auditFabric(db, actor, 'fabric.grant.revise', id, `v${grant.version + 1}`);
  return { status: 200, body: { id, version: grant.version + 1 } };
}

export async function pauseGrant(db, actor, id, input = {}) {
  if (!canNarrow(actor, 'fabric.pause')) throw err(403, 'FORBIDDEN', 'This credential cannot pause grants.');
  needId(id, 'Grant');
  const grant = await first(db, 'SELECT * FROM fabric_grants WHERE id = ?', id);
  if (!grant || !(await grantVisibleTo(db, actor, grant))) throw err(404, 'NOT_FOUND', 'Grant not found.');
  if (!await actorExportsGrant(db, actor, grant)) throw err(403, 'FORBIDDEN', 'Only the exporting owner can pause.');
  checkVersion(grant, input);
  if (grant.status !== 'enforced') throw err(409, 'BAD_STATE', `Grant is ${grant.status}.`);
  const pupd = await db.prepare('UPDATE fabric_grants SET status = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ? AND status = ?')
    .bind('paused', nowIso(), id, grant.version, 'enforced').run();
  if (!pupd.meta.changes) return lostRace();
  await auditFabric(db, actor, 'fabric.grant.pause', id);
  return { status: 200, body: { id, status: 'paused' } };
}

export async function resumeGrant(db, actor, id, input = {}) {
  if (!isHuman(actor)) needHuman();
  needId(id, 'Grant');
  const grant = await first(db, 'SELECT * FROM fabric_grants WHERE id = ?', id);
  if (!grant || !(await grantVisibleTo(db, actor, grant))) throw err(404, 'NOT_FOUND', 'Grant not found.');
  const conn = await first(db, 'SELECT * FROM connections WHERE id = ?', grant.connection_id);
  if (!conn || conn.state !== 'active') throw err(409, 'CONNECTION_DOWN', 'Connection is not active.');
  if (!await actorExportsGrant(db, actor, grant)) throw err(403, 'FORBIDDEN', 'Only the exporting owner can resume.');
  checkVersion(grant, input);
  if (grant.status !== 'paused') throw err(409, 'BAD_STATE', `Grant is ${grant.status}.`);
  if (typeof input.approvalId !== 'string' || !input.approvalId) throw err(409, 'NOT_APPROVED', 'A fresh approved resume approval is required.');
  const appr = await first(db, 'SELECT * FROM approvals WHERE id = ?', input.approvalId);
  if (!appr || appr.action !== 'grant.resume' || appr.target_id !== id || appr.decision !== 'approved' || appr.consumed_at) {
    throw err(409, 'NOT_APPROVED', 'A fresh approved resume approval is required.');
  }
  if (appr.expiry <= nowIso()) throw err(410, 'APPROVAL_EXPIRED', 'Approval expired.');
  const vector = parseJson(appr.revision_vector, {});
  if (vector.grant !== grant.version) throw err(412, 'PREVIEW_STALE', 'Grant changed since the approval.');
  // Linearization point: resume lands only on the exact paused revision it
  // was approved for. A concurrent revoke (or any other transition) wins;
  // revoke finality holds because no path moves a grant out of 'revoked'.
  const rupd = await db.prepare('UPDATE fabric_grants SET status = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ? AND status = ?')
    .bind('enforced', nowIso(), id, grant.version, 'paused').run();
  if (!rupd.meta.changes) {
    const cur = await first(db, 'SELECT status FROM fabric_grants WHERE id = ?', id);
    if (cur && cur.status === 'revoked') return { status: 409, body: { error: 'Grant is revoked.', code: 'BAD_STATE' } };
    return lostRace();
  }
  await db.prepare('UPDATE approvals SET consumed_at = ? WHERE id = ?').bind(nowIso(), appr.id).run();
  await auditFabric(db, actor, 'fabric.grant.resume', id);
  return { status: 200, body: { id, status: 'enforced' } };
}

export async function revokeGrant(db, actor, id, input = {}) {
  if (!canNarrow(actor, 'fabric.revoke')) throw err(403, 'FORBIDDEN', 'This credential cannot revoke grants.');
  needId(id, 'Grant');
  const grant = await first(db, 'SELECT * FROM fabric_grants WHERE id = ?', id);
  if (!grant || !(await grantVisibleTo(db, actor, grant))) throw err(404, 'NOT_FOUND', 'Grant not found.');
  if (!await actorExportsGrant(db, actor, grant)) throw err(403, 'FORBIDDEN', 'Only the exporting owner can revoke.');
  checkVersion(grant, input);
  if (grant.status === 'revoked') return { status: 200, body: { id, status: 'revoked', note: 'Already revoked.' } };
  const vupd = await db.prepare("UPDATE fabric_grants SET status = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ? AND status != 'revoked'")
    .bind('revoked', nowIso(), id, grant.version).run();
  if (!vupd.meta.changes) {
    const cur = await first(db, 'SELECT status FROM fabric_grants WHERE id = ?', id);
    if (cur && cur.status === 'revoked') return { status: 200, body: { id, status: 'revoked', note: 'Already revoked.' } };
    return lostRace();
  }
  await auditFabric(db, actor, 'fabric.grant.revoke', id);
  return { status: 200, body: { id, status: 'revoked' } };
}

async function actorExportsGrant(db, actor, grant) {
  // The exporter is the recorded issuing authority — not merely a
  // connection side, and not whoever happens to own the resource today.
  // Importers can read the grant but never mutate it. Rows that predate
  // exporter binding fall back to live ownership (documented upgrade
  // behavior; migration 0007 backfills intact rows).
  if (grant.exporter_id) return grant.exporter_id === actor.user.id;
  const snap = parseJson(grant.snapshot, []);
  if (!snap.length) return false;
  for (const s of snap) {
    const r = await first(db, 'SELECT owner_id FROM resources WHERE id = ?', s.resourceId);
    if (!r || r.owner_id !== actor.user.id) return false;
  }
  return true;
}

export async function listGrants(db, actor, scope = 'all') {
  const mine = (await all(db, 'SELECT id FROM fabric_nodes WHERE owner_id = ?', actor.user.id)).map((n) => n.id);
  if (!mine.length) return { status: 200, body: { items: [], total: 0 } };
  const q = mine.map(() => '?').join(',');
  let rows = [];
  if (scope === 'outgoing' || scope === 'all') {
    rows = rows.concat(await all(db, `SELECT g.* FROM fabric_grants g JOIN connections c ON c.id = g.connection_id WHERE c.a_node IN (${q}) OR c.b_node IN (${q}) ORDER BY g.created_at DESC`, ...mine, ...mine));
  }
  if (scope === 'incoming' || scope === 'all') {
    rows = rows.concat(await all(db, `SELECT * FROM fabric_grants WHERE recipient_node IN (${q}) ORDER BY created_at DESC`, ...mine));
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
  try {
    await db.prepare('INSERT INTO fabric_denies (id, owner_id, principal, resource_id, action, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(id, actor.user.id, input.principal ? String(input.principal).slice(0, 128) : null, resourceId, input.action ? String(input.action).slice(0, 32) : null, nowIso()).run();
  } catch {
    // Same operation id already exists: converge on the committed deny.
    const existing = await first(db, 'SELECT id, owner_id FROM fabric_denies WHERE id = ?', id);
    if (existing && existing.owner_id === actor.user.id) return { status: 200, body: { id, reconciled: true } };
    throw err(500, 'INTERNAL', 'Request failed.');
  }
  await auditFabric(db, actor, 'fabric.deny.create', id);
  return { status: 201, body: { id } };
}

export async function listDenies(db, actor) {
  const rows = await all(db, 'SELECT * FROM fabric_denies WHERE owner_id = ? ORDER BY created_at DESC', actor.user.id);
  return { status: 200, body: { items: rows, total: rows.length } };
}

export async function deleteDeny(db, actor, id) {
  needId(id, 'Deny');
  const row = await first(db, 'SELECT * FROM fabric_denies WHERE id = ?', id);
  if (!row || row.owner_id !== actor.user.id) throw err(404, 'NOT_FOUND', 'Deny not found.');
  await db.prepare('DELETE FROM fabric_denies WHERE id = ?').bind(id).run();
  await auditFabric(db, actor, 'fabric.deny.delete', id);
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
      if (g.exporter_id && live.owner_id !== g.exporter_id) continue;
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
    const q = ids.map(() => '?').join(',');
    const grants = await all(db, `SELECT g.consumers, g.snapshot FROM fabric_grants g JOIN connections c ON c.id = g.connection_id
      WHERE g.recipient_node IN (${q}) AND g.status = 'enforced' AND c.state = 'active' AND g.expiry > ?`, ...ids, nowIso());
    const seen = new Set(items.map((i) => i.id));
    for (const g of grants) {
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
const IDEM_TTL_MS = 10 * 60e3;
export async function checkIdempotency(db, actor, method, path, key, bodyHash) {
  if (!key || typeof key !== 'string' || key.length > 128) throw err(400, 'IDEMPOTENCY_REQUIRED', 'Idempotency-Key header is required for this mutation.');
  const actorKey = `${actor.kind}:${actor.user.id}`;
  const existing = await first(db, 'SELECT * FROM idempotency_records WHERE idem_key = ? AND actor = ?', key, actorKey);
  if (!existing) {
    try {
      await db.prepare('INSERT INTO idempotency_records (idem_key, actor, method, path, request_hash, status, response_code, response_body, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)')
        .bind(key, actorKey, method, path, bodyHash, 'processing', nowIso()).run();
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
  // Read-path redaction backstops the write path and migration 0007:
  // even a pre-repair persisted secret is stripped before replay.
  if (rec.status === 'completed') return { status: rec.response_code, body: redactForReplay(parseJson(rec.response_body, {})), replayed: true };
  // A 'processing' record older than the lease is a crashed attempt, not an
  // in-flight one: steal it (conditional on the exact observed row, so only
  // one stealer proceeds) instead of wedging the key forever.
  const age = Date.now() - Date.parse(rec.created_at);
  if (Number.isFinite(age) && age > IDEM_TTL_MS) {
    const steal = await db.prepare('UPDATE idempotency_records SET created_at = ? WHERE idem_key = ? AND actor = ? AND status = ? AND created_at = ?')
      .bind(nowIso(), keyOf(rec), actorKey, 'processing', rec.created_at).run();
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

// One-time secret fields are never persisted for replay: the metadata
// (ids, digests, errors) replays exactly, but credential material is
// shown once on the live response only. A retried issuance therefore
// returns the recorded metadata without re-issuing and without retaining
// the secret — safe retry semantics with verifier-only custody.
const REPLAY_REDACTED = new Set(['nodeSecret', 'token', 'secret']);
function redactForReplay(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  let redacted = false;
  const out = { ...body };
  for (const k of Object.keys(out)) {
    if (REPLAY_REDACTED.has(k)) { delete out[k]; redacted = true; }
  }
  if (redacted) out.replayNote = 'Secret fields are shown once and are not stored for replay.';
  return out;
}

export async function storeIdempotency(db, actor, key, status, body) {
  const actorKey = `${actor.kind}:${actor.user.id}`;
  // Replays return the recorded response (4xx terminal failures included),
  // minus one-time secret fields. Bodies derive from 64 KiB-capped
  // requests, so TEXT stays bounded.
  await db.prepare('UPDATE idempotency_records SET status = ?, response_code = ?, response_body = ? WHERE idem_key = ? AND actor = ?')
    .bind('completed', status, JSON.stringify(redactForReplay(body)), key, actorKey).run();
}

// Unknown (5xx) outcomes are NOT recorded as terminal: the processing
// record is released so the same key retries fresh, and per-operation
// recovery (invitation redemption, conditional writes) converges without
// duplicating side effects.
export async function releaseIdempotency(db, actor, key) {
  const actorKey = `${actor.kind}:${actor.user.id}`;
  await db.prepare('DELETE FROM idempotency_records WHERE idem_key = ? AND actor = ? AND status = ?').bind(key, actorKey, 'processing').run();
}
