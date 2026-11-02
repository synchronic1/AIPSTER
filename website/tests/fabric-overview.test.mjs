/* Built with Meta Muse. Exact-client probe for the Overview Fabric flow +
 * throughput panels: loads the checked-in public/app/app.js in a stub DOM
 * (same pattern as ui-heartbeat.test.mjs) and asserts the wired behavior —
 * server property names/shapes, denied + session-change clearing, stale and
 * unknown heartbeat semantics, escaped labels, empty/loading/error states,
 * absent-vs-zero, and an always-unavailable measured-throughput bench.
 * Provenance: EIF labels adapted (not copied) from upstream
 * elastic-inference-fabric review/optimizations @3eb46cdd (FabricTopology
 * flow/legend, BenchDiagram throughput). No EIF auth, endpoints, identities,
 * or fixture metrics reused. */
import vm from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseFragment } from 'parse5';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Disposable-fixture override for the guard-discrimination diagnostic only:
// FABRIC_APP_JS points loadClient at a temp copy of app.js (never committed).
const APP_JS = process.env.FABRIC_APP_JS || path.resolve(HERE, '..', 'public', 'app', 'app.js');
const APP_HTML = path.resolve(HERE, '..', 'public', 'app', 'index.html');
const APP_CSS = path.resolve(HERE, '..', 'public', 'app', 'styles.css');

async function loadClient(router) {
  const source = await readFile(APP_JS, 'utf8');
  const elements = new Map();
  function el(id) {
    if (!elements.has(id)) {
      elements.set(id, {
        id, hidden: false, textContent: '', innerHTML: '', value: '', attrs: {}, listeners: {}, dataset: {},
        addEventListener(type, fn) { this.listeners[type] = fn; },
        setAttribute(name, value) { this.attrs[name] = value; },
        querySelectorAll() { return []; },
      });
    }
    return elements.get(id);
  }
  const names = ['overview', 'compute', 'shared', 'sharing', 'keys', 'usage', 'settings'];
  const tabs = names.map((name) => { const e = el('nav-' + name); e.dataset.tab = name; return e; });
  const context = vm.createContext({
    document: { getElementById: el, querySelectorAll(sel) { return sel === '[data-tab]' ? tabs : sel === '[role="tabpanel"]' ? names.map((n) => el('tab-' + n)) : []; } },
    location: { origin: 'http://localhost:8787', pathname: '/app/', search: '', assign() {} },
    fetch: async (p, o) => router(p, o),
    setTimeout() { return 0; }, console, URLSearchParams,
    history: { replaceState() {} },
  });
  await new vm.Script(source, { filename: 'exact-client.js' }).runInContext(context);
  await new Promise(setImmediate);
  assert.equal(typeof context.renderFabricFlow, 'function', 'client exposes renderFabricFlow');
  assert.equal(typeof context.loadFabricFlow, 'function', 'client exposes loadFabricFlow');
  return { context, el };
}

const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const item = (over = {}) => ({
  id: 'r_1', name: 'lab', kind: 'local', liveness: 'online',
  lastSeenAt: iso(NOW - 1000), lastSeenAgeMs: 1000, usable: true, demoFixture: false, ...over,
});
const statusPayload = (items, over = {}) => ({
  schema: 'aipster.status/1', generatedAt: iso(NOW), demo: false,
  source: 'declared-resources', telemetry: 'unavailable',
  summary: { total: items.length, online: items.length, stale: 0, offline: 0, unknown: 0 },
  total: items.length, itemsTruncated: false, sharedWithMe: 0, items, ...over,
});
const usagePayload = (totals, over = {}) => ({
  items: [], total: 0, limit: 50, offset: 0,
  totals: totals || { requests: 12, tokensIn: 300, tokensOut: 150, modelCostUsd: null, executionCostUsd: 2.5 },
  note: 'Model cost and execution cost are tracked separately. Unmeasured values stay null (unknown).',
  ...over,
});
const okRouter = (status, usage) => async (p) => {
  if (p === '/api/status') return Response.json(status);
  if (p === '/api/usage?limit=50') return Response.json(usage);
  if (p === '/api/inventory?limit=50') return Response.json({ items: [], total: 0 });
  if (p === '/api/shared-with-me?limit=50') return Response.json({ items: [], total: 0 });
  if (p === '/api/catalog/summary') return Response.json({ privateAssets: 0, activeDeployments: 0 });
  return Response.json({ items: [], total: 0 });
};
const render = (context, el, status, usage, inv) => {
  const flow = el('fabric-flow'), tp = el('fabric-throughput');
  context.renderFabricFlow(flow, tp, status, usage === undefined ? usagePayload() : usage, inv);
  return { flow: flow.innerHTML, tp: tp.innerHTML };
};
const invCard = (over = {}) => ({
  id: 'r_1', name: 'lab', kind: 'local', origin: 'home lab',
  owner: { id: 'u_1', name: 'owner' },
  compute: { cpu: '16-core x86', gpu: 'none recorded' }, capabilities: ['text'],
  state: { configured: true, authenticated: true, online: true, usable: true, status: 'reachable' },
  heartbeatAt: iso(NOW - 1000), limits: {}, scope: 'owner',
  verification: {}, credits: null, createdAt: iso(NOW - 1000), ...over,
});

