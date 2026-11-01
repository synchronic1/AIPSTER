/* Built with Meta Muse. */
// Strict ranked-IDs response contract (route-rank/v1). The model may ONLY
// reorder eligible aliases: unknown ids, duplicates, foreign fields,
// oversize text and wrong versions are all malformed and force the
// deterministic fallback. Partial rankings complete deterministically from
// the fallback order so omissions can never eliminate a fallback option.
export const RANK_VERSION = 'route-rank/v1';
export const RANK_REASONS = ['freshness', 'capacity', 'locality', 'cost', 'load', 'compatibility'];
export const RANK_NOTE_MAX = 500;
export const RANK_REASONS_MAX = 8;

export function rankError(message) {
  return Object.assign(new Error(message), { status: 502, code: 'ADVICE_MALFORMED' });
}

/**
 * Validate a parsed model response against the alias set.
 * @returns {{rankedIds:string[],reasonCodes:string[],note:string}}
 * @throws ADVICE_MALFORMED on any contract violation.
 */
export function validateRanking(value, aliasSet) {
  const fail = (m) => { throw rankError(`ranking contract: ${m}.`); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('top level must be an object');
  const keys = Object.keys(value).sort();
  if (keys.join(',') !== 'note,rankedIds,reasonCodes,version') fail('exact keys version,rankedIds,reasonCodes,note required');
  if (value.version !== RANK_VERSION) fail('unknown version');
  if (!Array.isArray(value.rankedIds) || value.rankedIds.length === 0) fail('rankedIds must be a non-empty array');
  if (value.rankedIds.length > aliasSet.size) fail('rankedIds longer than the candidate list');
  const seen = new Set();
  for (const id of value.rankedIds) {
    if (typeof id !== 'string' || !aliasSet.has(id)) fail(`unknown candidate id: ${JSON.stringify(id)}`);
    if (seen.has(id)) fail(`duplicate candidate id: ${id}`);
    seen.add(id);
  }
  if (!Array.isArray(value.reasonCodes) || value.reasonCodes.length > RANK_REASONS_MAX) fail('reasonCodes bounded array required');
  for (const r of value.reasonCodes) {
    if (typeof r !== 'string' || !RANK_REASONS.includes(r)) fail(`unknown reason code: ${JSON.stringify(r)}`);
  }
  if (typeof value.note !== 'string' || value.note.length > RANK_NOTE_MAX) fail('note bounded string required');
  return { rankedIds: [...value.rankedIds], reasonCodes: [...value.reasonCodes], note: value.note };
}

/**
 * Deterministically complete a partial ranking: validated ids first, then
 * the fallback order's remaining aliases. Returns {ranking, completed}.
 */
export function completeRanking(validatedIds, fallbackOrder) {
  const have = new Set(validatedIds);
  const ranking = [...validatedIds];
  for (const a of fallbackOrder) {
    if (!have.has(a)) { have.add(a); ranking.push(a); }
  }
  return { ranking, completed: ranking.length !== validatedIds.length };
}
