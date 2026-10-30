import vm from 'node:vm';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parseFragment} from 'parse5';
import {fabricEnv,connectPair,S,freshKey,readJson} from './qa-helpers.mjs';
const source=await readFile(new URL('../public/app/app.js',import.meta.url),'utf8');
function harness(fetcher) {
 const elements=new Map(); const el=id=>{if(!elements.has(id))elements.set(id,{id,hidden:false,value:'',textContent:'',innerHTML:'',listeners:{},dataset:{},addEventListener(k,v){this.listeners[k]=v},setAttribute(){},querySelectorAll(){return []}});return elements.get(id)};
 const context=vm.createContext({document:{getElementById:el,querySelectorAll(){return []}},location:{origin:'http://localhost:8787'},crypto:globalThis.crypto,console,setTimeout(){},fetch:async(p,o)=>p==='/api/auth/get-session'?Response.json(null):fetcher(p,o)});
 vm.runInContext(source,context); return {el,context};
}
const empty=()=>Response.json({items:[],total:0});

test('F1R UI CONTROL: auth and service errors remain errors, genuine 404 shows flag-off',async()=>{
 for(const status of [401,403,503,404]){
  const ui=harness(async()=>Response.json({error:'synthetic',code:status===404?'NOT_FOUND':'TEST_ERROR'},{status}));
  await vm.runInContext('loadFederation()',ui.context);
  assert.equal(ui.el('fab-off').hidden,status!==404);
  assert.equal(ui.el('fab-error').hidden,status===404);
 }
});
test('F1R UI CONTROL: error reset and late invitation-secret response are fenced',async()=>{
 let release,seen;const held=new Promise(r=>release=r);const started=new Promise(r=>seen=r);
 const ui=harness(async(p,o)=>{if(p==='/v1/fabric/invitations'&&o.method==='POST'){seen();await held;return Response.json({token:'SYNTHETIC_INV_SECRET'})}return empty()});
 ui.el('fab-error').textContent='old identity error';ui.el('fab-error').hidden=false;
 const pending=ui.el('fab-inv-form').listeners.submit({preventDefault(){}});await started;
 await ui.el('logout').listeners.click();release();await pending;
 assert.equal(ui.el('fab-inv-secret').textContent,'');assert.equal(ui.el('fab-inv-reveal').hidden,true);
 assert.equal(ui.el('fab-error').textContent,'');assert.equal(ui.el('fab-error').hidden,true);
});
