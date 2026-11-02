/* Federation functional lane milestone 2: visible isolated synthetic demo.
 * Executes the REAL reviewed fabric handlers in-process (real worker
 * module, FEDERATION_ENABLED=1, sqlite shim, in-process Request dispatch —
 * no sockets, no peers, no backend). Every identity, resource and outcome
 * below is SYNTHETIC/FIXTURE. Nothing here is a live two-user claim. */
import { randomBytes } from 'node:crypto';
import { createTestEnv, readJson } from '../../tests/d1-shim.mjs';
import { budgetWindow } from '../../src/lib/quotas.js';

export const DEMO_LABEL = 'SYNTHETIC/FIXTURE — isolated in-process demonstration, not live sharing';
export const TRANSPORT = 'in-process Request dispatch to the real worker module; no network, no peers, no backend';

let idem = 0;
const freshKey = () => `demo-idem-${++idem}-${randomBytes(4).toString('hex')}`;

async function seed(t) {
  const now = new Date().toISOString();
  await t.DB.prepare(`INSERT INTO resources (id, owner_id, name, kind, origin, cpu, gpu, capabilities_json, configured, authenticated, online, usable, heartbeat_at, limits_json, scope, verification_json, credits_json, created_at)
    VALUES ('r_gpu1','u_alice','gpu-1','local','declared','x','y','[]',1,0,0,0,NULL,'{}','owner only','{}',NULL,?)`).bind(now).run();
  await t.DB.prepare('INSERT INTO "user" (id, name, email, emailVerified, image, username, displayUsername, demo, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind('u_demo', 'Synthetic Demo', 'demo@aipster.invalid', 0, null, 'demo', 'demo', 1, now, now).run();
  const future = new Date(Date.now() + 12 * 3600e3).toISOString();
  const demoToken = randomBytes(32).toString('hex');
  await t.DB.prepare('INSERT INTO session (id, expiresAt, token, createdAt, updatedAt, ipAddress, userAgent, userId) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind('s_demo01', future, demoToken, now, now, null, 'test', 'u_demo').run();
  return { id: 'u_demo', token: demoToken };
}

export async function runTwoUserDemo() {
  const t = await createTestEnv({ FEDERATION_ENABLED: '1' });
  const demo = await seed(t);
  const S = (user, extra = {}) => ({ ...t.as(user), ...t.csrf, ...extra });
  const post = async (path, user, body = {}) =>
    readJson(await t.call(path, { method: 'POST', headers: S(user, { 'Idempotency-Key': freshKey() }), body }));
  const get = async (path, user) => readJson(await t.call(path, { headers: S(user) }));
  const sec = async (title, fn) => ({ title, label: DEMO_LABEL, ...(await fn()) });

  const regA = await post('/v1/fabric/nodes', t.alice, { label: 'alice-node' });
  const regB = await post('/v1/fabric/nodes', t.bob, { label: 'bob-node' });
  const inv = await post('/v1/fabric/invitations', t.alice,
    { issuerNode: regA.json.id, recipientNode: regB.json.id, recipientWorkspace: 'default', purpose: 'synthetic demo' });
  const acc = await post('/v1/fabric/invitations/accept', t.bob,
    { token: inv.json.token, nodeId: regB.json.id, nodeKey: regB.json.nodeSecret });
  const connId = acc.json.id;

  const sections = [];
  sections.push(await sec('per-user fabric views', async () => {
    const a = await get('/v1/fabric/nodes', t.alice);
    const b = await get('/v1/fabric/nodes', t.bob);
    return { aliceSees: a.json.items.map(n => n.label), bobSees: b.json.items.map(n => n.label) };
  }));
  sections.push(await sec('redacted peer node', async () => {
    const peer = await get(`/v1/fabric/nodes/${regA.json.id}`, t.bob);
    const stranger = await get(`/v1/fabric/nodes/${regA.json.id}`, demo);
    return {
      peerStatus: peer.status, peerMine: peer.json.mine,
      peerLeaksSecrets: ('node_secret_verifier' in peer.json) || ('node_secret_salt' in peer.json),
      strangerStatus: stranger.status
    };
  }));
  sections.push(await sec('invitations + connection', async () => {
    const incoming = await readJson(await t.call('/v1/fabric/invitations?role=received', { headers: S(t.bob) }));
    const conns = await get('/v1/fabric/connections', t.alice);
    return { bobIncomingCount: incoming.json.total, aliceSeesConnection: conns.json.items.some(x => x.id === connId) };
  }));

  const prev = await post('/v1/fabric/previews', t.alice,
    { connectionId: connId, resourceIds: ['r_gpu1'], consumers: ['bob-op'], models: ['llama'], maxTokens: 1000, maxRequests: 10 });
  const appr = await post('/v1/fabric/approvals', t.alice, { previewId: prev.json.id });
  await post(`/v1/fabric/approvals/${appr.json.id}/decide`, t.alice, { decision: 'approve' });
  const grant = await post('/v1/fabric/grants', t.alice, { approvalId: appr.json.id, previewHash: prev.json.digest });

  const authz = (user, body) => post('/v1/fabric/authorization/preview', user, body);
  const eligibleInput = { nodeId: regB.json.id, resourceId: 'r_gpu1', incarnation: 'gen1', action: 'infer', model: 'llama', consumer: 'bob-op', maxTokens: 100 };

  sections.push(await sec('grant visibility incoming/outgoing', async () => {
    const bIn = await readJson(await t.call('/v1/fabric/grants?scope=incoming', { headers: S(t.bob) }));
    const aOut = await readJson(await t.call('/v1/fabric/grants?scope=outgoing', { headers: S(t.alice) }));
    const third = await get(`/v1/fabric/grants/${grant.json.id}`, demo);
    return {
      bobIncomingHasGrant: bIn.json.items.some(g => g.id === grant.json.id),
      aliceOutgoingHasGrant: aOut.json.items.some(g => g.id === grant.json.id),
      thirdPartyStatus: third.status
    };
  }));
  sections.push(await sec('discovery via grant', async () => {
    const disc = await get('/v1/fabric/discovery', t.bob);
    const shared = disc.json.items.find(i => i.id === 'r_gpu1');
    return { sharedFound: !!shared, sharedVia: shared ? shared.via : null };
  }));
  sections.push(await sec('routing-eligibility preview allow/deny', async () => {
    const allow = await authz(t.bob, eligibleInput);
    const deny = await authz(t.bob, { ...eligibleInput, consumer: 'mallory-op' });
    return { grantedConsumer: allow.json.decision, ungrantedConsumer: deny.json.decision };
  }));
  sections.push(await sec('per-owner quota exhaustion', async () => {
    let allowed = 0, blockedAt = null;
    for (let i = 0; i < 130; i++) {
      const r = await post('/v1/fabric/nodes', t.alice, { label: `quota-probe-${i}` });
      if (r.status === 201) allowed++;
      else { blockedAt = r.status; break; }
    }
    const bobOk = await post('/v1/fabric/nodes', t.bob, { label: 'bob-quota-unaffected' });
    const spent = (t.sqlite.prepare('SELECT count FROM write_budget WHERE user_id=? AND window=?').get('u_alice', budgetWindow()) || {}).count;
    return { aliceAllowedBeforeBlock: allowed, aliceBlockedStatus: blockedAt, aliceBudgetSpent: spent, bobStillAllowed: bobOk.status === 201 };
  }));
  sections.push(await sec('revocation effect', async () => {
    const rev = await post(`/v1/fabric/grants/${grant.json.id}/revoke`, t.alice, { expectedVersion: grant.json.version });
    const after = await authz(t.bob, eligibleInput);
    const disc = await get('/v1/fabric/discovery', t.bob);
    return {
      revokeStatus: rev.status,
      eligibilityAfter: after.json.decision,
      stillDiscoveredViaGrant: disc.json.items.some(i => i.id === 'r_gpu1' && i.via === 'grant')
    };
  }));
  sections.push(await sec('audit rows present', async () => {
    const rows = t.sqlite.prepare('SELECT method, path, actor_kind FROM fabric_operation_admissions WHERE owner_id=?').all('u_alice');
    t.sqlite.close();
    return {
      admissionCount: rows.length,
      paths: rows.map(r => `${r.method} ${r.path}`),
      allSessionActor: rows.every(r => r.actor_kind === 'session')
    };
  }));

  return {
    label: DEMO_LABEL,
    transport: TRANSPORT,
    flags: { FEDERATION_ENABLED: '1 (this demo process only; default off elsewhere)' },
    sections,
    notShownLive: {
      heading: 'NOT SHOWN LIVE — absent by design in this demo',
      reasons: [
        'No live network or peers: all calls are in-process Request dispatches; nothing leaves this process.',
        'No live identities, grants or resources: alice/bob/demo and r_gpu1 are synthetic fixtures.',
        'Cross-fabric F1/F1P sharing stays disabled: FEDERATION_ENABLED defaults off outside this demo process, F1P stays held and inference disabled per docs/federation/integration-readiness.md.'
      ],
      liveTestPrerequisites: [
        'Real user identities with sign-in credentials (not fixture sessions).',
        'Real granted resources on networked peer nodes reachable over transport.',
        'Flags enabled in a non-production backend with a real D1 database.',
        'A browser pass for the UI surface (no browser was launched for this demo).'
      ]
    }
  };
}
