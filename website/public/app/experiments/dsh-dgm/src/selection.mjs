// Bounded selection and explicit rollback.
//
// Selection here is a *recommendation with a receipt*, not a promotion. Every
// record carries `applied: false` and a rollback plan that names the exact
// revision it would restore. There is no code path in this module that writes
// to a repository, a configuration store or an upstream ticket.

import { digestOf, idFromDigest, seal, verifySeal } from './canonical.mjs';
import { buildRequest } from './adapter.mjs';
import { evaluate } from './evaluate.mjs';
import {
  AUTHORITY,
  GATES,
  RECEIPT_SCHEMA,
  SELECTED,
  SELECTION_SCHEMA,
  isRefusal,
  refusal
} from './contract.mjs';

export const MAX_CANDIDATES = 8;

/**
 * Internal coherence: a verdict must agree with its own receipt and gates.
 *
 * This is what stops a fabricated verdict whose seal is valid — the seals are
 * unkeyed, so "it verifies" means "nobody mistyped it", not "somebody vouched
 * for it". A relabelled `rejected` verdict still carries a receipt that says
 * `rejected`, gates that failed, and a repair count that does not match.
 */
function coherenceFailure(verdict) {
  const receipt = verdict.receipt;
  if (receipt.schema !== RECEIPT_SCHEMA) return 'the receipt schema is not recognised';
  if (receipt.status !== verdict.status) return 'the receipt status does not match the verdict status';
  if (receipt.code !== verdict.code) return 'the receipt code does not match the verdict code';
  if (receipt.request_sha256 !== verdict.request_sha256) return 'the receipt binds a different request';
  if (receipt.run_id !== verdict.run_id) return 'the receipt names a different run';
  if (receipt.subject !== verdict.subject) return 'the receipt names a different subject';
  if (receipt.applied !== false) return 'the receipt claims application';
  if (!verdict.provenance || receipt.subject_sha256 !== verdict.provenance.subject_sha256) {
    return 'the receipt subject digest does not match the provenance';
  }
  if (receipt.reference_sha256 !== verdict.provenance.reference_sha256) {
    return 'the receipt reference digest does not match the provenance';
  }
  if (receipt.subject_ppm !== verdict.scores.subject_ppm) return 'the receipt score does not match the verdict score';
  if (receipt.reference_ppm !== verdict.scores.reference_ppm) return 'the receipt reference score does not match';
  if (receipt.work_units !== verdict.work_units) return 'the receipt work units do not match the verdict';
  if (receipt.repair_items !== verdict.repair_brief.length) return 'the receipt repair count does not match the repair brief';

  if (!Array.isArray(verdict.gates) || verdict.gates.length !== GATES.length) return 'the verdict does not report every gate';
  if (!verdict.gates.every((entry, index) => entry.name === GATES[index] && typeof entry.passed === 'boolean')) {
    return 'the gate list is not the contract gate list';
  }
  const allPassed = verdict.gates.every((entry) => entry.passed);
  if (allPassed !== (verdict.status === SELECTED)) return 'the gate results do not explain the verdict status';
  if (verdict.status === SELECTED) {
    if (verdict.repair_brief.length !== 0) return 'a selected verdict carries repair items';
    if (verdict.checks.subject.length > 0 && verdict.scores.subject_ppm !== 1_000_000) {
      return 'a selected verdict does not pass every subject check';
    }
  }

  const predicates = verdict.checks.subject.length + verdict.checks.reference.length;
  if (predicates === 0 ? verdict.work_units !== 0 : verdict.work_units < predicates) {
    return 'the work units cannot account for the checks that were run';
  }
  return null;
}

/**
 * Re-derive a verdict from its fixture.
 *
 * Selection without this would trust a record's own claim about itself. With
 * it, a verdict can only be selected if the adapter can rebuild the same
 * request and the same verdict digest from the fixture — which is a statement
 * about reproducibility, not about who wrote the record.
 */
async function derivationFailure(verdict, fixture, context) {
  const rebuilt = await buildRequest(fixture, { subject: verdict.subject, ...context });
  if (isRefusal(rebuilt)) return `the fixture cannot rebuild the request (${rebuilt.code})`;
  if (rebuilt.request.request_sha256 !== verdict.request_sha256) {
    return 'the verdict binds a request this fixture does not produce';
  }
  const replayed = await evaluate(fixture, rebuilt.request);
  if (isRefusal(replayed)) return `the replay refused with ${replayed.code}`;
  if (replayed.verdict_sha256 !== verdict.verdict_sha256) {
    return 'the verdict does not reproduce from its fixture';
  }
  return null;
}

