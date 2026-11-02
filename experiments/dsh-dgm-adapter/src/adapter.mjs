// Upstream adapter: dsh-superagent-shaped records -> sealed DGM evaluation
// request.
//
// The shapes here mirror the *documented* upstream domain model
// (docs/001-domain.md, docs/002-authorization.md, docs/003-execution.md) and the
// proposal shape the Muse harness already emits (watchdog.mjs:52-59:
// {problem, change, verification}). Nothing in this module imports, executes
// or connects to dsh-superagent or DeepSeek Harness.

import { digestOf, seal } from './canonical.mjs';
import {
  ADAPTER_SCHEMA,
  MODULE_ID,
  MODULE_VERSION,
  REQUEST_SCHEMA,
  WORK_ITEM_SCHEMA,
  EVALUATION_KIND,
  AUTHORITY,
  MAX_TEXT,
  refusal
} from './contract.mjs';

export const ALLOWED_INPUT_KEYS = Object.freeze(['workItemId', 'reportState', 'tamper']);

function shortText(value, limit = MAX_TEXT) {
  return typeof value === 'string' ? value.slice(0, limit) : '';
}

/**
 * The authoritative admission envelope, derived from the fixture's own budget.
 *
 * This is the single source of truth for the envelope gate. A request carries a
 * copy of these constraints so a reader can see what was evaluated, but the copy
 * is never trusted: `evaluate()` re-derives from here and refuses a request whose
 * thresholds disagree. Without that, a re-sealed request could widen its own
 * budget (seals are unkeyed, so re-sealing is not a barrier).
 */
export function fixtureConstraints(workItem) {
  const budget = workItem && workItem.budget;
  if (!budget || typeof budget !== 'object' || Array.isArray(budget)) {
    return refusal('DGM_BAD_FIXTURE_BUDGET', 'the fixture declares no budget object');
  }
  for (const field of ['max_work_units', 'max_repairs']) {
    if (!Number.isInteger(budget[field]) || budget[field] < 0) {
      return refusal('DGM_BAD_FIXTURE_BUDGET', `budget.${field} must be a non-negative integer`);
    }
  }
  return {
    ok: true,
    constraints: [
      { name: 'work_units', definition_version: 'fixture-checks/v1', unit: 'predicate', operator: '<=', threshold: budget.max_work_units },
      { name: 'repair_items', definition_version: 'fixture-checks/v1', unit: 'check', operator: '<=', threshold: budget.max_repairs }
    ]
  };
}

/** Stable identity for everything a request binds: fixture, ticket, artifacts, criteria. */
export async function fixtureIdentity(workItem) {
  return digestOf({
    schema: workItem.schema,
    id: workItem.id,
    source: workItem.source,
    issue: workItem.issue,
    ticket: workItem.ticket,
    proposal: workItem.proposal,
    criteria: workItem.criteria,
    artifact: workItem.artifact,
    candidate: workItem.candidate,
    budget: workItem.budget
  });
}

/** Project an upstream Ticket into the small, explicit surface this adapter reads. */
export function projectTicket(ticket) {
  if (!ticket || typeof ticket !== 'object') return null;
  return {
    ticket_id: shortText(ticket.id, 128),
    title: shortText(ticket.title, 256),
    mandate: ticket.mandate
      ? {
          strength: shortText(ticket.mandate.strength, 32),
          policy_version: shortText(ticket.mandate.policy_version, 128),
          scope: shortText(ticket.mandate.scope, 512)
        }
      : null,
    report_state: shortText(ticket.report && ticket.report.state, 32),
    report_summary: shortText(ticket.report && ticket.report.summary, 1024),
    accept_mode: shortText(ticket.accept_mode, 32),
    ended: Boolean(ticket.ended)
  };
}

/**
 * Eligibility follows the upstream stage table (docs/003-execution.md:7-19):
 * a ready report is reviewable; blocked/failed and ended tickets are not.
 * A weak (inferred) mandate is refused unless the policy is in auto mode, the
 * same condition upstream applies before an inferred accept.
 */
export function eligibility(projected, { reportState } = {}) {
  if (!projected) return { ok: false, code: 'DGM_NO_TICKET', detail: 'no upstream ticket was supplied' };
  const state = reportState || projected.report_state;
  if (projected.ended) return { ok: false, code: 'DGM_TICKET_ENDED', detail: 'the ticket is ended' };
  if (!projected.mandate) return { ok: false, code: 'DGM_NO_MANDATE', detail: 'the ticket has no mandate' };
  if (projected.mandate.strength === 'inferred' && projected.accept_mode !== 'auto') {
    return { ok: false, code: 'DGM_MANDATE_WEAK', detail: 'an inferred mandate needs auto mode' };
  }
  if (!['explicit', 'inferred'].includes(projected.mandate.strength)) {
    return { ok: false, code: 'DGM_BAD_MANDATE', detail: 'unsupported mandate strength' };
  }
  if (state === 'blocked' || state === 'failed') {
    return { ok: false, code: 'DGM_REPORT_NOT_REVIEWABLE', detail: `report state is ${state}` };
  }
  if (state !== 'ready') {
    return { ok: false, code: 'DGM_NOT_READY', detail: `report state is ${state || 'unknown'}` };
  }
  return { ok: true };
}

function validateInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return refusal('DGM_BAD_INPUT', 'input must be an object');
  }
  for (const key of Object.keys(input)) {
    if (!ALLOWED_INPUT_KEYS.includes(key)) {
      return refusal('DGM_OVERRIDE', `browser input must not set ${JSON.stringify(key)}`);
    }
  }
  return { ok: true };
}

/**
 * Build and seal an evaluation request.
 *
 * Returns `{ ok:true, request }` or `{ ok:false, code, detail }`. A refusal is
 * an honest non-result, never an empty verdict.
 */
export async function buildRequest(workItem, {
  tenantId = 'fixture-tenant',
  actorId = 'fixture-operator',
  reportState,
  subject = 'candidate',
  tamper = null
} = {}) {
  if (!workItem || workItem.schema !== WORK_ITEM_SCHEMA) {
    return { ok: false, code: 'DGM_UNKNOWN_FIXTURE', detail: 'work item schema is not recognised' };
  }
  if (subject !== 'candidate' && subject !== 'baseline') {
    return { ok: false, code: 'DGM_BAD_INPUT', detail: 'subject must be candidate or baseline' };
  }
  const projected = projectTicket(workItem.ticket);
  const eligible = eligibility(projected, { reportState });
  if (!eligible.ok) return eligible;

  if (!Array.isArray(workItem.criteria) || workItem.criteria.length === 0) {
    return { ok: false, code: 'DGM_NO_CRITERIA', detail: 'the fixture has no acceptance criteria' };
  }

  const envelope = fixtureConstraints(workItem);
  if (!envelope.ok) return envelope;

  const candidateArtifact = tamper === 'candidate'
    ? { ...workItem.candidate, tampered: 'post-seal mutation' }
    : workItem.candidate;

  const [fixtureSha, baselineSha, candidateSha, criteriaSha] = await Promise.all([
    fixtureIdentity(workItem),
    digestOf(workItem.artifact),
    digestOf(candidateArtifact),
    digestOf(workItem.criteria)
  ]);

  const request = await seal({
    schema: REQUEST_SCHEMA,
    module: { id: MODULE_ID, version: MODULE_VERSION },
    tenant_id: tenantId,
    actor_id: actorId,
    subject,
    target: {
      kind: 'dsh-ticket',
      name: projected.ticket_id,
      source: workItem.source,
      issue_number: workItem.source.number
    },
    upstream: {
      ticket: projected,
      proposal: {
        problem: shortText(workItem.proposal && workItem.proposal.problem, 1024),
        change: shortText(workItem.proposal && workItem.proposal.change, 1024),
        verification: shortText(workItem.proposal && workItem.proposal.verification, 1024)
      }
    },
    snapshot: {
      environment: EVALUATION_KIND,
      fixture_id: workItem.id,
      fixture_sha256: fixtureSha,
      criteria_sha256: criteriaSha
    },
    baseline: { kind: 'agent-change-bundle/v1', identity: `baseline:${workItem.id}`, sha256: baselineSha },
    candidate: { kind: 'agent-change-bundle/v1', identity: `candidate:${workItem.id}`, sha256: candidateSha },
    metrics: [
      { name: 'criteria_pass_ppm', definition_version: 'fixture-checks/v1', unit: 'ppm', direction: 'higher' },
      { name: 'work_units', definition_version: 'fixture-checks/v1', unit: 'predicate', direction: 'lower' },
      { name: 'repair_items', definition_version: 'fixture-checks/v1', unit: 'check', direction: 'lower' }
    ],
    constraints: envelope.constraints,
    authority: AUTHORITY,
    evaluation: EVALUATION_KIND
  }, 'request_sha256');

  return { ok: true, request };
}

/** Convenience wrapper for the Muse harness proposal shape (no imports across worktrees). */
export async function fromHarnessProposal(proposal, { workItem, tenantId, actorId, reportState } = {}) {
  if (!workItem) return { ok: false, code: 'DGM_NO_FIXTURE', detail: 'a fixture is required' };
  const merged = {
    ...workItem,
    proposal: {
      problem: shortText(proposal && proposal.problem, 1024),
      change: shortText(proposal && proposal.change, 1024),
      verification: shortText(proposal && proposal.verification, 1024)
    }
  };
  const built = await buildRequest(merged, { tenantId, actorId, reportState });
  // The seal names the merged fixture, so return it: evaluating the caller's
  // original work item would fail the identity check even though the request
  // is genuine. `fixture` is the object to evaluate and to pass to selection.
  return built.ok ? { ...built, fixture: merged } : built;
}

export { validateInput };
