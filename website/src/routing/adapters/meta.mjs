/* Built with Meta Muse. */
// Meta Model API adapter for routing rankings. All provider specifics —
// model IDs, Responses API wire shape, strict ranking schema, error/usage
// parsing, prices — live here and nowhere else. Prices verified against
// the official pricing page on 2026-11-01; re-verify before ANY live use
// (Gate 2): the table below is config, not a live quote.
import { httpError } from '../../lib/validate.js';

export const META_RESPONSES_URL = 'https://api.meta.ai/v1/responses';
export const RANK_OUTPUT_MAX_TOKENS = 512;
export const RANK_ENVELOPE_MAX = 16 * 1024;
const RANK_BODY_MAX = 64 * 1024;

export const META_PRICES = {
  version: 'meta-2026-11-01',
  source: 'https://dev.meta.ai/docs/pricing-rate-limits',
  verifiedUtc: '2026-11-01',
  liveVerificationRequired: true,
  standard: { model: 'muse-spark-1.3', inPer1M: 1.25, outPer1M: 4.25, rpm: 3000, tpm: 4000000 },
  // Model ID + token prices verified on the same page; rpm/tpm are
  // PRD-supplied and UNVERIFIED — re-check before live contributor use.
  contributor: { model: 'muse-spark-1.3-contributor', inPer1M: 0.10, outPer1M: 0.20, rpm: 150, tpm: 3000000, limitsProvisional: true },
};

export const estimateTokens = (s) => Math.ceil(String(s || '').length / 4);
export const spendFor = (inTok, outTok, mode) => {
  const p = META_PRICES[mode] || META_PRICES.standard;
  return Number(((inTok / 1e6) * p.inPer1M + (outTok / 1e6) * p.outPer1M).toFixed(6));
};

function fail(status, message, code) {
  return httpError(status, message, code);
}

export function buildRankingRequest({ envelope, policyVersion, mode, maxOutputTokens }) {
  const aliases = envelope.map((e) => e.id);
  return {
    url: META_RESPONSES_URL,
    body: {
      model: (META_PRICES[mode] || META_PRICES.standard).model,
      input: [{
        role: 'user',
        content: [{
          type: 'input_text',
          text: JSON.stringify({ task: 'rank', policyVersion, candidates: envelope, constraints: ['rankedIds must contain only the supplied candidate ids, no duplicates', 'reasonCodes from the fixed enum only', 'no other top-level fields'] }),
        }],
      }],
      text: {
        format: {
          type: 'json_schema',
          name: 'route_ranking',
          strict: true,
          schema: {
            type: 'object',
            properties: {
              version: { type: 'string' },
              rankedIds: { type: 'array', items: { type: 'string', enum: aliases } },
              reasonCodes: { type: 'array', items: { type: 'string' } },
              note: { type: 'string' },
            },
            required: ['version', 'rankedIds', 'reasonCodes', 'note'],
            additionalProperties: false,
          },
        },
      },
      max_output_tokens: maxOutputTokens,
      store: false,
    },
  };
}

async function readCapped(response) {
  const reader = response.body ? response.body.getReader() : null;
  if (!reader) {
    const text = await response.text();
    if (text.length > RANK_BODY_MAX) throw fail(502, 'Advice response exceeded the size bound.', 'ADVICE_MALFORMED');
    return text;
  }
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > RANK_BODY_MAX) { try { await reader.cancel(); } catch { /* best effort */ } throw fail(502, 'Advice response exceeded the size bound.', 'ADVICE_MALFORMED'); }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function usageOf(payload) {
  const u = (payload && payload.usage) || {};
  const inp = Number.isSafeInteger(u.input_tokens) ? u.input_tokens : null;
  const out = Number.isSafeInteger(u.output_tokens) ? u.output_tokens : null;
  return { inputTokens: inp, outputTokens: out };
}

/**
 * One bounded ranking call. fetchImpl is injectable so tests prove the
 * boundary without network. Throws typed ADVICE_* failures; never leaks
 * the key, headers, or raw provider body.
 */
export async function metaAdviceCall({ fetchImpl = fetch, apiKey, envelope, mode = 'standard', maxOutputTokens = RANK_OUTPUT_MAX_TOKENS, signal } = {}) {
  const { url, body } = buildRankingRequest({ envelope, policyVersion: 'route/v1', mode, maxOutputTokens });
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (e && (e.name === 'AbortError' || e.name === 'TimeoutError')) throw fail(504, 'Advice call timed out.', 'ADVICE_TIMEOUT');
    throw fail(502, 'Advice provider unreachable.', 'ADVICE_UNREACHABLE');
  }
  if (response.status === 429) throw fail(429, 'Advice provider rate-limited.', 'ADVICE_RATE_LIMITED');
  if (response.status === 401 || response.status === 403) throw fail(502, 'Advice provider rejected credentials.', 'ADVICE_AUTH');
  if (response.status === 400) throw fail(502, 'Advice provider rejected the request.', 'ADVICE_REJECTED');
  if (response.status < 200 || response.status >= 300) throw fail(502, 'Advice provider error.', 'ADVICE_UPSTREAM');
  const text = await readCapped(response);
  let payload;
  try { payload = JSON.parse(text); } catch { throw fail(502, 'Advice response was not JSON.', 'ADVICE_MALFORMED'); }
  if (payload && payload.status === 'incomplete') throw fail(502, 'Advice response was truncated.', 'ADVICE_TRUNCATED');
  const out0 = payload && Array.isArray(payload.output) ? payload.output[0] : null;
  const part = out0 && Array.isArray(out0.content) ? out0.content[0] : null;
  if (!part || part.type !== 'output_text' || typeof part.text !== 'string') {
    throw fail(502, 'Advice provider refused or returned no text.', 'ADVICE_REFUSED');
  }
  let data;
  try { data = JSON.parse(part.text); } catch { throw fail(502, 'Advice ranking was not JSON.', 'ADVICE_MALFORMED'); }
  return { data, usage: usageOf(payload) };
}
