/* Built with Meta Muse. */
// DGM fixture-preview API routes (flag-gated preview slice, default off).
// Mounts under /api/admin/v1/dgm/preview/* from src/admin/router.mjs, so the
// canonical-host guard, uniform denial, and existence-gated routing apply
// unchanged. Authorization is the site's session/grant pattern only
// (permission `admin.dgm.preview`); there are no operator tokens, no
// `?token=` URLs, and no new bindings — persistence is the existing D1 DB.
//
// Evaluation is the deterministic fixture table in ./preview.mjs: the Python
// DGM harness does not run in this Worker and nothing here implies it does.
// Every response carries `evaluation: 'fixture'` to say exactly that. What
// is real on this path: request handling, authorization, D1 run/event rows,
// audit rows, write-budget charging, and telemetry views derived live from
// stored events.
import { all, first, pageQuery, rid, nowIso } from '../lib/store.js';
import { readJson, pagination } from '../lib/validate.js';
import { checkWriteBudget } from '../lib/quotas.js';
import {
  PREVIEW_SCHEMA, RUN_SCHEMA, FIXTURE_TABLE, FIXTURES, RUN_STATUSES,
  TARGET_NAME, ENDPOINT_KIND, DISABLED_ACTIONS, MAX_LABEL_LEN,
  transition, creationStatus, evaluateFixture, checkCreateBody, isRefusal,
  fixtureTelemetryRows, transitionOutcomeRow, buildTelemetryView,
  latencySummary, tokensSummary, BASELINE_SCORE_PPM
} from './preview.mjs';

export const DGM_PREVIEW_PERMISSION = 'admin.dgm.preview';

// Live (paused) preview runs per operator. Terminal runs are unbounded:
// only re-holdable runs consume inspection slots. Enforced inside the
// mutating statement (never check-then-act), like the house object caps.
export const MAX_DGM_PREVIEW_LIVE_RUNS = 20;

const PREFIX = '/api/admin/v1/dgm/preview';

export function dgmPreviewEnabled(env) {
  return !!env && env.DGM_PREVIEW_ENABLED === '1';
}

function send(ctx, status, body) {
  return ctx.json(status, body);
}

function notFound() {
  // Authorized callers only: unauthorized callers are denied before routing.
  return { status: 404, body: { error: 'Preview run not found.', code: 'NOT_FOUND' } };
}