test('flow panel renders nodes, counts, architectural lanes, and honest copy', async () => {
  const { context, el } = await loadClient(okRouter(statusPayload([item()]), usagePayload()));
  const { flow, tp } = render(context, el, statusPayload([item()]), usagePayload());
  assert.ok(flow.includes('1 resource(s)'), flow);
  assert.ok(flow.includes('reachability only'), flow);
  assert.ok(flow.includes('dispatch availability unverified'), flow);
  assert.ok(flow.includes('usage totals only'), flow);
  assert.ok(flow.includes('unsupported'), flow);
  assert.ok(!/ready to run/i.test(flow.replace(/not ready to run|nothing here means ready to run/gi, '')), 'no ready presentation');
  assert.ok(tp.includes('cumulative, not a rate'), tp);
  assert.ok(tp.includes('Throughput unavailable'), tp);
  assert.ok(tp.includes('never zero'), tp);
});

test('stale rows show stale, never live; bare online claims without timestamps drop to unknown', async () => {
  const { context, el } = await loadClient(okRouter(statusPayload([]), usagePayload()));
  const stale = item({ id: 'r_st', liveness: 'stale', lastSeenAt: iso(NOW - 10 * 60 * 1000), lastSeenAgeMs: 10 * 60 * 1000 });
  const bare = item({ id: 'r_bare', liveness: 'online', lastSeenAt: null, lastSeenAgeMs: null });
  const { flow } = render(context, el, statusPayload([stale, bare], { summary: { total: 2, online: 0, stale: 1, offline: 0, unknown: 1 } }), usagePayload());
  assert.ok(flow.includes('>stale<'), flow);
  assert.ok(flow.includes('>unknown<'), flow);
  assert.ok(!flow.includes('>online<'), 'no live pill from a bare historical timestamp');
});

test('hostile names render as text, never markup', async () => {
  const { context, el } = await loadClient(okRouter(statusPayload([]), usagePayload()));
  const evil = { id: 'r_evil', name: '<b id="fabric-injected">injected</b>', kind: 'local', liveness: 'online', lastSeenAt: iso(NOW - 10), lastSeenAgeMs: 10, usable: true, demoFixture: false };
  const { flow } = render(context, el, statusPayload([evil]), usagePayload());
  const doc = parseFragment(flow);
  const has = (n) => (n.attrs || []).some((a) => a.name === 'id' && a.value === 'fabric-injected') || (n.childNodes || []).some(has);
  assert.ok(!has(doc), `BUG: name became markup: ${flow}`);
});

test('denied reads clear both panels and leak no resource data', async () => {
  const denied = async (p) => (p === '/api/status' || p === '/api/usage?limit=50')
    ? Response.json({ error: 'Forbidden', code: 'KEY_SCOPE' }, { status: 403 })
    : Response.json({ items: [], total: 0 });
  const { context, el } = await loadClient(denied);
  await context.loadFabricFlow();
  const flow = el('fabric-flow').innerHTML, tp = el('fabric-throughput').innerHTML;
  assert.ok(flow.includes('fabric flow unavailable'), flow);
  assert.ok(tp.includes('denied'), tp);
  assert.ok(!flow.includes('r_1') && !tp.includes('r_1'), 'no resource data in denied shells');
});

