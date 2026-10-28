import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {resolve,relative} from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {parse} from 'parse5';

export const publicFiles=['404.html','_headers','app/app.js','app/icon.svg','app/index.html','app/styles.css','assets/AIPSTER-model-LoRA-drilldown.png','assets/AIPSTER-model-LoRA-drilldown.svg','assets/IRB-DGM-JEV-component-flow.png','assets/IRB-DGM-JEV-component-flow.svg','assets/aipster-wordmark.svg','assets/aipster-wordmark-on-dark.svg','assets/progress-log-20261026.png','assets/progress-wordmark-d.png','assets/sponsors/baseten.svg','assets/sponsors/meta.svg','assets/sponsors/modal.svg','favicon.svg','index.html','release.json','styles.css'].sort();

export const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function files(root,dir=root){const result=[];for(const entry of await readdir(dir,{withFileTypes:true})){assert(!entry.isSymbolicLink(),'Symlinks are outside the public upload policy');const path=resolve(dir,entry.name);if(entry.isDirectory())result.push(...await files(root,path));else{assert(entry.isFile(),'Unexpected asset type');result.push(relative(root,path).replaceAll('\\','/'));}}return result.sort();}

export const SPONSOR_DESTINATIONS=new Set(['https://www.meta.com/','https://modal.com/','https://www.baseten.co/']);
const PRIVATE = /127\.0\.0\.1|localhost|4327|resource[-_. ]ledger|C:\\Users|(?:BEGIN (?:RSA |EC )?PRIVATE KEY)|(?:gh[pousr]_[\w]{20,})|(?:sk-[\w]{20,})/i;
function checkPrivacy(text) {
  // Also catch ordinary escaped literals accidentally copied into the public JS.
  const decoded = text.replace(/\\u\{([\da-f]{1,6})\}|\\u([\da-f]{4})|\\x([\da-f]{2})/gi,
    (match, wide, unicode, hex) => {
      const point = Number.parseInt(wide || unicode || hex, 16);
      return point <= 0x10ffff ? String.fromCodePoint(point) : match;
    }).replace(/\\\\/g, '\\');
  assert(!PRIVATE.test(text) && !PRIVATE.test(decoded), 'Private content or credential-shaped material is forbidden');
}

function checkReference(ref, path, ids, navigation = false) {
  // Require canonical references: no URL-parser whitespace, backslash hosts,
  // encoded path aliases, protocol-relative hosts, or alternate schemes.
  assert(ref && !/[\s\\\u0000-\u001f\u007f%]/u.test(ref), `Unapproved URL spelling: ${ref}`);
  if (ref.startsWith('#')) {
    assert(ids.has(ref.slice(1)), `Broken anchor: ${ref}`);
    return;
  }
  if (ref.startsWith('/') && !ref.startsWith('//')) {
    const url = new URL(ref, 'https://public.invalid');
    assert(!url.search && !url.hash && url.pathname === ref
      && (ref === '/' || ref === '/app/' || publicFiles.includes(ref.slice(1))),
    `Unapproved or missing asset: ${ref}`);
    return;
  }
  const url = new URL(ref, 'https://public.invalid');
  // Reviewed sponsor destinations: exact official-site URLs only. Exact
  // string match — subdomains, lookalike hosts, and extra paths fail.
  if (navigation && !path.endsWith('.svg') && SPONSOR_DESTINATIONS.has(ref)) return;
  assert(navigation && !path.endsWith('.svg') && url.protocol === 'https:'
    && url.hostname === 'github.com' && !url.port && !url.username && !url.password
    && (url.pathname === '/synchronic1/AIPSTER' || url.pathname.startsWith('/synchronic1/AIPSTER/')),
  `External destination requires review: ${ref}`);
}

