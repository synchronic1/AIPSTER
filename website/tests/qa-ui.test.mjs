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
test('QA UI: untrusted model strings must render as text',async()=>{
 const payload='<b id="qa-injected-model">injected</b>';
 const t=await fabricEnv();const {conn}=await connectPair(t);
 const post=(p,b)=>t.call('/v1/fabric/'+p,{method:'POST',headers:S(t,t.alice,{'Idempotency-Key':freshKey()}),body:b}).then(readJson);
 const p=await post('previews',{connectionId:conn.id,resourceIds:['r_gpu1'],consumers:['bob-op'],models:[payload],maxTokens:100,maxRequests:10});assert.equal(p.status,201);
 const a=await post('approvals',{previewId:p.json.id});await post(`approvals/${a.json.id}/decide`,{decision:'approve'});assert.equal((await post('grants',{approvalId:a.json.id,previewHash:p.json.digest})).status,201);
 const incoming=await t.call('/v1/fabric/grants?scope=incoming',{headers:S(t,t.bob)}).then(readJson);
 const ui=harness(async p=>p.includes('grants?scope=incoming')?Response.json(incoming.json):empty());
 await vm.runInContext('loadFederation()',ui.context);
 const markup=ui.el('fab-grant-in').innerHTML;
 const doc=parseFragment(markup);const has=n=>n.attrs?.some(a=>a.name==='id'&&a.value==='qa-injected-model')||n.childNodes?.some(has);
 assert.ok(!has(doc),`BUG: model became markup: ${markup}`);
});
test('QA UI: 503 must not be presented as feature disabled',async()=>{
 const ui=harness(async()=>Response.json({error:'Synthetic database unavailable',code:'DB_UNAVAILABLE'},{status:503}));
 await vm.runInContext('loadFederation()',ui.context);
 assert.equal(ui.el('fab-off').hidden,true,'BUG: generic 503 displays "Federation is not enabled on this deployment"');
});
test('QA UI CONTROL: late node-secret response fenced after logout/reset',async()=>{
 let release,seen;const held=new Promise(r=>release=r);const started=new Promise(r=>seen=r);
 const ui=harness(async(p,o)=>{if(p==='/v1/fabric/nodes'&&o.method==='POST'){seen();await held;return Response.json({nodeSecret:'SYNTHETIC_NODE_SECRET'})}return empty()});
 ui.el('fab-node-label').value='qa';
 const pending=ui.el('fab-node-form').listeners.submit({preventDefault(){}});await started;
 await ui.el('logout').listeners.click();release();await pending;
 assert.equal(ui.el('fab-node-secret').textContent,'');assert.equal(ui.el('fab-node-reveal').hidden,true);
});
test('QA UI CONTROL: node and invitation secret dismissal and reset clear DOM',async()=>{
 const ui=harness(async()=>empty());
 for(const type of ['node','inv']){ui.el(`fab-${type}-secret`).textContent='synthetic';ui.el(`fab-${type}-reveal`).hidden=false;ui.el(`fab-${type}-dismiss`).listeners.click();assert.equal(ui.el(`fab-${type}-secret`).textContent,'');assert.equal(ui.el(`fab-${type}-reveal`).hidden,true)}
 ui.el('fab-accept-key').value='synthetic';ui.el('fab-accept-token').value='synthetic';await ui.el('logout').listeners.click();assert.equal(ui.el('fab-accept-key').value,'');assert.equal(ui.el('fab-accept-token').value,'');
});
