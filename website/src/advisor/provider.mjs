/* Built with Meta Muse. */
// Fabric adviser provider boundary. Fixtures are deterministic, free and
// always available. The live Meta path is closed by default and opens only
// with an explicit flag, a bound server-side key, a non-demo session and a
// positive spend cap — and even then every call is bounded (input tokens,
// output tokens, bytes, deadline, single destination) with sanitized
// errors. Nothing here ever sees tenant secrets or raw inventory beyond
// the redacted snapshot.
//
// Verified 2026-10-31 against https://dev.meta.ai/docs: model
// muse-spark-1.3, POST /v1/responses, Bearer MODEL_API_KEY, text.format
// json_schema, store flag, max_output_tokens floor, Standard pricing.
import { httpError } from '../lib/validate.js';
import { ADVISOR_ENVELOPE_MAX, validateAdvice } from './validate.mjs';

export const ADVISOR_MODEL = 'muse-spark-1.3';
export const ADVISOR_RESPONSES_URL = 'https://api.meta.ai/v1/responses';
export const ADVISOR_OUTPUT_MAX_TOKENS = 768;
export const ADVISOR_INPUT_TOKEN_BOUND = 2000;
export const ADVISOR_DEADLINE_MS = 20000;
export const ADVISOR_RESPONSE_MAX = 32 * 1024;
export const ADVISOR_PRICE_IN_PER_M = 1.25;
export const ADVISOR_PRICE_OUT_PER_M = 4.25;

const REF_ENUM = Array.from({ length: 20 }, (_v, i) => `r${i + 1}`);

// Strict-subset JSON Schema (plain-object root, no allOf/oneOf,
// additionalProperties:false + full required everywhere, nested enums).
// Length/count bounds live server-side in validateAdvice, not here.
export const ADVISOR_JSON_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'One or two sentences of advice.' },
    recommendations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          resourceRef: { type: 'string', enum: REF_ENUM },
          modelRef: { type: 'null', description: 'Always null: no model contract exists.' },
          evidenceRefs: { type: 'array', items: { type: 'string', enum: REF_ENUM } },
          why: { type: 'string' },
          unknowns: { type: 'array', items: { type: 'string' } },
        },
        required: ['resourceRef', 'modelRef', 'evidenceRefs', 'why', 'unknowns'],
        additionalProperties: false,
      },
    },
    blockedReasons: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'recommendations', 'blockedReasons'],
  additionalProperties: false,
};

const INSTRUCTIONS = 'You are AIPSTER fabric advice. Recommend only from the snapshot refs given. '
  + 'Never invent resources, models, measurements, latency, or compatibility. '
  + 'Put every uncertainty in unknowns or blockedReasons. Dispatch is disabled; this is advisory text only.';

/** Live mode opens only with flag + bound key + non-demo session. Spend is checked per call. */
export function liveEnabled(env, { demo = false } = {}) {
  if (demo) return false;
  if (!env || env.ADVISOR_LIVE !== '1') return false;
  return typeof env.MODEL_API_KEY === 'string' && env.MODEL_API_KEY.length > 0;
}

/** Conservative input estimate: chars/4 overestimates typical tokenizers. */
export function estimateTokens(text) {
  return Math.ceil((typeof text === 'string' ? text.length : 0) / 4);
}

export function estimateSpendUsd(inputTokens, outputTokens) {
  return (inputTokens * ADVISOR_PRICE_IN_PER_M + outputTokens * ADVISOR_PRICE_OUT_PER_M) / 1e6;
}

export function buildLiveRequest(snapshot, task) {
  const body = {
    model: ADVISOR_MODEL,
    instructions: INSTRUCTIONS,
    input: [{ role: 'user', content: JSON.stringify({ task, snapshot }) }],
    text: { format: { type: 'json_schema', name: 'aipster_advice_v1', description: 'Bounded fabric advice.', schema: ADVISOR_JSON_SCHEMA, strict: true } },
    max_output_tokens: ADVISOR_OUTPUT_MAX_TOKENS,
    store: false,
    stream: false,
  };
  return { url: ADVISOR_RESPONSES_URL, body };
}

async function readCapped(response) {
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > ADVISOR_RESPONSE_MAX) {
      try { await reader.cancel(); } catch { /* best effort */ }
      throw httpError(502, 'Provider response exceeded the size bound.', 'PROVIDER_RESPONSE_TOO_LARGE');
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { merged.set(c, off); off += c.length; }
  return new TextDecoder().decode(merged);
}

function extractText(wire) {
  if (typeof wire.output_text === 'string' && wire.output_text) return wire.output_text;
  const parts = [];
  if (Array.isArray(wire.output)) {
    for (const item of wire.output) {
      if (!item || !Array.isArray(item.content)) continue;
      for (const c of item.content) {
        if (c && c.type === 'output_text' && typeof c.text === 'string') parts.push(c.text);
      }
    }
  }
  return parts.length ? parts.join('') : null;
}

/**
 * Pre-claim live bounds check. The route runs this BEFORE admission so
 * envelope/input/spend rejections charge nothing and write nothing;
 * runLive repeats it as defense in depth. Single source of truth: both
 * callers share these exact bounds, codes and messages.
 */