test('empty inventory and missing usage render honest unavailable states', async () => {
  const { context, el } = await loadClient(okRouter(statusPayload([]), usagePayload()));
  const noUsage = render(context, el, statusPayload([]), null);
  assert.ok(noUsage.flow.includes('No resources yet'), noUsage.flow);
  assert.ok(noUsage.tp.includes('Usage totals unavailable'), noUsage.tp);
  assert.ok(noUsage.tp.includes('Throughput unavailable'), noUsage.tp);
  const bad = render(context, el, { bogus: true }, usagePayload());
  assert.ok(bad.flow.includes('unexpected status payload'), bad.flow);
});

test('absent costs stay unknown, never zero', async () => {
  const { context, el } = await loadClient(okRouter(statusPayload([item()]), usagePayload()));
  const { tp } = render(context, el, statusPayload([item()]), usagePayload({ requests: 0, tokensIn: 0, tokensOut: 0, modelCostUsd: null, executionCostUsd: null }));
  assert.ok(tp.includes('unknown (unmeasured)'), tp);
  assert.ok(!tp.includes('$0'), 'no zero-filled costs');
});

test('loading shells show first; a tab switch drops the stale first response', async () => {
  let release;
  const held = new Promise((r) => { release = r; });
  // Ordinal capture BEFORE the await: the first pair of reads belongs to the
  // stale generation even though both pairs resolve after release.
  let statusCalls = 0, usageCalls = 0;
  const first = statusPayload([item({ id: 'r_first', name: 'first-render' })]);
  const second = statusPayload([item({ id: 'r_second', name: 'second-render' })]);
  const router = async (p) => {
    if (p === '/api/status') {
      const n = (statusCalls += 1);
      if (n === 1) await held;
      return Response.json(n === 1 ? first : second);
    }
    if (p === '/api/usage?limit=50') {
      const n = (usageCalls += 1);
      if (n === 1) await held;
      return Response.json(usagePayload());
    }
    if (p === '/api/inventory?limit=50') return Response.json({ items: [], total: 0 });
    if (p === '/api/shared-with-me?limit=50') return Response.json({ items: [], total: 0 });
    if (p === '/api/catalog/summary') return Response.json({ privateAssets: 0, activeDeployments: 0 });
    return Response.json({ items: [], total: 0 });
  };
  const { context, el } = await loadClient(router);
  const pending = context.loadFabricFlow();
  assert.ok(el('fabric-flow').innerHTML.includes('Loading fabric flow'), 'loading shell first');
  el('nav-overview').listeners.click();
  release(); await pending;
  await new Promise((r) => setTimeout(r, 10));
  const flow = el('fabric-flow').innerHTML;
  assert.ok(flow.includes('second-render'), flow);
  assert.ok(!flow.includes('first-render'), 'stale first response dropped after session change');
});

test('resetState clears fabric panels on logout and account switch', async () => {
  const { context, el } = await loadClient(okRouter(statusPayload([item()]), usagePayload()));
  render(context, el, statusPayload([item()]), usagePayload());
  assert.ok(el('fabric-flow').innerHTML.length > 0);
  context.resetState();
  assert.equal(el('fabric-flow').innerHTML, '');
  assert.equal(el('fabric-throughput').innerHTML, '');
});

test('overview markup carries labelled fabric sections with live regions', async () => {
  const html = await readFile(APP_HTML, 'utf8');
  const doc = parseFragment(html);
  const byId = {};
  const visit = (n) => { const id = (n.attrs || []).find((a) => a.name === 'id'); if (id) byId[id.value] = n; (n.childNodes || []).forEach(visit); if (n.content) visit(n.content); };
  visit(doc);
  for (const id of ['fabric-flow-panel', 'fabric-flow-h', 'fabric-flow', 'fabric-throughput-panel', 'fabric-throughput-h', 'fabric-throughput']) {
    assert.ok(byId[id], `missing #${id} in overview markup`);
  }
  const labelled = (panel, head) => (byId[panel].attrs || []).some((a) => a.name === 'aria-labelledby' && a.value === head);
  assert.ok(labelled('fabric-flow-panel', 'fabric-flow-h'));
  assert.ok(labelled('fabric-throughput-panel', 'fabric-throughput-h'));
  const live = (id) => (byId[id].attrs || []).some((a) => a.name === 'role' && a.value === 'status');
  assert.ok(live('fabric-flow') && live('fabric-throughput'));
});

