/* Static HTML renderer for the synthetic two-user federation demo.
 * Pure string building (no DOM, no network); safe for Node-level assertions. */
import { DEMO_LABEL, TRANSPORT } from './run.mjs';

const esc = (v) => String(v === undefined ? '—' : JSON.stringify(v))
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

export function renderHtml(report) {
  const secs = report.sections.map((s, i) => {
    const rows = Object.entries(s).filter(([k]) => k !== 'title' && k !== 'label')
      .map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('');
    return `<section><h2>${i + 1}. ${esc(s.title)}</h2><p class="label">${esc(s.label)}</p><table>${rows}</table></section>`;
  }).join('\n');
  const reasons = report.notShownLive.reasons.map((r) => `<li>${esc(r)}</li>`).join('');
  const prereqs = report.notShownLive.liveTestPrerequisites.map((r) => `<li>${esc(r)}</li>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Synthetic two-user federation demo</title></head><body>
<h1>Two-user federation: isolated synthetic demonstration</h1>
<p class="label">${esc(report.label)}</p>
<p class="transport">${esc(report.transport)}</p>
<p class="flags">FEDERATION_ENABLED=${esc(report.flags.FEDERATION_ENABLED)}</p>
${secs}
<section class="not-live"><h2>${esc(report.notShownLive.heading)}</h2>
<h3>Why these outcomes are absent here</h3><ul>${reasons}</ul>
<h3>What a live two-user test would additionally need</h3><ul>${prereqs}</ul></section>
</body></html>`;
}

export { DEMO_LABEL, TRANSPORT };
