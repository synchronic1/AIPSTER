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
export async function registerNode(db, actor, input = {}) {
  if (isAgentKey(actor)) throw err(403, 'FORBIDDEN', 'Agent credentials cannot register nodes.');
  const label = typeof input.label === 'string' ? input.label.trim().slice(0, 80) : '';
  if (!label) throw err(400, 'BAD_LABEL', 'Node label is required.');
  const workspace = typeof input.workspace === 'string' && input.workspace.trim() ? input.workspace.trim().slice(0, 64) : 'default';
  const tok = mintToken('ndkey');
  const now = nowIso();
  const nodeId = `node_${randHex(8)}`;
  const fingerprint = (await digestJson(`node:${nodeId}`)).slice(0, 16);
  await db.prepare('INSERT INTO fabric_nodes (id, owner_id, workspace, label, fingerprint, protocol, transport, issuer, status, node_secret_verifier, node_secret_salt, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)')
    .bind(nodeId, actor.user.id, workspace, label, fingerprint, 'fixture-0', 'fixture', 'fixture-local', 'registered', await verifierFor(tok.secret, tok.salt), tok.salt, now, now).run();
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
export async function createInvitation(db, actor, input = {}) {
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
  const tok = mintToken('inv');
  const now = nowIso();
  await db.prepare('INSERT INTO invitations (id, issuer_node, recipient_node, recipient_workspace, purpose, token_verifier, token_salt, state, expiry, use_record, created_by, created_at, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL)')
    .bind(tok.id, issuer.id, recipientNode, recipientWorkspace, purpose, await verifierFor(tok.secret, tok.salt), tok.salt, 'issued', new Date(Date.now() + hours * 3600e3).toISOString(), actor.user.id, now).run();
  await auditFabric(db, actor, 'fabric.invitation.create', tok.id, `${issuer.id} -> ${recipientNode}`);
  return { status: 201, body: { id: tok.id, issuerNode: issuer.id, recipientNode, recipientWorkspace, purpose, expiry: new Date(Date.now() + hours * 3600e3).toISOString(), token: tok.secret, oneTime: 'This invitation token is shown once. Deliver it to the recipient out of band.' } };
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
  if (inv.state !== 'issued') throw err(409, 'INVITATION_USED', `Invitation is ${inv.state}.`);
  if (inv.expiry <= nowIso()) {
    await db.prepare("UPDATE invitations SET state = 'expired', decided_at = ? WHERE id = ? AND state = 'issued'").bind(nowIso(), inv.id).run();
    throw err(410, 'INVITATION_EXPIRED', 'Invitation expired.');
  }
  // Linearization point: single conditional UPDATE (atomic on D1 + shim).
  const flip = await db.prepare("UPDATE invitations SET state = 'accepted', use_record = ?, decided_at = ? WHERE id = ? AND state = 'issued'").bind(JSON.stringify({ byNode: acceptor.id, at: nowIso() }), nowIso(), inv.id).run();
  if (!flip.meta.changes) {
    const cur = await first(db, 'SELECT state FROM invitations WHERE id = ?', inv.id);
    throw err(409, 'INVITATION_USED', `Invitation is ${cur ? cur.state : 'gone'}.`);
  }
  const connId = `conn_${randHex(8)}`;
  const now = nowIso();
  const issuerRow = await first(db, 'SELECT workspace FROM fabric_nodes WHERE id = ?', inv.issuer_node);
  try {
    await db.prepare('INSERT INTO connections (id, a_node, b_node, a_workspace, b_workspace, state, version, created_by_invitation, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)')
      .bind(connId, inv.issuer_node, acceptor.id, issuerRow ? issuerRow.workspace : '', acceptor.workspace, 'active', inv.id, now, now).run();
  } catch {
    // Backstop only: the conditional UPDATE above already serializes winners.
    // Reconcile by the UNIQUE invitation binding instead of failing blindly.
    const existing = await first(db, 'SELECT id FROM connections WHERE created_by_invitation = ?', inv.id);
    if (existing) return { status: 200, body: { id: existing.id, state: 'active', note: 'Connection already existed for this invitation.' } };
    throw err(500, 'INTERNAL', 'Request failed.');
  }
  await auditFabric(db, actor, 'fabric.invitation.accept', inv.id, `connection ${connId}`);
  return { status: 201, body: { id: connId, aNode: inv.issuer_node, bNode: acceptor.id, state: 'active' } };
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

export async function suspendConnection(db, actor, id, input = {}) {
  needId(id, 'Connection');
  const conn = await first(db, 'SELECT * FROM connections WHERE id = ?', id);
  if (!conn) throw err(404, 'NOT_FOUND', 'Connection not found.');
  await ownConnectionSide(db, actor, conn);
  checkVersion(conn, input);
  if (conn.state !== 'active') throw err(409, 'BAD_STATE', `Connection is ${conn.state}.`);
  await db.prepare('UPDATE connections SET state = ?, version = version + 1, updated_at = ? WHERE id = ?').bind('suspended', nowIso(), id).run();
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
  await db.prepare('UPDATE connections SET state = ?, version = version + 1, updated_at = ? WHERE id = ?').bind('disconnected', nowIso(), id).run();
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
  // Resume demands the original identity binding (a side's node secret) on
  // top of owner authority. Approval-object flow is reserved for grants.
  const sides = [conn.a_node, conn.b_node];
  let proven = false;
  for (const side of sides) {
    const node = await first(db, 'SELECT * FROM fabric_nodes WHERE id = ?', side);
    if (node && node.owner_id === actor.user.id && await verifyToken(input.nodeKey, { verifier: node.node_secret_verifier, salt: node.node_secret_salt })) {
      proven = true;
      break;
    }
  }
  if (!proven) throw err(403, 'BAD_NODE_KEY', 'Resume requires a side node secret.');
  await db.prepare('UPDATE connections SET state = ?, version = version + 1, updated_at = ? WHERE id = ?').bind('active', nowIso(), id).run();
  await auditFabric(db, actor, 'fabric.connection.resume', id);
  return { status: 200, body: { id, state: 'active' } };
}

// ---- previews ----
const PREVIEW_TTL_MS = 30 * 60e3;
export async function createPreview(db, actor, input = {}) {
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
  const id = `prev_${randHex(8)}`;
  await db.prepare('INSERT INTO grant_previews (id, connection_id, canonical_json, digest, revision_vector, expiry, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, conn.id, canonicalize(preview), digest, JSON.stringify(revisionVector), new Date(Date.now() + PREVIEW_TTL_MS).toISOString(), actor.user.id, now).run();
  await auditFabric(db, actor, 'fabric.preview.create', id, `${snapshot.length} resources`);
  const confirmation = `Share ${snapshot.length} resource(s) with ${importerNode} for ${consumers.length} consumer(s), models ${models.join(', ')}, up to ${ceilings.maxTokens} tokens / ${ceilings.maxRequests} requests, until ${preview.expiry}. ${exclusions.length} owned resource(s) excluded. Connection only carries inference; nothing else is shared.`;
  return { status: 201, body: { id, digest, preview, revisionVector, confirmation } };
}

// ---- approvals ----
const APPROVAL_TTL_MS = 10 * 60e3;
export async function requestApproval(db, actor, input = {}) {
  if (!canPropose(actor)) throw err(403, 'FORBIDDEN', 'This credential cannot request approvals.');
  const action = input.action === 'grant.resume' ? 'grant.resume' : 'grant.commit';
  let preview = null;
  let revisionVector = {};
  if (action === 'grant.commit') {
    if (typeof input.previewId !== 'string' || !input.previewId) throw err(404, 'NOT_FOUND', 'Preview not found.');
    preview = await first(db, 'SELECT * FROM grant_previews WHERE id = ?', input.previewId);
    if (!preview) throw err(404, 'NOT_FOUND', 'Preview not found.');
    if (preview.expiry <= nowIso()) throw err(410, 'PREVIEW_STALE', 'Preview expired; regenerate it.');
    const conn = await first(db, 'SELECT * FROM connections WHERE id = ?', preview.connection_id);
    if (!conn || conn.state === 'disconnected') throw err(409, 'CONNECTION_DOWN', 'Connection is gone.');
    revisionVector = parseJson(preview.revision_vector, {});
  } else {
    if (typeof input.targetId !== 'string' || !input.targetId) throw err(404, 'NOT_FOUND', 'Grant not found.');
    const grant = await first(db, 'SELECT * FROM fabric_grants WHERE id = ?', input.targetId);
    if (!grant) throw err(404, 'NOT_FOUND', 'Grant not found.');
    revisionVector = { grant: grant.version };
  }
  const id = `appr_${randHex(8)}`;
  const now = nowIso();
  await db.prepare('INSERT INTO approvals (id, action, target_id, preview_id, preview_digest, revision_vector, approver, interaction_ref, decision, expiry, consumed_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL, ?, ?)')
    .bind(id, action, input.targetId || null, preview ? preview.id : null, preview ? preview.digest : null, JSON.stringify(revisionVector), 'requested', new Date(Date.now() + APPROVAL_TTL_MS).toISOString(), actor.user.id, now).run();
  await auditFabric(db, actor, 'fabric.approval.request', id, action);
  return { status: 201, body: { id, action, previewId: preview ? preview.id : null, previewDigest: preview ? preview.digest : null, revisionVector, expiresAt: new Date(Date.now() + APPROVAL_TTL_MS).toISOString() } };
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
    await db.prepare('INSERT INTO fabric_grants (id, connection_id, recipient_node, recipient_workspace, consumers, snapshot, actions, models, ceilings, route, retention, expiry, status, version, preview_hash, approval_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)')
      .bind(id, conn.id, terms.importerNode, terms.importerWorkspace, JSON.stringify(terms.consumers), JSON.stringify(terms.snapshot), JSON.stringify(terms.actions), JSON.stringify(modelsOf(terms)), JSON.stringify(terms.ceilings), terms.route, terms.retention, terms.expiry, 'enforced', preview.digest, appr.id, now, now).run();
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
  if (typeof input.approvalId !== 'string' || !input.approvalId) throw err(409, 'NOT_APPROVED', 'A fresh approved, unconsumed approval is required.');
  const appr = await first(db, 'SELECT * FROM approvals WHERE id = ?', input.approvalId);
  if (!appr || appr.action !== 'grant.commit' || appr.decision !== 'approved' || appr.consumed_at) {
    throw err(409, 'NOT_APPROVED', 'A fresh approved, unconsumed approval is required.');
  }
  if (appr.expiry <= nowIso()) throw err(410, 'APPROVAL_EXPIRED', 'Approval expired.');
  const preview = await first(db, 'SELECT * FROM grant_previews WHERE id = ?', appr.preview_id);
  if (!preview || appr.preview_digest !== preview.digest || input.previewHash !== preview.digest) {
    throw err(412, 'PREVIEW_STALE', 'Preview mismatch; regenerate it.');
  }
  const terms = parseJson(preview.canonical_json, {});
  const conn = await first(db, 'SELECT * FROM connections WHERE id = ?', grant.connection_id);
  if (!conn || conn.state !== 'active') throw err(409, 'CONNECTION_DOWN', 'Connection is not active.');
  const now = nowIso();
  await db.prepare('INSERT INTO fabric_grant_revisions (id, grant_id, version, terms_json, approval_id, superseded_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(`fgr_${randHex(8)}`, id, grant.version, JSON.stringify({ consumers: parseJson(grant.consumers, []), snapshot: parseJson(grant.snapshot, []), ceilings: parseJson(grant.ceilings, {}) }), appr.id, now).run();
  await db.prepare('UPDATE fabric_grants SET consumers = ?, snapshot = ?, models = ?, ceilings = ?, expiry = ?, version = version + 1, preview_hash = ?, updated_at = ? WHERE id = ?')
    .bind(JSON.stringify(terms.consumers), JSON.stringify(terms.snapshot), JSON.stringify(modelsOf(terms)), JSON.stringify(terms.ceilings), terms.expiry, preview.digest, now, id).run();
  await db.prepare('UPDATE approvals SET consumed_at = ? WHERE id = ?').bind(now, appr.id).run();
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
  await db.prepare('UPDATE fabric_grants SET status = ?, version = version + 1, updated_at = ? WHERE id = ?').bind('paused', nowIso(), id).run();
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
  await db.prepare('UPDATE fabric_grants SET status = ?, version = version + 1, updated_at = ? WHERE id = ?').bind('enforced', nowIso(), id).run();
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
  await db.prepare('UPDATE fabric_grants SET status = ?, version = version + 1, updated_at = ? WHERE id = ?').bind('revoked', nowIso(), id).run();
  await auditFabric(db, actor, 'fabric.grant.revoke', id);
  return { status: 200, body: { id, status: 'revoked' } };
}

async function actorExportsGrant(db, actor, grant) {
  // The exporter is whoever owns the granted resources — not merely a
  // connection side. Importers can read the grant but never mutate it.
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
export async function createDeny(db, actor, input = {}) {
  if (isAgentKey(actor)) throw err(403, 'FORBIDDEN', 'Agent credentials cannot manage denies.');
  const resourceId = typeof input.resourceId === 'string' ? input.resourceId.slice(0, 64) : null;
  if (resourceId) {
    const r = await first(db, 'SELECT owner_id FROM resources WHERE id = ?', resourceId);
    if (!r || r.owner_id !== actor.user.id) throw err(404, 'NOT_FOUND', 'Resource not found or not yours.');
  }
  const id = `fdeny_${randHex(8)}`;
  await db.prepare('INSERT INTO fabric_denies (id, owner_id, principal, resource_id, action, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, actor.user.id, input.principal ? String(input.principal).slice(0, 128) : null, resourceId, input.action ? String(input.action).slice(0, 32) : null, nowIso()).run();
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
  const rows = await all(db, `SELECT g.* FROM fabric_grants g JOIN connections c ON c.id = g.connection_id
    WHERE g.recipient_node = ? AND g.recipient_workspace = ? AND g.status = 'enforced' AND c.state = 'active'`, node.id, node.workspace);
  const grants = rows.map((g) => {
    const hit = parseJson(g.snapshot, []).find((s) => s.resourceId === request.resourceId);
    if (!hit) return null;
    return {
      id: g.id, status: g.status, recipientNode: g.recipient_node, recipientWorkspace: g.recipient_workspace,
      consumers: parseJson(g.consumers, []), resourceId: hit.resourceId, incarnation: hit.incarnation,
      actions: parseJson(g.actions, []), models: parseJson(g.models, []),
      notBefore: g.created_at, expiry: g.expiry, ceilings: parseJson(g.ceilings, {}), route: g.route, revision: g.version
    };
  }).filter(Boolean);
  // Deny scope: only the resource owner's denies apply (no cross-tenant deny bleed).
  const ownerRow = await first(db, 'SELECT owner_id FROM resources WHERE id = ?', request.resourceId);
  const denies = ownerRow ? (await all(db, 'SELECT principal, resource_id AS resourceId, action FROM fabric_denies WHERE owner_id = ? AND (resource_id = ? OR resource_id IS NULL)', ownerRow.owner_id, request.resourceId))
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
    const grants = await all(db, `SELECT g.snapshot FROM fabric_grants g JOIN connections c ON c.id = g.connection_id
      WHERE g.recipient_node IN (${q}) AND g.status = 'enforced' AND c.state = 'active' AND g.expiry > ?`, ...ids, nowIso());
    const seen = new Set(items.map((i) => i.id));
    for (const g of grants) {
      for (const s of parseJson(g.snapshot, [])) {
        if (!seen.has(s.resourceId)) {
          seen.add(s.resourceId);
          const r = await first(db, 'SELECT name FROM resources WHERE id = ?', s.resourceId);
          items.push({ id: s.resourceId, name: r ? r.name : '(removed)', incarnation: s.incarnation, via: 'grant' });
        }
      }
    }
  }
  return { status: 200, body: { items, total: items.length, note: 'Fixture discovery: owned resources plus enforced-grant resources for your nodes only.' } };
}

// ---- idempotency (router uses these around mutations) ----
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
      return finishIdempotentRead(raced, method, path, bodyHash);
    }
    return null;
  }
  return finishIdempotentRead(existing, method, path, bodyHash);
}

function finishIdempotentRead(rec, method, path, bodyHash) {
  if (rec.method !== method || rec.path !== path || rec.request_hash !== bodyHash) {
    throw err(409, 'IDEMPOTENCY_MISMATCH', 'Idempotency-Key was already used with a different request.');
  }
  if (rec.status !== 'completed') throw err(409, 'IDEMPOTENCY_PENDING', 'Same key is already processing; retry.');
  return { status: rec.response_code, body: parseJson(rec.response_body, {}), replayed: true };
}

export async function storeIdempotency(db, actor, key, status, body) {
  const actorKey = `${actor.kind}:${actor.user.id}`;
  // Stored whole: replays must return the exact recorded response. Bodies
  // derive from 64 KiB-capped requests, so TEXT stays bounded.
  await db.prepare('UPDATE idempotency_records SET status = ?, response_code = ?, response_body = ? WHERE idem_key = ? AND actor = ?')
    .bind('completed', status, JSON.stringify(body), key, actorKey).run();
}
