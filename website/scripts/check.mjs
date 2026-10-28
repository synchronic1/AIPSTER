import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {resolve,relative} from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';

export const publicFiles=['404.html','_headers','assets/AIPSTER-model-LoRA-drilldown.png','assets/AIPSTER-model-LoRA-drilldown.svg','assets/IRB-DGM-JEV-component-flow.png','assets/IRB-DGM-JEV-component-flow.svg','assets/aipster-wordmark.svg','assets/aipster-wordmark-on-dark.svg','assets/progress-log-20261026.png','assets/progress-wordmark-d.png','assets/sponsors/meta.svg','assets/sponsors/modal.svg','favicon.svg','index.html','release.json','styles.css'].sort();
export const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function files(root,dir=root){const result=[];for(const entry of await readdir(dir,{withFileTypes:true})){assert(!entry.isSymbolicLink(),'Symlinks are outside the public upload policy');const path=resolve(dir,entry.name);if(entry.isDirectory())result.push(...await files(root,path));else{assert(entry.isFile(),'Unexpected asset type');result.push(relative(root,path).replaceAll('\\','/'));}}return result.sort();}

export async function checkPublic(root){
  assert.deepEqual(await files(root),publicFiles,'Public directory must match the explicit static allowlist');
  const manifest=[];
  for(const path of publicFiles){const bytes=await readFile(resolve(root,path));assert(bytes.length<10*1024*1024,'Unexpected oversized asset');manifest.push({path,bytes:bytes.length,sha256:sha(bytes)});
    if(/\.(?:html|css|svg|json)$/.test(path)){
      const text=bytes.toString('utf8');
      assert(!/127\.0\.0\.1|localhost|4327|resource[-_. ]ledger|C:\\Users|(?:BEGIN (?:RSA |EC )?PRIVATE KEY)|(?:gh[pousr]_[\w]{20,})|(?:sk-[\w]{20,})/i.test(text),'Private content or credential-shaped material is forbidden');
      assert(!/<(?:script|form|iframe|object|embed|foreignObject)\b|\son[a-z]+\s*=|javascript:|@import\b/i.test(text),'Active or embedded content is outside the static site policy');
      if(path.endsWith('.svg'))assert(!/(?:href|src)\s*=\s*["'](?:https?:|\/\/|data:)/i.test(text),'SVG assets must not fetch remote content');
    }
  }
  const html=await readFile(resolve(root,'index.html'),'utf8');
  const ids=new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]));
  for(const ref of [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map(m=>m[1])){
    if(ref.startsWith('#'))assert(ids.has(ref.slice(1)),`Broken anchor: ${ref}`);
    else if(ref.startsWith('/'))assert(ref==='/'||publicFiles.includes(ref.slice(1)),`Unapproved or missing asset: ${ref}`);
    else assert(ref.startsWith('https://github.com/synchronic1/AIPSTER'),`External destination requires review: ${ref}`);
  }
  assert(!/(?:href|src)="\/(?:login|app|api)(?:[\/"?])/i.test(html),'Prepared auth must not be advertised as deployed');
  assert(html.includes('User login is not enabled on this public site.'));
  assert(html.includes('In development'));
  assert((await readFile(resolve(root,'_headers'),'utf8')).includes('no-transform'));
  const release=JSON.parse(await readFile(resolve(root,'release.json'),'utf8'));
  assert.equal(release.auth_deployed,false);
  return {files:manifest,manifest_sha256:sha(JSON.stringify(manifest)),revision:release.revision};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const result=await checkPublic(resolve(import.meta.dirname,'../public'));console.log(JSON.stringify({passed:true,files:result.files.length,revision:result.revision,manifest_sha256:result.manifest_sha256}));}
