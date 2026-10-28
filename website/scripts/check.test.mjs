import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,cp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join,sep} from 'node:path';
import {checkPublic} from './check.mjs';
const original=resolve(import.meta.dirname,'../public');
async function fixture(change,run){const root=await mkdtemp(join(tmpdir(),'aipster-public-check-'));try{await cp(original,root,{recursive:true});await change(root);await run(root);}finally{assert(root.startsWith(resolve(tmpdir())+sep)&&root.includes('aipster-public-check-'));await rm(root,{recursive:true,force:true});}}
test('valid public-only artifact passes',async()=>{assert.equal((await checkPublic(original)).files.length,23);});

test('an accidentally copied auth/credential file fails',async()=>fixture(root=>writeFile(resolve(root,'.dev.vars'),'SYNTHETIC_ONLY=1'),root=>assert.rejects(checkPublic(root),/allowlist/)));
test('inline active HTML fails',async()=>fixture(async root=>{const path=resolve(root,'index.html');await writeFile(path,(await readFile(path,'utf8')).replace('</body>','<script>1</script></body>'));},root=>assert.rejects(checkPublic(root),/Active/)));
test('remote SVG payload fails',async()=>fixture(root=>writeFile(resolve(root,'assets/aipster-wordmark.svg'),'<svg><image href="https://invalid.example/track"/></svg>'),root=>assert.rejects(checkPublic(root),/External/)));
test('missing or unapproved local destination fails',async()=>fixture(async root=>{const path=resolve(root,'index.html');await writeFile(path,(await readFile(path,'utf8')).replace('href="#overview"','href="/missing.svg"'));},root=>assert.rejects(checkPublic(root),/missing asset/)));
test('a private localhost reference fails',async()=>fixture(async root=>{const path=resolve(root,'index.html');await writeFile(path,(await readFile(path,'utf8')).replace('</body>','<p>http://127.0.0.1:4327</p></body>'));},root=>assert.rejects(checkPublic(root),/Private/)));
test('an unapproved app script source fails',async()=>fixture(async root=>{const path=resolve(root,'app/index.html');await writeFile(path,(await readFile(path,'utf8')).replace('<script src="/app/app.js"></script>','<script src="https://evil.example/x.js"></script>'));},root=>assert.rejects(checkPublic(root),/External/)));

async function edit(root, path, change) {
  const file = resolve(root, path);
  await writeFile(file, change(await readFile(file, 'utf8')));
}

for (const [name, path, payload] of [
  ['single-quoted landing link', 'index.html', "<a href='https://evil.example/collect'>link</a>"],
  ['unquoted landing link', 'index.html', '<a href=https://evil.example/collect>link</a>'],
  ['uppercase and spaced attribute', 'index.html', '<a HREF = "https://evil.example/collect">link</a>'],
  ['entity-encoded scheme', 'index.html', '<a href="https&colon;//evil.example/collect">link</a>'],
  ['numeric entity scheme', 'index.html', '<a href="&#104;ttps://evil.example/collect">link</a>'],
  ['control character in scheme', 'index.html', '<a href="java&#9;script:alert(1)">link</a>'],
  ['data scheme', 'index.html', '<a href="data:text/html,fixture">link</a>'],
  ['protocol-relative host', 'index.html', '<a href="//evil.example/collect">link</a>'],
  ['GitHub repository prefix lookalike', 'index.html', '<a href="https://github.com/synchronic1/AIPSTER-unreviewed">link</a>'],
  ['sponsor host lookalike', 'index.html', '<a href="https://modal.com.evil.example/collect">link</a>'],
  ['sponsor path lookalike', 'index.html', '<a href="https://modal.com/unreviewed">link</a>'],
  ['sponsor scheme downgrade', 'index.html', '<a href="http://modal.com/">link</a>'],
  ['sponsor extra subdomain', 'index.html', '<a href="https://www.modal.com/">link</a>'],
  ['non-canonical absolute link', 'index.html', '<link rel="alternate" href="https://evil.example/feed">'],
  ['canonical lookalike host', 'index.html', '<link rel="canonical" href="https://aipster.net.evil.example/">'],
  ['off-origin meta image', 'index.html', '<meta property="og:image" content="https://evil.example/card.png">'],
  ['dot-segment alias', 'index.html', '<a href="/app/../favicon.svg">link</a>'],
  ['encoded path alias', 'index.html', '<a href="/%61pp/">link</a>'],
  ['app external navigation', 'app/index.html', '<a href="https://evil.example/sign-in">Continue sign-in</a>'],
  ['app remote image', 'app/index.html', '<img src="https://evil.example/collect">'],
  ['app srcset', 'app/index.html', '<img srcset="https://evil.example/collect 1x">'],
  ['meta refresh', 'index.html', '<meta http-equiv="refresh" content="0;url=https://evil.example/collect">'],
]) test(`rejects ${name}`, async () => fixture(
  root => edit(root, path, text => text.replace('</body>', payload + '</body>')),
  root => assert.rejects(checkPublic(root), /External|Unapproved|Active/),
));

