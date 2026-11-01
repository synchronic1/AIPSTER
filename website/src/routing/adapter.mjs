/* Built with Meta Muse. */
// Provider-neutral routing-advice interface. Exactly one adapter ('meta')
// is implemented; adding another means a new module under adapters/ plus
// one registry line — callers never touch provider wire details.
//
// Interface contract per advice call:
//   in:  { envelope (alias-only candidates), mode, maxOutputTokens, signal }
//   out: { data (parsed JSON for ranking validation), usage }
//   err: typed ADVICE_* failures with status (never key/header/body leaks).
import { httpError } from '../lib/validate.js';
import { metaAdviceCall } from './adapters/meta.mjs';

export const ROUTING_ADAPTERS = ['meta'];

const REGISTRY = { meta: metaAdviceCall };

export async function callRoutingAdvice({ adapter = 'meta', ...rest } = {}) {
  const fn = REGISTRY[adapter];
  if (!fn) throw httpError(502, `Unknown advice adapter: ${adapter}.`, 'ADVICE_DISALLOWED');
  return fn(rest);
}
