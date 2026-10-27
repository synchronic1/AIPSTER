import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {publicFiles,sha} from './check.mjs';
const root=resolve(import.meta.dirname,'..');
const base='https://aipster.net';
for(const path of [...publicFiles,'deployment.json']){
  if(path==='_headers'||path==='404.html')continue;
  const response=await fetch(base+(path==='index.html'?'/':'/'+path),{signal:AbortSignal.timeout(15000)});
  assert.equal(response.status,200,`Expected HTTPS 200: ${path}`);
  assert.equal(sha(Buffer.from(await response.arrayBuffer())),sha(await readFile(resolve(root,'dist',path))),`Live bytes differ: ${path}`);
  assert(response.headers.get('cache-control')?.includes('no-transform'));
}
for(const path of ['/login','/app','/api/session','/website/wrangler.jsonc','/.env']){const response=await fetch(base+path,{signal:AbortSignal.timeout(15000)});assert.equal(response.status,404);}
console.log(JSON.stringify({verified:true,url:base,source:'exact built dist bytes including deployment.json',auth_deployed:false}));
