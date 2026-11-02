/* Static export renderer: runs the reviewed demo (run.mjs) through the
 * reviewed renderer (render.mjs) and writes export files. Imports only —
 * no copies, no modifications to reviewed files. Local render only. */
import { writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTwoUserDemo } from './run.mjs';
import { renderHtml } from './render.mjs';

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'export');
const RENDER_COMMAND = 'node website/demo/federation-two-user/render-export.mjs';

const report = await runTwoUserDemo();
const html = renderHtml(report);
const bytes = Buffer.byteLength(html, 'utf8');
const sha256 = createHash('sha256').update(html, 'utf8').digest('hex');
const sourceSha = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();

mkdirSync(DIR, { recursive: true });
writeFileSync(join(DIR, 'EXPORT_federation-two-user.html'), html);
const receipt = `# Static export receipt — synthetic two-user federation demo

- Source SHA (reviewed demo files): ${sourceSha}
- Render command (repo root): \`${RENDER_COMMAND}\`
- Export file: \`website/demo/federation-two-user/export/EXPORT_federation-two-user.html\`
- Byte count (UTF-8): ${bytes}
- SHA-256 of export HTML: ${sha256}
- No-network confirmation: in-process Request dispatch only; this script
  performs no fetch, no listen, serves no URL, launches no browser.
- Labeling: every demo value labeled SYNTHETIC/FIXTURE; NOT SHOWN LIVE
  panel preserved in the export with reasons + live-test prerequisites.
- Rollback: delete \`website/demo/federation-two-user/export/\`.
`;
writeFileSync(join(DIR, 'EXPORT-RECEIPT.md'), receipt);
console.log(JSON.stringify({ bytes, sha256, sourceSha }));