function mapRow(row) {
  return {
    schema: RUN_SCHEMA,
    evaluation: 'fixture',
    runId: row.id,
    taskId: row.task_id,
    fixture: row.fixture,
    held: Number(row.held) === 1,
    label: row.label,
    status: row.status,
    envelopeLabel: row.envelope_label,
    adviceReason: row.advice_reason,
    budgetFits: Number(row.budget_fits) === 1,
    budgetReason: row.budget_reason,
    settlement: row.settlement,
    gates: JSON.parse(row.gates_json),
    provenance: JSON.parse(row.provenance_json),
    binding: { target: row.target, endpointKind: ENDPOINT_KIND },
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function eventList(rows) {
  // The budget/event trace: stored telemetry.* rows are excluded here (they
  // feed the telemetry view instead). Sequences are response order, which
  // matches verdict numbering: verdict events, preview.created, transitions.
  const items = [];
  for (const row of rows || []) {
    if (typeof row.event === 'string' && row.event.startsWith('telemetry.')) continue;
    let detail = '';
    try {
      const body = JSON.parse(row.body_json);
      if (body && typeof body.detail === 'string') detail = body.detail;
    } catch { /* unparseable detail renders empty; the telemetry view counts it */ }
    items.push({ sequence: items.length, event: row.event, detail });
  }
  return items;
}

function unavailableTelemetry(candidateScorePpm) {
  // Failure isolation: when the events read itself fails, the run still
  // answers with an explicit unavailable-telemetry block — never zeros, never
  // a failed run read.
  return {
    env: 'fixture',
    baselineScorePpm: BASELINE_SCORE_PPM,
    candidateScorePpm: candidateScorePpm === undefined ? null : candidateScorePpm,
    readStatus: 'unavailable',
    freshnessNote: 'unavailable',
    missing: [],
    stale: [],
    unparsedRows: 0,
    outcomeCounts: {},
    latencySummary: latencySummary([]),
    tokensSummary: tokensSummary([])
  };
}

async function fullRun(db, row) {
  const mapped = mapRow(row);
  let rows = null;
  try {
    rows = await all(db, 'SELECT event, body_json FROM dgm_preview_events WHERE run_id = ? ORDER BY seq ASC', row.id);
  } catch {
    return { ...mapped, events: [], telemetry: unavailableTelemetry(mapped.provenance.candidateScorePpm) };
  }
  return {
    ...mapped,
    events: eventList(rows),
    telemetry: buildTelemetryView(row.id, rows, mapped.provenance.candidateScorePpm)
  };
}

function liveCapSql() {
  return `(SELECT COUNT(*) FROM dgm_preview_runs WHERE created_by = ? AND status = 'paused') < ${MAX_DGM_PREVIEW_LIVE_RUNS}`;
}

function eventInsert(db, runId, seq, at, event, body) {
  // Chained on changes() = 1: events commit only with their run write, so a
  // lost race (live cap, concurrent transition) leaves zero partial rows.
  return db.prepare(
    'INSERT INTO dgm_preview_events (run_id, seq, at, event, body_json) SELECT ?, ?, ?, ?, ? WHERE changes() = 1'
  ).bind(runId, seq, at, event, JSON.stringify(body));
}

function auditInsert(db, now, actorId, action, target, detail) {
  return db.prepare(
    'INSERT INTO audit (id, at, actor_id, action, target, detail) SELECT ?, ?, ?, ?, ?, ? WHERE changes() = 1'
  ).bind(rid('a_'), now, actorId, action, target, detail);
}

async function createRun(ctx) {
  const gate = await ctx.requireAdmin(DGM_PREVIEW_PERMISSION);
  if (gate.status) return send(ctx, gate.status, gate.body);
  const csrf = ctx.needCsrf();
  if (csrf) return csrf;
  let raw;
  try {
    raw = await readJson(ctx.request);
  } catch (error) {
    if (error && error.status) return send(ctx, error.status, { error: error.message, code: error.code || 'BAD_REQUEST' });
    throw error;
  }
  const checked = checkCreateBody(raw);
  if (isRefusal(checked)) return send(ctx, 400, { error: checked.detail, code: checked.reason });
  const { fixture, held, label, target } = checked.body;
  const verdict = evaluateFixture(fixture);
  const status = creationStatus(verdict.status, held);
  await checkWriteBudget(ctx.db, ctx.actor.user.id);
  const now = nowIso();
  const id = rid('run_v1_');
  const taskId = rid('task_v1_');
  const me = ctx.actor.user.id;
  const traceEvents = [
    ...verdict.events.map((e) => ({ event: e.event, body: { detail: e.detail } })),
    { event: 'preview.created', body: { detail: `fixture=${fixture} held=${held ? 'true' : 'false'}` } }
  ];
  const telemetryEvents = fixtureTelemetryRows(status);
  const stored = [...traceEvents, ...telemetryEvents];
  const out = await ctx.db.batch([
    ctx.db.prepare(
      `INSERT INTO dgm_preview_runs (id, task_id, created_by, fixture, held, label, target, status,
        envelope_label, advice_reason, budget_fits, budget_reason, settlement,
        gates_json, provenance_json, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE ? != 'paused' OR ${liveCapSql()}`
    ).bind(id, taskId, me, fixture, held ? 1 : 0, label, target, status,
      verdict.envelopeLabel, verdict.adviceReason, verdict.budgetFits ? 1 : 0,
      verdict.budgetReason, verdict.settlement,
      JSON.stringify(verdict.gates), JSON.stringify(verdict.provenance), now, now,
      status, me),
    ...stored.map((r, seq) => eventInsert(ctx.db, id, seq, now, r.event, r.body)),
    auditInsert(ctx.db, now, me, 'dgm.preview.create', id, `fixture=${fixture} status=${status}`)
  ]);
  if (Number(out[0].meta.changes) !== 1) {
    // The live-cap fence is the only condition on the insert; re-read to
    // name the outcome honestly rather than assume the race.
    const live = await first(ctx.db,
      'SELECT COUNT(*) AS n FROM dgm_preview_runs WHERE created_by = ? AND status = ?',
      me, 'paused');
    if (live && Number(live.n) >= MAX_DGM_PREVIEW_LIVE_RUNS) {
      return send(ctx, 409, {
        error: `Too many live (paused) preview runs (${MAX_DGM_PREVIEW_LIVE_RUNS} per operator). Resume or cancel one first.`,
        code: 'DGM_LIVE_CAP'
      });
    }
    return send(ctx, 500, { error: 'Request failed.', code: 'INTERNAL' });
  }
  const row = await first(ctx.db, 'SELECT * FROM dgm_preview_runs WHERE id = ?', id);
  return send(ctx, 201, await fullRun(ctx.db, row));
}

async function controlRun(ctx, runId, action) {
  const gate = await ctx.requireAdmin(DGM_PREVIEW_PERMISSION);
  if (gate.status) return send(ctx, gate.status, gate.body);
  const csrf = ctx.needCsrf();
  if (csrf) return csrf;
  const current = await first(ctx.db, 'SELECT * FROM dgm_preview_runs WHERE id = ?', runId);
  if (!current) {
    const out = notFound();
    return send(ctx, out.status, out.body);
  }
  const next = transition(current.status, action);
  if (isRefusal(next)) return send(ctx, 409, { error: next.detail, code: next.reason });
  await checkWriteBudget(ctx.db, ctx.actor.user.id);
  const now = nowIso();
  const me = ctx.actor.user.id;
  const outcomeRow = transitionOutcomeRow(next);
  // Pause re-holds into the capped live set; resume/cancel leave it.
  const capFence = next === 'paused' ? ` AND ${liveCapSql()}` : '';
  const binds = next === 'paused' ? [next, now, runId, current.status, me] : [next, now, runId, current.status];
  const last = await first(ctx.db, 'SELECT COALESCE(MAX(seq), -1) AS m FROM dgm_preview_events WHERE run_id = ?', runId);
  const base = Number(last ? last.m : -1) + 1;
  const stmts = [
    ctx.db.prepare(
      `UPDATE dgm_preview_runs SET status = ?, updated_at = ? WHERE id = ? AND status = ?${capFence}`
    ).bind(...binds),
    eventInsert(ctx.db, runId, base, now, `preview.${action}d`, { detail: `${current.status}->${next}` })
  ];
  if (outcomeRow) stmts.push(eventInsert(ctx.db, runId, base + 1, now, outcomeRow.event, outcomeRow.body));
  stmts.push(auditInsert(ctx.db, now, me, `dgm.preview.${action}`, runId, `${current.status}->${next}`));
  const out = await ctx.db.batch(stmts);
  if (Number(out[0].meta.changes) !== 1) {
    const reread = await first(ctx.db, 'SELECT status FROM dgm_preview_runs WHERE id = ?', runId);
    if (!reread) {
      const nf = notFound();
      return send(ctx, nf.status, nf.body);
    }
    if (reread.status !== current.status) {
      return send(ctx, 409, {
        error: `Preview run changed concurrently; refresh and retry (now ${JSON.stringify(reread.status)}).`,
        code: 'DGM_PREVIEW_STATE'
      });
    }
    if (next === 'paused') {
      const live = await first(ctx.db,
        'SELECT COUNT(*) AS n FROM dgm_preview_runs WHERE created_by = ? AND status = ?',
        me, 'paused');
      if (live && Number(live.n) >= MAX_DGM_PREVIEW_LIVE_RUNS) {
        return send(ctx, 409, {
          error: `Too many live (paused) preview runs (${MAX_DGM_PREVIEW_LIVE_RUNS} per operator). Resume or cancel one first.`,
          code: 'DGM_LIVE_CAP'
        });
      }
    }
    return send(ctx, 500, { error: 'Request failed.', code: 'INTERNAL' });
  }
  const row = await first(ctx.db, 'SELECT * FROM dgm_preview_runs WHERE id = ?', runId);
  return send(ctx, 200, await fullRun(ctx.db, row));
}

async function disabledAction(ctx, action) {
  // Always refused before any run lookup: unknown ids answer identically.
  // No budget charge, no audit row, no state change of any kind.
  const gate = await ctx.requireAdmin(DGM_PREVIEW_PERMISSION);
  if (gate.status) return send(ctx, gate.status, gate.body);
  const csrf = ctx.needCsrf();
  if (csrf) return csrf;
  return send(ctx, 501, {
    error: `DGM preview ${action} is not available: ${DISABLED_ACTIONS[action]}.`,
    code: 'ADMIN_NOT_IMPLEMENTED'
  });
}

const ID = '([A-Za-z0-9_-]{1,64})';

export async function handleDgmPreview(ctx) {
  // Returns a Response, or null when the slice is disabled so the caller
  // falls through to the admin unknown-route gate (dark by default).
  if (!dgmPreviewEnabled(ctx.env)) return null;
  const { request, url } = ctx;
  const path = url.pathname;
  const method = request.method;

  if (path === `${PREFIX}/status` && method === 'GET') {
    const gate = await ctx.requireAdmin(DGM_PREVIEW_PERMISSION);
    if (gate.status) return send(ctx, gate.status, gate.body);
    const count = await first(ctx.db, 'SELECT COUNT(*) AS n FROM dgm_preview_runs');
    return send(ctx, 200, {
      schema: PREVIEW_SCHEMA,
      evaluation: 'fixture',
      fixtureTable: FIXTURE_TABLE,
      binding: { state: 'active', target: TARGET_NAME, endpointKind: ENDPOINT_KIND, evaluation: 'fixture' },
      fixtures: [...FIXTURES],
      states: [...RUN_STATUSES],
      runs: Number(count ? count.n : 0),
      maxLiveRunsPerOperator: MAX_DGM_PREVIEW_LIVE_RUNS,
      maxLabelChars: MAX_LABEL_LEN,
      observedAt: nowIso()
    });
  }
  if (path === `${PREFIX}/runs` && method === 'POST') return createRun(ctx);
  if (path === `${PREFIX}/runs` && method === 'GET') {
    const gate = await ctx.requireAdmin(DGM_PREVIEW_PERMISSION);
    if (gate.status) return send(ctx, gate.status, gate.body);
    const q = pagination(url);
    const page = await pageQuery(ctx.db, {
      select: 'SELECT id, fixture, status, envelope_label, created_at',
      from: 'FROM dgm_preview_runs',
      params: [],
      order: 'ORDER BY created_at DESC, id DESC',
      ...q
    });
    return send(ctx, 200, {
      evaluation: 'fixture',
      ...page,
      items: page.items.map((r) => ({
        runId: r.id, fixture: r.fixture, status: r.status,
        envelopeLabel: r.envelope_label, createdAt: r.created_at
      }))
    });
  }
  {
    const m = new RegExp(`^${PREFIX}/runs/${ID}$`).exec(path);
    if (m && method === 'GET') {
      const gate = await ctx.requireAdmin(DGM_PREVIEW_PERMISSION);
      if (gate.status) return send(ctx, gate.status, gate.body);
      const row = await first(ctx.db, 'SELECT * FROM dgm_preview_runs WHERE id = ?', m[1]);
      if (!row) {
        const out = notFound();
        return send(ctx, out.status, out.body);
      }
      return send(ctx, 200, await fullRun(ctx.db, row));
    }
  }
  {
    const m = new RegExp(`^${PREFIX}/runs/${ID}/(pause|resume|cancel)$`).exec(path);
    if (m && method === 'POST') return controlRun(ctx, m[1], m[2]);
  }
  {
    const m = new RegExp(`^${PREFIX}/runs/${ID}/(promote|execute|reserve|final-audit|advise-live)$`).exec(path);
    if (m && method === 'POST') return disabledAction(ctx, m[2]);
  }
  // Unknown preview paths deny before revealing routing, like the admin 404.
  const gate = await ctx.requireAdmin(DGM_PREVIEW_PERMISSION);
  if (gate.status) return send(ctx, gate.status, gate.body);
  return send(ctx, 404, { error: 'Unknown preview route.', code: 'NOT_FOUND' });
}