for (const [name, payload] of [
  ['entity-encoded href', '<svg><image href="https&#58;//evil.example/collect"/></svg>'],
  ['namespaced href', '<svg xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="https://evil.example/collect"/></svg>'],
  ['animated URL mutation', '<svg><image id="picture"/><set href="#picture" attributeName="href" to="https://evil.example/collect"/></svg>'],
  ['escaped presentation URL', String.raw`<svg><rect fill="u\72l(https://evil.example/collect)"/></svg>`],
  ['comment-split presentation URL', '<svg><rect fill="u/**/rl(https://evil.example/collect)"/></svg>'],
]) test(`rejects SVG ${name}`, async () => fixture(
  root => writeFile(resolve(root, 'assets/aipster-wordmark.svg'), payload),
  root => assert.rejects(checkPublic(root), /External|Active|CSS/),
));

for (const [name, css] of [
  ['quoted external URL', 'body{background:url("https://evil.example/collect")}'],
  ['unquoted external URL', 'body{background:url(https://evil.example/collect)}'],
  ['comment-split URL function', 'body{background:u/**/rl(https://evil.example/collect)}'],
  ['escaped URL function', String.raw`body{background:u\72l(https://evil.example/collect)}`],
  ['escaped import', String.raw`@\69mport "https://evil.example/style.css";`],
  ['image-set string', 'body{background:image-set("https://evil.example/collect" 1x)}'],
]) test(`rejects CSS ${name}`, async () => fixture(
  root => edit(root, 'styles.css', text => text + '\n' + css),
  root => assert.rejects(checkPublic(root), /CSS/),
));

for (const [name, attr] of [
  ['event handler', 'onsubmit="alert(1)"'],
  ['uppercase event handler', 'ONSUBMIT="alert(1)"'],
  ['remote style URL', 'style="background:url(https://evil.example/collect)"'],
  ['form action', 'action="https://evil.example/collect"'],
]) test(`rejects app form ${name} before allowing its tag`, async () => fixture(
  root => edit(root, 'app/index.html', text => text.replace('<form id="resource-form"', `<form ${attr} id="resource-form"`)),
  root => assert.rejects(checkPublic(root), /Active|CSS|JS-handled/),
));

for (const [name, path, value] of [
  ['JS private endpoint', 'app/app.js', '// http://127.0.0.1:4327'],
  ['JS credential shape', 'app/app.js', '// ghp_' + 'SYNTHETIC'.repeat(4)],
  ['escaped JS private endpoint', 'app/app.js', String.raw`const fixture = "local\u0068ost";`],
  ['escaped JS Windows path', 'app/app.js', String.raw`const fixture = "C:\\Users\\fixture";`],
  ['header credential shape', '_headers', '# sk-' + 'SYNTHETIC'.repeat(4)],
]) test(`rejects ${name}`, async () => fixture(
  root => edit(root, path, text => text + '\n' + value),
  root => assert.rejects(checkPublic(root), /Private/),
));

test('semantic approved script and link spellings remain allowed', async () => fixture(async root => {
  await edit(root, 'app/index.html', text => text.replace('<script src="/app/app.js"></script>', "<script SRC = '/app/app.js'></script>"));
  await edit(root, 'index.html', text => text.replace('href="#overview"', "HREF = '#overview'"));
  await edit(root, 'styles.css', text => text + '\nbody{background-image:url(/favicon.svg)}');
}, async root => assert.equal((await checkPublic(root)).files.length, 23)));

test('approved script cannot acquire inline code or be duplicated', async () => {
  for (const replacement of [
    '<script src="/app/app.js">alert(1)</script>',
    '<script src="/app/app.js"></script><script src="/app/app.js"></script>',
  ]) await fixture(
    root => edit(root, 'app/index.html', text => text.replace('<script src="/app/app.js"></script>', replacement)),
    root => assert.rejects(checkPublic(root), /Active|exactly/),
  );
});

test('social preview metadata is one consistent absolute-URL set', async () => {
  const html = await readFile(resolve(original, 'index.html'), 'utf8');
  const metas = [...html.matchAll(/<meta\s+(?:property|name)="([^"]+)"\s+content="([^"]*)"\s*\/?>/g)];
  const get = (k) => metas.filter(m => m[1] === k).map(m => m[2]);
  for (const k of ['og:type', 'og:site_name', 'og:title', 'og:description', 'og:url', 'og:image', 'og:image:type', 'og:image:width', 'og:image:height', 'og:image:alt', 'twitter:card', 'twitter:title', 'twitter:description', 'twitter:image', 'twitter:image:alt']) {
    assert.equal(get(k).length, 1, `exactly one ${k}`);
  }
  assert.equal(get('og:type')[0], 'website');
  assert.equal(get('twitter:card')[0], 'summary_large_image');
  assert.equal(get('og:title')[0], get('twitter:title')[0], 'titles match');
  assert.equal(get('og:description')[0], get('twitter:description')[0], 'descriptions match');
  assert.equal(get('og:image')[0], get('twitter:image')[0], 'images match');
  assert.equal(get('og:image')[0], 'https://aipster.net/assets/social-preview.png');
  assert.equal(get('og:image:type')[0], 'image/png');
  assert.equal(get('og:image:width')[0], '1200');
  assert.equal(get('og:image:height')[0], '630');
  assert.ok(!/test|staging|localhost/i.test(get('og:description')[0]), 'no staging claims');
  const canon = [...html.matchAll(/<link\s+rel="canonical"\s+href="([^"]+)"\s*\/?>/g)];
  assert.equal(canon.length, 1, 'exactly one canonical link');
  assert.equal(canon[0][1], 'https://aipster.net/');
});