export function preflightLiveRequest(snapshot, task, spendCapUsd = 0) {
  const { body } = buildLiveRequest(snapshot, task);
  const payload = JSON.stringify(body);
  if (payload.length > ADVISOR_ENVELOPE_MAX) throw httpError(502, 'Advice request exceeded the envelope bound.', 'ENVELOPE_TOO_LARGE');
  const inputTokens = estimateTokens(payload);
  if (inputTokens > ADVISOR_INPUT_TOKEN_BOUND) throw httpError(502, 'Advice input exceeds the token bound.', 'INPUT_UNBOUNDED');
  const maxSpend = estimateSpendUsd(inputTokens, ADVISOR_OUTPUT_MAX_TOKENS);
  if (!(spendCapUsd > 0) || maxSpend > spendCapUsd) throw httpError(402, 'Advice spend cap does not cover this call.', 'SPEND_EXCEEDED');
  return { payload, inputTokens, maxSpend };
}

/**
 * One bounded live advice call. fetchImpl is injectable so tests prove the
 * boundary without network (zero external calls in dev/tests/CI).
 * Throws sanitized 502/504/402 errors; never leaks key, headers or raw body.
 */
export async function runLive({ fetchImpl = fetch, apiKey, snapshot, task, refs, spendCapUsd = 0, deadlineMs = ADVISOR_DEADLINE_MS }) {
  const { payload } = preflightLiveRequest(snapshot, task, spendCapUsd);
  const url = ADVISOR_RESPONSES_URL;
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: payload,
      redirect: 'error',
      signal: AbortSignal.timeout(deadlineMs),
    });
  } catch (e) {
    if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      throw httpError(504, 'Advice provider timed out.', 'PROVIDER_TIMEOUT');
    }
    throw httpError(502, 'Advice provider unreachable.', 'PROVIDER_UNREACHABLE');
  }
  if (response.status === 429) throw httpError(503, 'Advice provider is rate limited. Retry shortly.', 'PROVIDER_RATE_LIMITED');
  if (response.status === 401 || response.status === 403) throw httpError(502, 'Advice provider rejected credentials.', 'PROVIDER_AUTH');
  if (response.status === 400) throw httpError(502, 'Advice provider rejected the request shape.', 'PROVIDER_REJECTED');
  if (response.status < 200 || response.status >= 300) throw httpError(502, 'Advice provider errored.', 'PROVIDER_ERROR');
  let wire;
  try {
    wire = JSON.parse(await readCapped(response));
  } catch (e) {
    if (e && e.code === 'PROVIDER_RESPONSE_TOO_LARGE') throw e;
    throw httpError(502, 'Advice provider returned malformed output.', 'PROVIDER_MALFORMED');
  }
  if (!wire || typeof wire !== 'object' || wire.incomplete_details) {
    throw httpError(502, 'Advice provider response was truncated; nothing delivered.', 'PROVIDER_TRUNCATED');
  }
  const text = extractText(wire);
  let advice;
  try {
    advice = validateAdvice(JSON.parse(text || 'null'), { refs });
  } catch (e) {
    if (e && e.code === 'BAD_ADVICE') throw e;
    throw httpError(502, 'Advice provider returned malformed output.', 'PROVIDER_MALFORMED');
  }
  const usage = wire.usage && Number.isSafeInteger(wire.usage.input_tokens) && Number.isSafeInteger(wire.usage.output_tokens)
    && wire.usage.input_tokens >= 0 && wire.usage.output_tokens >= 0
    ? { input_tokens: wire.usage.input_tokens, output_tokens: wire.usage.output_tokens }
    : null;
  return {
    advice,
    usage,
    spendUsdEst: usage ? estimateSpendUsd(usage.input_tokens, usage.output_tokens) : null,
    responseId: typeof wire.id === 'string' ? wire.id : null,
    model: typeof wire.model === 'string' ? wire.model : ADVISOR_MODEL,
  };
}

/**
 * Deterministic fixture: recommends fresh+usable entries (ref order, max 3),
 * blocks everything else with the honest reason. Same input always yields
 * byte-identical, contract-valid output. Free, instant, offline.
 */
export function runFixture(snapshot, task) {
  const entries = Array.isArray(snapshot.entries) ? snapshot.entries : [];
  const recommendations = [];
  const blockedReasons = [];
  for (const e of [...entries].sort((a, b) => (a.ref < b.ref ? -1 : 1))) {
    if (recommendations.length >= 3 && (e.usable === true && e.telemetry === 'fresh')) continue;
    if (e.usable === true && e.telemetry === 'fresh' && recommendations.length < 3) {
      const caps = e.caps.length ? ` Capabilities: ${e.caps.slice(0, 3).join(', ')}.` : '';
      recommendations.push({
        resourceRef: e.ref,
        modelRef: null,
        evidenceRefs: [e.ref],
        why: `${e.ref} is usable with fresh telemetry.${caps}`,
        unknowns: ['Latency unknown.', 'Model compatibility unknown.'],
      });
    } else {
      const why = e.telemetry !== 'fresh' ? `telemetry is ${e.telemetry}` : 'not usable';
      if (blockedReasons.length < 8) blockedReasons.push(`${e.ref} blocked: ${why}.`);
    }
  }
  if (entries.length === 0) blockedReasons.push('No resources in this snapshot.');
  const summary = entries.length === 0
    ? 'Fixture advice: no resources in this snapshot, so nothing to recommend.'
    : `Fixture advice for ${entries.length} resource(s): ${recommendations.length} recommended, ${blockedReasons.length} blocked. Task noted (${Math.min(task.length, 40)} chars shown: ${task.slice(0, 40)}).`;
  return { summary: summary.slice(0, 2000), recommendations, blockedReasons };
}