function checkCss(text, path, ids = new Set()) {
  const css = text.replace(/\/\*[\s\S]*?\*\//g, '');
  // The approved styles need no CSS escapes or URL-bearing string functions.
  // Reject these constructs rather than attempting partial CSS unescaping.
  assert(!/\\|@import\b|@namespace\b|(?:-webkit-)?image-set\s*\(|\bimage\s*\(|\bsrc\s*\(/i.test(css),
    'CSS imports, escapes, or embedded content require review');
  assert(!/(?:https?:|data:|javascript:|\/\/)/i.test(css), 'CSS remote content requires review');
  for (const match of css.matchAll(/\burl\s*\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)'"()]*))\s*\)/gi)) {
    checkReference(match[1] ?? match[2] ?? match[3], path, ids);
  }
  const withoutUrls = css.replace(/\burl\s*\(\s*(?:"[^"]*"|'[^']*'|[^\s)'"()]*)\s*\)/gi, '');
  assert(!/\burl\s*\(/i.test(withoutUrls), 'Malformed CSS URL requires review');
}

function checkMarkup(text, path) {
  const errors = [];
  // The approved diagram export includes this inert XML declaration. Other
  // processing instructions and DTDs remain outside the public asset policy.
  const markup = path.endsWith('.svg')
    ? text.replace(/^\s*<\?xml\s+version=['"]1\.0['"]\s+encoding=['"]UTF-8['"]\s*\?>/i, '') : text;
  const document = parse(markup, {onParseError: error => errors.push(error.code)});
  assert(errors.every(code => code === 'missing-doctype'), `Malformed public markup: ${errors.join(', ')}`);
  const nodes = [];
  function visit(node) {
    nodes.push(node);
    for (const child of node.childNodes || []) visit(child);
    if (node.content) visit(node.content);
  }
  visit(document);
  const ids = new Set(nodes.flatMap(node => (node.attrs || []).filter(attr => attr.name === 'id').map(attr => attr.value)));
  let scripts = 0;
  for (const node of nodes) {
    if (node.nodeName === '#text') checkPrivacy(node.value);
    if (!node.tagName) continue;
    const tag = node.tagName.toLowerCase();
    assert(!['iframe', 'object', 'embed', 'foreignobject', 'base', 'template', 'math', 'noscript',
      'plaintext', 'xmp', 'animate', 'animatemotion', 'animatetransform', 'set', 'discard'].includes(tag),
    'Active or embedded content is outside the static site policy');
    const attrs = node.attrs || [];
    for (const attr of attrs) {
      const name = (attr.prefix ? `${attr.prefix}:` : '') + attr.name;
      checkPrivacy(attr.value);
      assert(!/^on/i.test(name) && !['srcdoc', 'srcset', 'imagesrcset', 'ping', 'archive', 'codebase', 'xml:base'].includes(name),
        'Active or embedded content is outside the static site policy');
      assert(!['action', 'method', 'formaction', 'formmethod'].includes(name),
        'App forms must be JS-handled (no action/method attributes)');
      if (name === 'style') checkCss(attr.value, path, ids);
      if (['href', 'xlink:href', 'src', 'poster', 'background', 'data', 'cite', 'longdesc', 'manifest'].includes(name)) {
        checkReference(attr.value, path, ids, tag === 'a' && name === 'href');
      }
      if (tag === 'meta') assert(name !== 'http-equiv', 'Active metadata requires review');
    }
    if (tag === 'form') assert(path === 'app/index.html', 'Active forms are outside the static site policy');
    if (tag === 'script') {
      assert(path === 'app/index.html' && node.namespaceURI === 'http://www.w3.org/1999/xhtml'
        && attrs.length === 1 && attrs[0].name === 'src' && attrs[0].value === '/app/app.js'
        && (node.childNodes || []).every(child => child.nodeName === '#text' && !child.value.trim()),
      'Active scripts are outside the static site policy');
      scripts++;
    }
    if (tag === 'style') checkCss((node.childNodes || []).map(child => child.value || '').join(''), path, ids);
    // SVG URL-valued presentation attributes (e.g. marker-end) use CSS syntax.
    for (const attr of attrs) {
      if (/\\|\/\*|\burl\s*\(/i.test(attr.value)
        || ['fill', 'stroke', 'filter', 'clip-path', 'mask', 'cursor', 'marker-start', 'marker-mid', 'marker-end'].includes(attr.name)) {
        checkCss(attr.value, path, ids);
      }
    }
  }
  if (path === 'app/index.html') assert.equal(scripts, 1, 'The app must load exactly its approved script');
}

export async function checkPublic(root){
  assert.deepEqual(await files(root),publicFiles,'Public directory must match the explicit static allowlist');
  const manifest=[];
  for(const path of publicFiles){const bytes=await readFile(resolve(root,path));assert(bytes.length<10*1024*1024,'Unexpected oversized asset');manifest.push({path,bytes:bytes.length,sha256:sha(bytes)});
    if(/\.(?:html|css|svg|json|js)$/.test(path) || path === '_headers'){
      const text=bytes.toString('utf8');
      checkPrivacy(text);
      if (/\.(?:html|svg)$/.test(path)) checkMarkup(text, path);
      if (path.endsWith('.css')) checkCss(text, path);
    }
  }
  const html=await readFile(resolve(root,'index.html'),'utf8');
  assert(!/(?:href|src)="\/(?:login|api)(?:[\/"?])/i.test(html),'Raw login/API paths must not be advertised on the landing page');
  assert(html.includes('User login is not enabled on this public site.'));
  assert(html.includes('In development'));
  assert((await readFile(resolve(root,'_headers'),'utf8')).includes('no-transform'));
  const release=JSON.parse(await readFile(resolve(root,'release.json'),'utf8'));
  assert.equal(release.auth_deployed,false);
  return {files:manifest,manifest_sha256:sha(JSON.stringify(manifest)),revision:release.revision};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const result=await checkPublic(resolve(import.meta.dirname,'../public'));console.log(JSON.stringify({passed:true,files:result.files.length,revision:result.revision,manifest_sha256:result.manifest_sha256}));}