/**
 * Identity context for re-derivation.
 *
 * A request seals the `tenantId`/`actorId` the caller supplied, but the
 * verdict does not carry them back. Selection therefore accepts the same
 * context the request was built with, keyed by fixture id. Without an entry
 * the fixture defaults apply, which only reproduces requests built with them.
 * Unknown keys are refused: selection must not become an authority channel.
 */
function contextFor(contexts, fixtureId) {
  if (contexts === null || contexts === undefined) return { ok: true, context: {} };
  const entry = contexts instanceof Map ? contexts.get(fixtureId) : contexts[fixtureId];
  if (entry === undefined) return { ok: true, context: {} };
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return refusal('DGM_BAD_INPUT', `the context for ${JSON.stringify(fixtureId)} must be an object`);
  }
  for (const key of Object.keys(entry)) {
    if (key !== 'tenantId' && key !== 'actorId') {
      return refusal('DGM_BAD_INPUT', `a request context must not set ${JSON.stringify(key)}`);
    }
  }
  for (const key of ['tenantId', 'actorId']) {
    if (Object.hasOwn(entry, key) && (typeof entry[key] !== 'string' || entry[key].trim() === '')) {
      return refusal('DGM_BAD_INPUT', `a request context ${key} must be a non-empty string`);
    }
  }
  return { ok: true, context: { tenantId: entry.tenantId, actorId: entry.actorId } };
}

/**
 * Select at most one candidate from a bounded set of verdicts.
 *
 * Ordering is deterministic and total: highest candidate score, then lowest
 * work units, then lexicographic verdict digest. The digest tie-break exists so
 * that two equal-scoring candidates cannot produce an order-dependent result.
 */
export async function select(verdicts, {
  fixtures = null,
  contexts = null,
  baselineRevision = 'rev-2026-11-02-a',
  maxCandidates = MAX_CANDIDATES
} = {}) {
  if (!Array.isArray(verdicts)) {
    return refusal('DGM_BAD_INPUT', 'verdicts must be an array');
  }
  if (verdicts.length === 0) {
    return refusal('DGM_NO_CANDIDATES', 'no verdicts were supplied');
  }
  if (verdicts.length > maxCandidates) {
    return refusal('DGM_SELECTION_UNBOUNDED', `${verdicts.length} candidates exceed the bound of ${maxCandidates}`);
  }
  if (!Array.isArray(fixtures) || fixtures.length === 0) {
    return refusal('DGM_UNVERIFIED_SELECTION', 'selection requires the fixtures that produced these verdicts');
  }
  if (contexts !== null && contexts !== undefined
    && (typeof contexts !== 'object' || Array.isArray(contexts))) {
    return refusal('DGM_BAD_INPUT', 'contexts must map fixture ids to the identities their requests were built with');
  }
  const fixtureById = new Map(fixtures.map((fixture) => [fixture && fixture.id, fixture]));

  for (const verdict of verdicts) {
    if (!verdict || typeof verdict !== 'object' || Array.isArray(verdict)) {
      return refusal('DGM_VERDICT_TAMPERED', 'a verdict is not an object');
    }
    const checked = await verifySeal(verdict, 'verdict_sha256');
    if (!checked.ok) {
      return refusal('DGM_VERDICT_TAMPERED', `a verdict digest ${checked.reason}`);
    }
    if (verdict.applied !== false || verdict.authority !== AUTHORITY) {
      return refusal('DGM_AUTHORITY_VIOLATION', 'a verdict claims authority this adapter does not have');
    }
    if (!verdict.receipt) {
      return refusal('DGM_NO_RECEIPT', 'a verdict has no archive receipt');
    }
    const receipt = await verifySeal(verdict.receipt, 'receipt_sha256');
    if (!receipt.ok) {
      return refusal('DGM_RECEIPT_TAMPERED', `a receipt digest ${receipt.reason}`);
    }
    if (verdict.receipt.status !== verdict.status) {
      return refusal('DGM_RECEIPT_STATUS_MISMATCH', `a receipt says ${verdict.receipt.status} while its verdict says ${verdict.status}`);
    }
    const incoherent = coherenceFailure(verdict);
    if (incoherent) {
      return refusal('DGM_VERDICT_INCOHERENT', incoherent);
    }
    const fixture = verdict.provenance ? fixtureById.get(verdict.provenance.fixture_id) : null;
    if (!fixture) {
      return refusal('DGM_VERDICT_UNBOUND', `no fixture named ${verdict.provenance ? verdict.provenance.fixture_id : 'unknown'} was supplied`);
    }
    const identity = contextFor(contexts, fixture.id);
    if (!identity.ok) return identity;
    const unbound = await derivationFailure(verdict, fixture, identity.context);
    if (unbound) {
      return refusal('DGM_VERDICT_UNBOUND', unbound);
    }
  }

  const eligible = verdicts.filter((verdict) => verdict.status === SELECTED);
  const rejected = verdicts.filter((verdict) => verdict.status !== SELECTED);

  const ranked = [...eligible].sort((a, b) => {
    const scoreDiff = (b.scores.subject_ppm ?? -1) - (a.scores.subject_ppm ?? -1);
    if (scoreDiff !== 0) return scoreDiff;
    const workDiff = a.work_units - b.work_units;
    if (workDiff !== 0) return workDiff;
    return a.verdict_sha256 < b.verdict_sha256 ? -1 : a.verdict_sha256 > b.verdict_sha256 ? 1 : 0;
  });

  const winner = ranked[0] || null;
  const rollback = {
    action: 'restore-previous-revision',
    revision: baselineRevision,
    from: winner ? winner.provenance.subject_sha256 : null,
    to: winner ? winner.provenance.reference_sha256 : null,
    trigger: 'operator request, failed verification, or withdrawn mandate',
    applied: false
  };

  const body = {
    schema: SELECTION_SCHEMA,
    selection_id: null,
    authority: AUTHORITY,
    applied: false,
    bound: { candidates: verdicts.length, max_candidates: maxCandidates, within_bound: true },
    verification: {
      derivation: 'every verdict was rebuilt from its fixture and reproduced its digest',
      verified: verdicts.length,
      seals: 'unkeyed SHA-256: integrity and determinism only, not authentication'
    },
    considered: verdicts.map((verdict) => ({
      run_id: verdict.run_id,
      verdict_sha256: verdict.verdict_sha256,
      status: verdict.status,
      subject: verdict.subject,
      subject_ppm: verdict.scores.subject_ppm,
      work_units: verdict.work_units,
      repair_items: verdict.repair_brief.length
    })),
    ranked: ranked.map((verdict) => verdict.verdict_sha256),
    tie_break: 'highest subject score, then fewest work units, then verdict digest',
    ties: winner
      ? eligible.filter((verdict) => verdict.scores.subject_ppm === winner.scores.subject_ppm
        && verdict.work_units === winner.work_units).length
      : 0,
    selected: winner
      ? {
          run_id: winner.run_id,
          verdict_sha256: winner.verdict_sha256,
          fixture_id: winner.provenance.fixture_id,
          subject: winner.subject,
          subject_sha256: winner.provenance.subject_sha256,
          subject_ppm: winner.scores.subject_ppm
        }
      : null,
    rejected: rejected.map((verdict) => ({
      run_id: verdict.run_id,
      status: verdict.status,
      code: verdict.code
    })),
    rollback,
    note: winner
      ? 'recommendation only: nothing was applied, promoted, merged or executed'
      : 'no candidate passed every gate; nothing was applied'
  };

  const selectionId = idFromDigest('sel', await digestOf({ ...body, selection_id: null }), 32);
  const sealed = await seal({ ...body, selection_id: selectionId }, 'selection_sha256');
  return { ok: true, selection: sealed };
}

