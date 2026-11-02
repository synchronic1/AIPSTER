/* Static export renderer: runs the reviewed demo (run.mjs) through the
 * reviewed renderer (render.mjs) and writes export files. Imports only —
 * no copies, no modifications to reviewed files. Local render only.
 *
 * Determinism: the demo mints random grant/approval ids per run
 * (fg_<hex>, appr_<hex> from src/fabric/store.mjs). Those ids are
 * normalized to placeholders and the per-admission audit list is reduced
 * to per-path counts, so the export renders to identical bytes every run. */
import { writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTwoUserDemo } from './run.mjs';
import { renderHtml } from './render.mjs';

const DEMO_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(DEMO_DIR, '../../..');
const DIR = join(DEMO_DIR, 'export');
const RENDER_COMMAND = 'node website/demo/federation-two-user/render-export.mjs';
const REVIEWED_SOURCE = [
  'website/demo/federation-two-user/run.mjs',
  'website/demo/federation-two-user/render.mjs'
];

/* Random ids are collapsed so the export is byte-stable across renders. */
const normalizePath = (p) =>
  p.replace(/fg_[0-9a-f]+/g, 'fg_<id>').replace(/appr_[0-9a-f]+/g, 'appr_<id>');

const toPathCounts = (paths) => {
  const counts = {};
  for (const p of paths) {
    const key = normalizePath(p);
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
};

/* Record the commit that last changed the reviewed demo source, not HEAD:
 * HEAD moves with every later commit and would make the receipt drift. */
const sourceSha = execFileSync(
  'git',
  ['log', '-1', '--format=%H', '--', ...REVIEWED_SOURCE],
  { cwd: ROOT, encoding: 'utf8' }
).trim();

const report = await runTwoUserDemo();
for (const section of report.sections) {
  if (Array.isArray(section.paths)) section.paths = toPathCounts(section.paths);
}
const html = renderHtml(report);
const bytes = Buffer.byteLength(html, 'utf8');
const sha256 = createHash('sha256').update(html, 'utf8').digest('hex');

mkdirSync(DIR, { recursive: true });
writeFileSync(join(DIR, 'EXPORT_federation-two-user.html'), html);
const receipt = `# Static export receipt — synthetic two-user federation demo

- Source SHA (reviewed demo files): ${sourceSha}
- Render command (repo root): \`${RENDER_COMMAND}\`
- Export file: \`website/demo/federation-two-user/export/EXPORT_federation-two-user.html\`
- Byte count (UTF-8): ${bytes}
- SHA-256 of export HTML: ${sha256}
- Reproducibility: the export is byte-stable — random grant/approval ids are
  rendered as \`<id>\` placeholders and the audit list as per-path counts, so
  re-rendering yields this same byte count and SHA-256.
- No-network confirmation: in-process Request dispatch only; this script
  performs no fetch, no listen, serves no URL, launches no browser.
- Labeling: every demo value labeled SYNTHETIC/FIXTURE; NOT SHOWN LIVE
  panel preserved in the export with reasons + live-test prerequisites.
- Rollback: delete \`website/demo/federation-two-user/export/\`.
`;
writeFileSync(join(DIR, 'EXPORT-RECEIPT.md'), receipt);
console.log(JSON.stringify({ bytes, sha256, sourceSha }));
