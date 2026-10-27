import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,cp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join,sep} from 'node:path';
import {checkPublic} from './check.mjs';
const original=resolve(import.meta.dirname,'../public');
async function fixture(change,run){const root=await mkdtemp(join(tmpdir(),'aipster-public-check-'));try{await cp(original,root,{recursive:true});await change(root);await run(root);}finally{assert(root.startsWith(resolve(tmpdir())+sep)&&root.includes('aipster-public-check-'));await rm(root,{recursive:true,force:true});}}
test('valid public-only artifact passes',async()=>{assert.equal((await checkPublic(original)).files.length,18);});
test('an accidentally copied auth/credential file fails',async()=>fixture(root=>writeFile(resolve(root,'.dev.vars'),'SYNTHETIC_ONLY=1'),root=>assert.rejects(checkPublic(root),/allowlist/)));
test('inline active HTML fails',async()=>fixture(async root=>{const path=resolve(root,'index.html');await writeFile(path,(await readFile(path,'utf8')).replace('</body>','<script>1</script></body>'));},root=>assert.rejects(checkPublic(root),/Active/)));
test('remote SVG payload fails',async()=>fixture(root=>writeFile(resolve(root,'assets/aipster-wordmark.svg'),'<svg><image href="https://invalid.example/track"/></svg>'),root=>assert.rejects(checkPublic(root),/remote/)));
test('missing or unapproved local destination fails',async()=>fixture(async root=>{const path=resolve(root,'index.html');await writeFile(path,(await readFile(path,'utf8')).replace('href="#overview"','href="/missing.svg"'));},root=>assert.rejects(checkPublic(root),/missing asset/)));
test('a private localhost reference fails',async()=>fixture(async root=>{const path=resolve(root,'index.html');await writeFile(path,(await readFile(path,'utf8')).replace('</body>','<p>http://127.0.0.1:4327</p></body>'));},root=>assert.rejects(checkPublic(root),/Private/)));
test('an unapproved app script source fails',async()=>fixture(async root=>{const path=resolve(root,'app/index.html');await writeFile(path,(await readFile(path,'utf8')).replace('<script src="/app/app.js"></script>','<script src="https://evil.example/x.js"></script>'));},root=>assert.rejects(checkPublic(root),/Active/)));