test('FINDING-1: usage totals state page coverage, never universe totals', async () => {
  const { context, el } = await loadClient(okRouter(statusPayload([item()]), usagePayload()));
  const page = render(context, el, statusPayload([item()]),
    usagePayload({ requests: 5, tokensIn: 50, tokensOut: 25, modelCostUsd: null, executionCostUsd: null },
      { items: [{ id: 'u_1' }, { id: 'u_2' }], total: 9 }));
  assert.ok(page.tp.includes('page-cumulative'), page.tp);
  assert.ok(page.tp.includes('2 of 9'), page.tp);
  const full = render(context, el, statusPayload([item()]),
    usagePayload({ requests: 5, tokensIn: 50, tokensOut: 25, modelCostUsd: null, executionCostUsd: null },
      { items: [{ id: 'u_1' }], total: 1 }));
  assert.ok(full.tp.includes('totals cover all 1 rows'), full.tp);
});

test('O-1: missing shared count renders unknown; derived counts are labelled', async () => {
  const { context, el } = await loadClient(okRouter(statusPayload([item()]), usagePayload()));
  const noShared = statusPayload([item()]);
  delete noShared.sharedWithMe;
  const { flow } = render(context, el, noShared, usagePayload());
  assert.ok(flow.includes('unknown shared with me'), flow);
  assert.ok(!flow.includes('0 shared with me'), 'no zero-filled shared count');
  const noSummary = statusPayload([item()]);
  delete noSummary.summary;
  const derived = render(context, el, noSummary, usagePayload());
  assert.ok(derived.flow.includes('derived from the listed page'), derived.flow);
});

test('O-5: negative costs and all-absent totals stay unavailable', async () => {
  const { context, el } = await loadClient(okRouter(statusPayload([item()]), usagePayload()));
  const neg = render(context, el, statusPayload([item()]),
    usagePayload({ requests: 3, tokensIn: 10, tokensOut: 5, modelCostUsd: -4.5, executionCostUsd: null }));
  assert.ok(neg.tp.includes('>Model cost<') && neg.tp.includes('>unknown (unmeasured)<'), neg.tp);
  assert.ok(!neg.tp.includes('$-'), 'no negative cost presentation');
  const empty = render(context, el, statusPayload([item()]),
    usagePayload({ requests: null, tokensIn: null, tokensOut: null, modelCostUsd: null, executionCostUsd: null }));
  assert.ok(empty.tp.includes('Usage totals unavailable'), empty.tp);
});

test('O-4: hostile kind, id, and non-string timestamps never reach markup', async () => {
  const { context, el } = await loadClient(okRouter(statusPayload([]), usagePayload()));
  const badKind = item({ id: 'r_k', name: 'evil-kind"><script>alert(1)</script>', kind: 'datacenter"><img src=x>' });
  const badId = item({ id: 'r"x onerror="alert(1)', name: 'evil-id' });
  const badTime = item({ id: 'r_t', name: 'evil-time', lastSeenAt: 12345, lastSeenAgeMs: 10 });
  const { flow } = render(context, el, statusPayload([badKind, badId, badTime]), usagePayload());
  const doc = parseFragment(flow);
  let elements = 0;
  const walk = (n) => { if (n.tagName) elements += 1; (n.childNodes || []).forEach(walk); if (n.content) walk(n.content); };
  walk(doc);
  assert.ok(!flow.includes('evil-kind'), 'hostile-kind row dropped');
  assert.ok(!flow.includes('evil-id'), 'hostile-id row dropped');
  assert.ok(flow.includes('>unknown<'), 'non-string timestamp drops to unknown');
  assert.ok(elements < 90, `no injected elements (saw ${elements})`);
});

