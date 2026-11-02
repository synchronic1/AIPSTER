#!/usr/bin/env node
// Minimal static server for the demo. Loopback only, no directory listing,
// no path traversal, no external requests.
//
//   node scripts/serve.mjs            # http://127.0.0.1:8099/
//   node scripts/serve.mjs --port 8123

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = normalize(join(dirname(fileURLToPath(import.meta.url)), '..'));
const argv = process.argv.slice(2);
const portIndex = argv.indexOf('--port');
const port = portIndex === -1 ? 8099 : Number(argv[portIndex + 1]);

if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  console.error('--port must be an integer between 1024 and 65535');
  process.exit(2);
}
if (port === 8090) {
  console.error('Port 8090 is reserved on this workstation; choose another port.');
  process.exit(2);
}

const TYPES = new Map(Object.entries({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8'
}));

const server = createServer(async (req, res) => {
  let pathname;
  try {
    // A request target that is not origin-form (`//`, `///`, `http://[`) makes
    // the URL constructor throw, and a truncated percent escape makes decoding
    // throw. Both are malformed requests. This listener is async, so a throw
    // would surface as an unhandled rejection and could end the demo process
    // instead of answering, so refuse them here with one 400.
    pathname = decodeURIComponent(new URL(req.url || '/', `http://127.0.0.1:${port}`).pathname);
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('bad request');
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' }).end('method not allowed');
    return;
  }
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = normalize(join(root, relative));

  if (target !== root && !target.startsWith(root + sep)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  let filePath = target;
  try {
    const info = await stat(filePath);
    if (info.isDirectory()) filePath = join(filePath, 'index.html');
    const body = await readFile(filePath);
    res.writeHead(200, {
      'content-type': TYPES.get(extname(filePath).toLowerCase()) || 'application/octet-stream',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer'
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`DSH x DGM experiment demo: http://127.0.0.1:${port}/?experiment=on`);
  console.log('Loopback only. Nothing is applied. Ctrl+C to stop.');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
