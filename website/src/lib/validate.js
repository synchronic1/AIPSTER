/* Built with Meta Muse. */
// Input validation: schemas, pagination, access, and input-size limits.
// Web-API port of the local backend's validate.mjs (no Node stream API).
export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_PAGE_SIZE = 50;

export function httpError(status, message, code) {
  return Object.assign(new Error(message), { status, code: code || 'BAD_REQUEST' });
}

export async function readJson(request, maxBytes = MAX_BODY_BYTES) {
  // Enforce the limit in wire bytes, not UTF-16 code units: read the body as
  // a byte stream and stop as soon as the cap is exceeded. A pre-read
  // request.text() would let a multi-byte-heavy UTF-8 payload (e.g. CJK,
  // ~3 bytes per char) several times over the cap pass a char-count check.
  const declared = request && request.headers ? Number(request.headers.get('content-length')) : NaN;
  if (Number.isFinite(declared) && declared > maxBytes) throw httpError(413, 'Body too large.', 'BODY_TOO_LARGE');
  let text;
  const body = request ? request.body : null;
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        const step = await reader.read();
        if (step.done) break;
        const n = step.value ? (step.value.byteLength || step.value.length || 0) : 0;
        total += n;
        if (total > maxBytes) {
          try { await reader.cancel(); } catch { /* best effort */ }
          throw httpError(413, 'Body too large.', 'BODY_TOO_LARGE');
        }
        chunks.push(step.value);
      }
    } finally {
      try { reader.releaseLock(); } catch { /* best effort */ }
    }
    const merged = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { merged.set(c, off); off += (c.byteLength || c.length || 0); }
    text = new TextDecoder().decode(merged);
  } else {
    text = await request.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) throw httpError(413, 'Body too large.', 'BODY_TOO_LARGE');
  }
  return parseJson(text);
}

export function parseJson(text, maxFields = 40) {
  let data;
  try { data = JSON.parse(text || '{}'); } catch { throw httpError(400, 'Invalid JSON body.', 'BAD_JSON'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw httpError(400, 'JSON object required.', 'BAD_JSON');
  if (Object.keys(data).length > maxFields) throw httpError(400, 'Too many fields.', 'BAD_JSON');
  return data;
}

export const isId = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v);
export const isName = (v, max = 80) => typeof v === 'string' && v.trim().length >= 1 && v.length <= max;
export const isScope = (v) => v === 'read' || v === 'inference';
export const isEmail = (v) => typeof v === 'string' && v.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());

export function pagination(url) {
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '20', 10) || 20, 1), MAX_PAGE_SIZE);
  const offset = Math.max(parseInt(url.searchParams.get('offset') || '0', 10) || 0, 0);
  return { limit, offset };
}