test('topology layout names real stages and keeps edges architectural', async () => {
  const { context, el } = await loadClient(okRouter(statusPayload([item()]), usagePayload()));
  const { flow } = render(context, el, statusPayload([item()]), usagePayload());
  assert.ok(flow.includes('Browser session'), flow);
  assert.ok(flow.includes('AIPSTER API'), flow);
  assert.ok(!/mcp/i.test(flow), 'never a falsely live MCP router');
  assert.ok(flow.includes('topo-map'), flow);
  assert.ok(flow.includes('topo-link'), flow);
  assert.ok(flow.includes('topo-nodes'), flow);
  assert.ok(flow.includes('topo-legend'), flow);
  assert.ok(flow.includes('Heartbeat returns'), flow);
  assert.ok(flow.includes('Result returns'), flow);
  const order = [flow.indexOf('<b>Browser session</b>'), flow.indexOf('<b>AIPSTER API</b>'), flow.indexOf('topo-nodes'), flow.indexOf('topo-legend')];
  assert.ok(order.every((i) => i >= 0) && order[0] < order[1] && order[1] < order[2] && order[2] < order[3], 'entry, control, nodes, legend read in order');
  for (const sw of ['sw-request', 'sw-heartbeat', 'sw-result', 'sw-unsupported']) {
    assert.ok(flow.includes(sw), `legend swatch ${sw} present`);
  }
  const doc = parseFragment(flow);
  const groups = [];
  const walk = (n) => {
    if (n.tagName === 'div' && (n.attrs || []).some((a) => a.name === 'class' && a.value.split(' ').includes('topo'))) groups.push(n);
    (n.childNodes || []).forEach(walk); if (n.content) walk(n.content);
  };
  walk(doc);
  assert.equal(groups.length, 1, 'exactly one labelled topology group');
  assert.ok((groups[0].attrs || []).some((a) => a.name === 'aria-label' && /architectural/i.test(a.value)), 'group exposes the architectural caveat as text');
});

test('node cards join inventory evidence and mark the rest not reported', async () => {
  const { context, el } = await loadClient(okRouter(statusPayload([item()]), usagePayload()));
  const inv = new Map([['r_1', invCard()]]);
  const { flow } = render(context, el, statusPayload([item()]), usagePayload(), inv);
  assert.ok(flow.includes('16-core x86'), flow);
  assert.ok(flow.includes('none recorded'), flow);
  assert.ok(flow.includes('topo-chip">text<'), 'declared capabilities render as chips');
  assert.ok(flow.includes('Memory · Runtime · Resident model: not reported. Models: not reported.'), 'unsupported rows stay explicit');
  const unmatched = render(context, el, statusPayload([item({ id: 'r_x', name: 'stray' })]), usagePayload(), inv);
  assert.ok(unmatched.flow.includes('not reported'), 'unmatched rows report no evidence');
});

test('bench lanes detail each node with honest unavailable slots', async () => {
  const { context, el } = await loadClient(okRouter(statusPayload([item()]), usagePayload()));
  const stale = item({ id: 'r_st', liveness: 'stale', lastSeenAt: iso(NOW - 10 * 60 * 1000), lastSeenAgeMs: 10 * 60 * 1000 });
  const { tp } = render(context, el, statusPayload([item(), stale]), usagePayload(), new Map([['r_1', invCard()]]));
  assert.ok(tp.includes('bench-lane online') && tp.includes('bench-lane stale'), 'one lane per rendered row');
  assert.ok(tp.includes('Heartbeat') && tp.includes('10m ago'), 'genuine freshness data shown');
  assert.ok(tp.includes('16-core x86'), 'declared CPU shown, never a load number');
  assert.ok(tp.includes('not reported: heartbeats carry no load numbers'), 'CPU track slot stays empty with reason');
  assert.ok(tp.includes('not reported: no memory readings in contract'), 'memory slot stays empty with reason');
  assert.ok(tp.includes('Not measured: no measured tok/s exist in this build'), 'generation slot stays empty with reason');
  assert.ok(tp.includes('unavailable: no accelerator inventory'), 'accelerator slot explicit');
  assert.ok(tp.includes('unavailable: no runtime telemetry in contract'), 'runtime/latency/prompt slot explicit');
  assert.ok(tp.includes('Models: No models reported.'), 'model slot explicit');
  const tracks = tp.match(/bench-track sm/g) || [];
  assert.equal(tracks.length, 10, 'five hatched tracks per lane, two lanes');
  assert.ok(!/bench-micro-fill|bench-plot-fill|width\s*:\s*\d/.test(tp), 'no fill widths anywhere in the bench');
});

