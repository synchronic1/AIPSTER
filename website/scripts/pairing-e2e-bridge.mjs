/* Built with Meta Muse. */
// Test-only HTTP bridge: serves the REAL worker.js + in-memory D1 shim over
// loopback so the Python pairing client can exercise the true protocol.
// Never shipped, never exposed beyond 127.0.0.1, disposable fixtures only.
//
// Usage: node scripts/pairing-e2e-bridge.mjs
// Prints "BRIDGE_READY port=<p>" once listening, then serves until killed.
// All /api/* routes forward to worker.js; /__test/* are bridge admin hooks
// (seed/disable users, expire codes, backdate beats, inspect rows).
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { createTestEnv, sessionCookieHeader, TEST_SECRET } from '../tests/d1-shim.mjs';

const t = await createTestEnv({ BETTER_AUTH_URL: 'http://127.0.0.1:0' });
const now = () => new Date().toISOString();

async function seedUser(email, name, id) {
  await t.DB.prepare('INSERT INTO allowlist (email, added_at) VALUES (?, ?)').bind(email, now()).run();
  await t.DB.prepare('INSERT INTO "user" (id, name, email, emailVerified, image, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, name, email, 1, null, now(), now()).run();
  const token = randomBytes(32).toString('hex');
  const future = new Date(Date.now() + 12 * 3600 * 1000).toISOString();
  await t.DB.prepare('INSERT INTO session (id, expiresAt, token, createdAt, updatedAt, ipAddress, userAgent, userId) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind('s_' + token.slice(0, 8), future, token, now(), now(), null, 'e2e-bridge', id).run();
  return { id, cookie: sessionCookieHeader(token, TEST_SECRET) };
}

const admin = {
  'POST /__test/seed-user': async (body) => {
    const id = 'u_' + randomBytes(4).toString('hex');
    return [200, await seedUser(body.email, body.name, id)];
  },
  'POST /__test/disable-user': async (body) => {
    await t.DB.prepare('UPDATE "user" SET disabled = 1 WHERE id = ?').bind(body.id).run();
    return [200, { ok: true }];
  },
  'POST /__test/expire-code': async (body) => {
    await t.DB.prepare('UPDATE pairing_codes SET expires_at = ? WHERE id = ?')
      .bind(new Date(Date.now() - 1000).toISOString(), body.id).run();
    return [200, { ok: true }];
  },
  'POST /__test/backdate-heartbeat': async (body) => {
    await t.DB.prepare('UPDATE resources SET heartbeat_at = ? WHERE id = ?').bind(body.at, body.id).run();
    return [200, { ok: true }];
  },
  'POST /__test/revoke-key': async (body) => {
    await t.DB.prepare('UPDATE key_verifiers SET revoked_at = ? WHERE id = ?').bind(now(), body.id).run();
    return [200, { ok: true }];
  },
  'GET /__test/resource': async (body, url) => {
    const id = url.searchParams.get('id');
    const row = await t.DB.prepare('SELECT id, owner_id, node_id, name, origin, online, usable, heartbeat_at FROM resources WHERE id = ?').bind(id).first();
    if (!row) return [404, { error: 'missing' }];
    return [200, row];
  },
  'GET /__test/health': async () => [200, { ok: true }],
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    const raw = await readBody(req);
    const adminKey = `${req.method} ${url.pathname}`;
    if (admin[adminKey]) {
      let body = {};
      try { body = raw.length ? JSON.parse(raw.toString('utf8')) : {}; } catch { body = {}; }
      const [status, payload] = await admin[adminKey](body, url);
      const data = Buffer.from(JSON.stringify(payload));
      res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': data.length });
      res.end(data);
      return;
    }
    // Forward everything else to the real worker.
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (['cookie', 'authorization', 'content-type', 'x-aipster-csrf'].includes(k.toLowerCase())) headers[k] = v;
    }
    const init = { method: req.method, headers };
    if (raw.length) init.body = raw;
    const out = await t.call(url.pathname + url.search, { method: req.method, headers, body: raw.length ? raw.toString('utf8') : undefined });
    const text = await out.text();
    const data = Buffer.from(text);
    res.writeHead(out.status, { 'Content-Type': 'application/json', 'Content-Length': data.length });
    res.end(data);
  } catch (e) {
    console.error('BRIDGE_FAIL', e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e);
    const data = Buffer.from(JSON.stringify({ error: 'bridge failed', code: 'BRIDGE' }));
    res.writeHead(500, { 'Content-Type': 'application/json', 'Content-Length': data.length });
    res.end(data);
  }
});

server.listen(0, '127.0.0.1', () => {
  console.log(`BRIDGE_READY port=${server.address().port}`);
});