/** Verify a stored selection record. */
export async function verifySelection(selection) {
  const checked = await verifySeal(selection, 'selection_sha256');
  if (!checked.ok) return { ok: false, reason: `selection digest ${checked.reason}` };
  if (selection.applied !== false) return { ok: false, reason: 'selection claims to have been applied' };
  if (selection.authority !== AUTHORITY) return { ok: false, reason: 'selection claims foreign authority' };
  if (!selection.rollback || selection.rollback.applied !== false) {
    return { ok: false, reason: 'selection has no unapplied rollback plan' };
  }
  return { ok: true, selection_id: selection.selection_id };
}

/**
 * Build a rollback *request*. Returns a refusal if asked to perform it: this
 * adapter never restores revisions, it only names the restoration.
 */
export function requestRollback(selection, { reason = 'operator request' } = {}) {
  if (!selection || typeof selection !== 'object' || Array.isArray(selection) || selection.applied !== false) {
    return refusal('DGM_BAD_SELECTION', 'a verified, unapplied selection is required');
  }
  const plan = selection.rollback;
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)
    || typeof plan.action !== 'string'
    || typeof plan.revision !== 'string'
    || typeof plan.from !== 'string'
    || typeof plan.to !== 'string'
    || plan.applied !== false) {
    return refusal('DGM_BAD_SELECTION', 'the selection carries no unapplied rollback plan');
  }
  return {
    ok: true,
    applied: false,
    record: {
      kind: 'aipster.dsh-dgm.rollback-request/v1',
      selection_id: selection.selection_id,
      selection_sha256: selection.selection_sha256,
      action: selection.rollback.action,
      revision: selection.rollback.revision,
      from: selection.rollback.from,
      to: selection.rollback.to,
      reason: String(reason).slice(0, 512),
      executed: false,
      note: 'a human or the owning system performs this restoration; this adapter does not'
    }
  };
}