test('node cards carry status dots, host lines, and liveness words', async () => {
  const { context, el } = await loadClient(okRouter(statusPayload([item()]), usagePayload()));
  const stale = item({ id: 'r_st', liveness: 'stale', lastSeenAt: iso(NOW - 10 * 60 * 1000), lastSeenAgeMs: 10 * 60 * 1000 });
  const { flow } = render(context, el, statusPayload([item(), stale]), usagePayload());
  assert.ok(flow.includes('topo-node online') && flow.includes('topo-node stale'), 'liveness classes on cards');
  assert.ok(flow.includes('topo-dot'), 'status dots present');
  assert.ok(flow.includes('r_1 · local'), 'host line names id and kind');
  assert.ok(flow.includes('<b>online</b>') && flow.includes('<b>stale</b>'), 'header liveness words');
});

test('hostile inventory free-text renders inert', async () => {
  const { context, el } = await loadClient(okRouter(statusPayload([item()]), usagePayload()));
  const evil = invCard({ compute: { cpu: '<img src=x id="fabric-ev">', gpu: '' }, capabilities: ['<b>nope</b>'] });
  const { flow } = render(context, el, statusPayload([item()]), usagePayload(), new Map([['r_1', evil]]));
  const doc = parseFragment(flow);
  const has = (n) => (n.attrs || []).some((a) => a.value === 'fabric-ev') || (n.childNodes || []).some(has);
  assert.ok(!has(doc), `BUG: compute text became markup: ${flow}`);
  assert.ok(flow.includes('not reported'), 'blank gpu reports no evidence');
});

test('throughput bench marks unavailable with coverage and no bar lengths', async () => {
  const { context, el } = await loadClient(okRouter(statusPayload([item()]), usagePayload()));
  const { tp } = render(context, el, statusPayload([item()]), usagePayload());
  assert.ok(tp.includes('measured rate: unavailable'), tp);
  assert.ok(!/width\s*:/i.test(tp), 'no invented bar lengths');
  assert.ok(!/\d[\d,.]*\s*tok\/s/i.test(tp.replace(/tokens\/sec/g, '').replace(/tok\/s scale unavailable/g, '')), 'no fabricated rates');
  assert.ok(tp.includes('bench-axis') && tp.includes('tok/s scale unavailable'), 'empty axis states its missing scale');
  assert.ok(tp.includes('bench-hatch') && tp.includes('Not measured'), 'hatched empty track with explicit word');
});

test('FINDING-B: snapshot states absolute captured-at time, never a frozen age', async () => {
  const { context, el } = await loadClient(okRouter(statusPayload([item()]), usagePayload()));
  const stamp = iso(Date.now() - 65000);
  const fresh = render(context, el, statusPayload([item()], { generatedAt: stamp }), usagePayload());
  assert.ok(fresh.flow.includes(`snapshot taken ${stamp}`), fresh.flow);
  assert.ok(fresh.flow.includes('snapshot only') && fresh.flow.includes('does not update until Overview reloads'), fresh.flow);
  assert.ok(!/snapshot \d+[smhd] ago/.test(fresh.flow), 'no frozen relative age');
  const timeless = render(context, el, statusPayload([item()], { generatedAt: 'not-a-time' }), usagePayload());
  assert.ok(timeless.flow.includes('snapshot time unknown'), timeless.flow);
  const futureStamp = iso(Date.now() + 3600000);
  const future = render(context, el, statusPayload([item()], { generatedAt: futureStamp }), usagePayload());
  assert.ok(future.flow.includes(`snapshot taken ${futureStamp}`) && future.flow.includes('snapshot only'), future.flow);
  assert.ok(!future.flow.includes('just taken'), 'future stamps stay absolute, never reworded as past');
});

