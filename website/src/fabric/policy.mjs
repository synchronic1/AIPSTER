/* Built with Meta Muse. */
// Pure effective-permission evaluation over plain data (no I/O). F0 validates
// the federation contract against fixtures with these functions; F1 wires
// them to D1 + HTTP/MCP handlers. Invariants: deny by default, one complete
// grant covers the whole request (no stitching across grants), deterministic
// single-witness selection (earliest expiry, then immutable grant ID).
export const REASONS = {
  NO_MATCHING_GRANT: 'NO_MATCHING_GRANT',
  GRANT_NOT_ENFORCED: 'GRANT_NOT_ENFORCED',
  GRANT_EXPIRED: 'GRANT_EXPIRED',
  CONSUMER_NOT_COVERED: 'CONSUMER_NOT_COVERED',
  RESOURCE_MISMATCH: 'RESOURCE_MISMATCH',
  RECIPIENT_MISMATCH: 'RECIPIENT_MISMATCH',
  ACTION_DENIED: 'ACTION_DENIED',
  MODEL_DENIED: 'MODEL_DENIED',
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  EXPLICIT_DENY: 'EXPLICIT_DENY',
  STALE_REVISION: 'STALE_REVISION',
  ROUTE_DENIED: 'ROUTE_DENIED'
};

// Request: { resourceId, incarnation, action, model, peerNode, peerWorkspace,
// consumer, maxTokens, route, at, expectedRevision? }
// Grant: { id, status, recipientNode, recipientWorkspace, consumers[],
// resourceId, incarnation, actions[], models[], notBefore, expiry, ceilings:
// { maxTokens }, route, revision }
export function matchGrant(request, grant, reasons = []) {
  const fail = (code) => { reasons.push(code); return false; };
  if (!grant || grant.status !== 'enforced') return fail(REASONS.GRANT_NOT_ENFORCED);
  if (grant.recipientNode !== request.peerNode || grant.recipientWorkspace !== request.peerWorkspace) {
    return fail(REASONS.RECIPIENT_MISMATCH);
  }
  if (!Array.isArray(grant.consumers) || !grant.consumers.includes(request.consumer)) {
    return fail(REASONS.CONSUMER_NOT_COVERED);
  }
  if (grant.resourceId !== request.resourceId || grant.incarnation !== request.incarnation) {
    return fail(REASONS.RESOURCE_MISMATCH);
  }
  if (!grant.actions.includes(request.action)) return fail(REASONS.ACTION_DENIED);
  if (!grant.models.includes(request.model)) return fail(REASONS.MODEL_DENIED);
  if (request.at < grant.notBefore || request.at >= grant.expiry) return fail(REASONS.GRANT_EXPIRED);
  if (grant.route !== request.route) return fail(REASONS.ROUTE_DENIED);
  if (typeof request.maxTokens === 'number' && request.maxTokens > grant.ceilings.maxTokens) {
    return fail(REASONS.QUOTA_EXCEEDED);
  }
  if (request.expectedRevision !== undefined && request.expectedRevision !== grant.revision) {
    return fail(REASONS.STALE_REVISION);
  }
  return true;
}

// Deny: { principal?, resourceId?, action? } — every specified field must match.
export function matchDeny(request, deny) {
  if (deny.principal !== undefined && deny.principal !== request.consumer) return false;
  if (deny.resourceId !== undefined && deny.resourceId !== request.resourceId) return false;
  if (deny.action !== undefined && deny.action !== request.action) return false;
  return true;
}

export function selectWitness(request, grants) {
  const eligible = grants.filter((g) => matchGrant(request, g, []));
  eligible.sort((a, b) => (a.expiry < b.expiry ? -1 : a.expiry > b.expiry ? 1 : (a.id < b.id ? -1 : 1)));
  return eligible[0] || null;
}

export function evaluate(request, { grants = [], denies = [] } = {}) {
  for (const deny of denies) {
    if (matchDeny(request, deny)) {
      return { decision: 'deny', code: REASONS.EXPLICIT_DENY, witness: null, evaluated: grants.length };
    }
  }
  const details = [];
  for (const grant of grants) {
    const reasons = [];
    if (matchGrant(request, grant, reasons)) details.push({ id: grant.id, match: true, reasons });
    else details.push({ id: grant.id, match: false, reasons });
  }
  const witness = selectWitness(request, grants);
  if (witness) return { decision: 'allow', code: null, witness: witness.id, evaluated: grants.length };
  return { decision: 'deny', code: REASONS.NO_MATCHING_GRANT, witness: null, evaluated: grants.length, details };
}
