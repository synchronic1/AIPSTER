/* Built with Meta Muse. */
// Input validation: schemas, pagination, access, and input-size limits.
// Web-API port of the local backend's validate.mjs (no Node stream API).
export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_PAGE_SIZE = 50;

export function httpError(status, message, code) {
  return Object.assign(new Error(message), { status, code: code || 'BAD_REQUEST' });
}

export async function readJson(request, maxBytes = MAX_BODY_BYTES) {
  const text = await request.text();
  if (text.length > maxBytes) throw httpError(413, 'Body too large.', 'BODY_TOO_LARGE');
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