test('FINDING-A: heartbeat lane follows the liveness set in the renderer', async () => {
  const { context, el } = await loadClient(okRouter(statusPayload([item()]), usagePayload()));
  const laneOf = (items) => {
    const { flow } = render(context, el, statusPayload(items), usagePayload());
    const m = /Heartbeat returns: reachability only \(([^)]+)\)/.exec(flow);
    assert.ok(m, 'return lane present');
    return m[1];
  };
  const on = item({ id: 'r_on' });
  const stale = item({ id: 'r_st', liveness: 'stale', lastSeenAt: iso(NOW - 10 * 60 * 1000), lastSeenAgeMs: 10 * 60 * 1000 });
  const unknown = item({ id: 'r_un', liveness: 'unknown', lastSeenAt: null, lastSeenAgeMs: null });
  const off = item({ id: 'r_off', liveness: 'offline', lastSeenAt: null, lastSeenAgeMs: null });
  assert.equal(laneOf([on, stale]), 'live');
  assert.equal(laneOf([stale]), 'stale only');
  assert.equal(laneOf([stale, unknown]), 'stale only');
  assert.equal(laneOf([unknown]), 'unknown only');
  assert.equal(laneOf([off]), 'none seen');
  assert.equal(laneOf([]), 'none seen');
});

test('residual: malformed rows drop before the lane and never throw', async () => {
  const { context, el } = await loadClient(okRouter(statusPayload([item()]), usagePayload()));
  const bad = item({ id: 'bad id', name: 'bad' });
  const solo = render(context, el, statusPayload([bad]), usagePayload());
  assert.ok(!solo.flow.includes('bad</strong>'), 'malformed-but-online row renders nothing');
  assert.ok(solo.flow.includes('(none seen)'), 'lane agrees with the module: none');
  const junk = render(context, el, statusPayload([null, 'junk', 42, item()], { summary: { total: 4, online: 1, stale: 0, offline: 0, unknown: 0 }, total: 4 }), usagePayload());
  assert.ok(junk.flow.includes('lab</strong>'), 'valid rows still render beside junk');
  assert.ok(junk.flow.includes('(live)'), 'lane follows the rendered rows');
});

test('residual: relative ages never accompany a live-currency claim', async () => {
  const { context, el } = await loadClient(okRouter(statusPayload([item()]), usagePayload()));
  const on = item({ id: 'r_on' });
  const stale = item({ id: 'r_st', liveness: 'stale', lastSeenAt: iso(NOW - 10 * 60 * 1000), lastSeenAgeMs: 10 * 60 * 1000 });
  const unusable = item({ id: 'r_nu', usable: false });
  const unknown = item({ id: 'r_un', liveness: 'unknown', lastSeenAt: null, lastSeenAgeMs: null });
  const { flow } = render(context, el, statusPayload([on, stale, unusable, unknown]), usagePayload());
  const onlinePills = flow.match(/>online</g) || [];
  // Both online pills sit on server-fresh rows (the usable=false one carries
  // an explicit not-usable attention note, never a ready claim).
  assert.equal(onlinePills.length, 2, 'online pills only on server-fresh rows');
  assert.ok(flow.includes('>stale<'), 'stale pill present');
  const seenCopy = flow.match(/heartbeat seen \(reachability only/g) || [];
  assert.equal(seenCopy.length, 1, 'only the fresh online row carries heartbeat-seen copy');
  assert.ok(flow.includes('ATTENTION: reachable but NOT usable for inference'), 'unusable attention kept');
  assert.ok(flow.includes('never'), 'rows without heartbeats show never, not an age');
});

test('topology stylesheet is responsive, static, and reduced-motion safe', async () => {
  const css = await readFile(APP_CSS, 'utf8');
  assert.ok(css.includes('.topo-nodes'), 'topology grid present');
  assert.ok(/@media\s*\(max-width:860px\)\s*\{[^}]*\.topo-map\s*\{\s*grid-template-columns:1fr/.test(css), 'vertical collapse');
  assert.ok(/\.topo-map\s*\{\s*display:grid;grid-template-columns:150px 60px 172px 60px minmax\(320px,1fr\)/.test(css), 'wide horizontal map with a flexible node track');
  assert.ok(/\.topo-map \.topo-nodes\s*\{\s*grid-column:5;grid-row:1/.test(css), 'node field occupies the flexible track, not the fixed stage tracks');
  assert.ok(/\.bench-lane-grid\s*\{\s*display:grid;[^}]*grid-template-columns:minmax\(0,16rem\) minmax\(0,1fr\) minmax\(0,11rem\)/.test(css), 'bench lanes use a three-column measurement grid');
  assert.ok(/\.topo-map \.topo-nodes\s*\{\s*grid-column:auto;grid-row:auto/.test(css), 'node field placement resets on mobile');
  assert.ok(/\.bench-lane-grid\s*\{\s*grid-template-columns:1fr/.test(css), 'bench lanes stack on mobile');
  assert.ok(/\.topo-link span\{[^}]*right:\.2rem;white-space:normal/.test(css), 'mobile link labels wrap inside the viewport');
  assert.ok(css.includes('prefers-reduced-motion'), 'reduced-motion rule present');
  const topoRules = css.slice(css.indexOf('.topo'));
  assert.ok(!/animation|transition|@keyframes/i.test(topoRules), 'no motion in topology rules');
});

test('edge links carry short labels; the dispatch disclaimer lives in the return lane', async () => {
  const { context, el } = await loadClient(okRouter(statusPayload([item()]), usagePayload()));
  const { flow } = render(context, el, statusPayload([item()]), usagePayload());
  assert.ok(flow.includes('<span>Request</span>'), 'short request label');
  assert.ok(flow.includes('<span>Request to node</span>'), 'short node-request label');
  assert.ok(!/<span>Request[^<]*<small>/.test(flow) && !/<span>Request to node[^<]*<small>/.test(flow), 'no cramped small print inside the links');
  assert.ok(flow.includes('dispatch availability unverified'), 'disclaimer kept');
  const ret = flow.slice(flow.indexOf('topo-return'));
  assert.ok(ret.includes('Request lanes: architectural · dispatch availability unverified here'), 'disclaimer sits in the return lane');
});

test('bench lanes use a three-column measurement grid with honest slots', async () => {
  const { context, el } = await loadClient(okRouter(statusPayload([item()]), usagePayload()));
  const { tp } = render(context, el, statusPayload([item()]), usagePayload(), new Map([['r_1', invCard()]]));
  const doc = parseFragment(tp);
  const byClass = (root, cls) => {
    const out = [];
    const walk = (n) => {
      if (n.attrs && n.attrs.some((a) => a.name === 'class' && a.value.split(' ').includes(cls))) out.push(n);
      for (const c of n.childNodes || []) walk(c);
    };
    walk(root); return out;
  };
  const lanes = byClass(doc, 'bench-lane');
  assert.equal(lanes.length, 1, 'one lane per rendered row');
  const text = (n) => (n.value || '') + (n.childNodes || []).map(text).join('');
  for (const lane of lanes) {
    const cols = (lane.childNodes || []).flatMap((c) => (c.tagName === 'div' && (c.attrs || []).some((a) => a.name === 'class' && a.value.split(' ').includes('bench-lane-grid')) ? (c.childNodes || []) : [])).filter((c) => c.tagName === 'div');
    assert.equal(cols.length, 3, 'compute / plot / accelerator columns');
    assert.ok(text(cols[0]).includes('Declared CPU'), 'compute column carries declared facts');
    assert.ok(text(cols[1]).includes('tok/s scale unavailable') && text(cols[1]).includes('Generation rate'), 'plot column carries axis ticks plus the unmeasured rate slot');
    assert.ok(text(cols[2]).includes('Accelerator'), 'accelerator column present');
  }
  assert.ok(tp.includes('Not measured: no measured tok/s exist in this build'), 'no fabricated rate');
});

test('fabric panels precede the legacy inventory cards in the Overview tab', async () => {
  const html = await readFile(APP_HTML, 'utf8');
  const tab = html.slice(html.indexOf('tab-overview'), html.indexOf('tab-compute'));
  assert.ok(tab.indexOf('fabric-flow-panel') !== -1 && tab.indexOf('fabric-throughput-panel') !== -1, 'fabric panels present');
  assert.ok(tab.indexOf('fabric-flow-panel') < tab.indexOf('ov-cards'), 'flow panel above legacy cards');
  assert.ok(tab.indexOf('fabric-throughput-panel') < tab.indexOf('ov-cards'), 'bench panel above legacy cards');
});
