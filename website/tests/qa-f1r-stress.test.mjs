import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fabricEnv,connectPair,commitFlow,S,freshKey,readJson} from './qa-helpers.mjs';
import * as core from '../src/fabric/store.mjs';
import {digestJson} from '../src/fabric/canonical.mjs';
const post=(t,u,p,b={},key=freshKey())=>t.call('/v1/fabric/'+p,{method:'POST',headers:S(t,u,{'Idempotency-Key':key}),body:b}).then(readJson);
const get=(t,u,p)=>t.call('/v1/fabric/'+p,{headers:S(t,u)}).then(readJson);
async function approved(t,conn,maxTokens=1000,consumer='bob-op'){
 const p=await post(t,t.alice,'previews',{connectionId:conn,resourceIds:['r_gpu1'],consumers:[consumer],models:['llama'],maxTokens,maxRequests:10});assert.equal(p.status,201);
 const a=await post(t,t.alice,'approvals',{previewId:p.json.id});assert.equal(a.status,201);
 assert.equal((await post(t,t.alice,`approvals/${a.json.id}/decide`,{decision:'approve'})).status,200);
 return {approvalId:a.json.id,previewHash:p.json.digest,previewId:p.json.id};
}
const auth=(t,node,consumer='bob-op')=>post(t,t.bob,'authorization/preview',{nodeId:node,resourceId:'r_gpu1',incarnation:'gen1',model:'llama',consumer,maxTokens:10});

test('F1R STRESS: peer cannot replace suspension consent by disconnecting then resuming',async()=>{
 const t=await fabricEnv();const {conn,nodeB}=await connectPair(t);await commitFlow(t,conn.id);
 assert.equal((await post(t,t.alice,`connections/${conn.id}/suspend`,{expectedVersion:1})).status,200);
 assert.equal((await auth(t,nodeB.id)).json.decision,'deny');
 const d=await post(t,t.bob,`connections/${conn.id}/disconnect`,{expectedVersion:2});
 const r=await post(t,t.bob,`connections/${conn.id}/resume`,{expectedVersion:3,nodeKey:nodeB.nodeSecret});
 const a=await auth(t,nodeB.id);assert.equal(a.json.decision,'deny',`disconnect=${d.status}, resume=${r.status}, authorization=${a.text}`);
});
test('F1R STRESS: old approval cannot overwrite a newer narrowing revision',async()=>{
 const t=await fabricEnv();const {conn}=await connectPair(t);const {grant}=await commitFlow(t,conn.id);
 const old=await approved(t,conn.id,9000);const narrow=await approved(t,conn.id,50);
 assert.equal((await post(t,t.alice,`grants/${grant.id}/revise`,narrow)).status,200);
 const r=await post(t,t.alice,`grants/${grant.id}/revise`,old);const g=await get(t,t.alice,`grants/${grant.id}`);
 assert.ok(r.status>=400,`old approval returns ${r.status}, live ceiling=${g.json.ceilings.maxTokens}, version=${g.json.version}`);
});
test('F1R STRESS: one approval cannot concurrently revise two grants',async()=>{
 const t=await fabricEnv();const {conn}=await connectPair(t);const g1=(await commitFlow(t,conn.id)).grant;const g2=(await commitFlow(t,conn.id)).grant;const a=await approved(t,conn.id,9000);
 const actor={kind:'session',user:{id:t.alice.id}};
 const results=await Promise.allSettled([core.reviseGrant(t.DB,actor,g1.id,a),core.reviseGrant(t.DB,actor,g2.id,a)]);
 const ok=results.filter(x=>x.status==='fulfilled'&&x.value.status<300);
 assert.equal(ok.length,1,`shared approval applied ${ok.length} times; statuses=${JSON.stringify(results.map(x=>x.status==='fulfilled'?x.value.status:x.reason.code))}`);
});
test('F1R STRESS: audit failure after node insert must not duplicate same-key operation',async()=>{
 const t=await fabricEnv();const key=freshKey();const b={label:'audit-fault'};
 t.sqlite.exec("CREATE TRIGGER qa_audit BEFORE INSERT ON audit WHEN NEW.action='fabric.node.register' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END");
 const r=await post(t,t.alice,'nodes',b,key);assert.equal(r.status,500);t.sqlite.exec('DROP TRIGGER qa_audit');
 const retry=await post(t,t.alice,'nodes',b,key);const count=t.sqlite.prepare('SELECT count(*) n FROM fabric_nodes').get().n;
 assert.equal(count,1,`first=${r.status}, retry=${retry.status}, nodes=${count}`);
});
test('F1R STRESS: lease steal after result persistence failure must not duplicate node',async()=>{
 const t=await fabricEnv();const key=freshKey();const b={label:'persist-fault'};
 t.sqlite.exec("CREATE TRIGGER qa_persist BEFORE UPDATE ON idempotency_records BEGIN SELECT RAISE(ABORT,'synthetic persistence failure'); END");
 assert.equal((await post(t,t.alice,'nodes',b,key)).status,500);t.sqlite.exec('DROP TRIGGER qa_persist');
 t.sqlite.prepare("UPDATE idempotency_records SET created_at='2000-01-01T00:00:00.000Z' WHERE idem_key=?").run(key);
 const r=await post(t,t.alice,'nodes',b,key);const count=t.sqlite.prepare('SELECT count(*) n FROM fabric_nodes').get().n;
 assert.equal(count,1,`lease-steal returns ${r.status}; nodes=${count}`);
});
test('F1R STRESS: terminal MCP failures replay the same error envelope',async()=>{
 const t=await fabricEnv();const key=freshKey();const b={tool:'fabric.register_node',params:{label:''},idempotencyKey:key};
 const r=await post(t,t.alice,'mcp',b);const replay=await post(t,t.alice,'mcp',b);assert.equal(r.status,400);assert.equal(replay.status,400);
 assert.equal(replay.json.code,r.json.code,`initial=${r.text}; replay=${replay.text}`);assert.notEqual(replay.json.ok,true);
});
test('F1R STRESS: denied first grant must not hide allowed second grant in discovery',async()=>{
 const t=await fabricEnv();const {conn,nodeB}=await connectPair(t);await commitFlow(t,conn.id);const a=await approved(t,conn.id,1000,'allowed-op');assert.equal((await post(t,t.alice,'grants',a)).status,201);
 await post(t,t.alice,'denies',{resourceId:'r_gpu1',principal:'bob-op'});
 assert.equal((await auth(t,nodeB.id,'allowed-op')).json.decision,'allow');
 const d=await get(t,t.bob,'discovery');assert.ok(d.json.items.some(x=>x.id==='r_gpu1'),`allowed resource omitted: ${d.text}`);
});
test('F1R STRESS: live ownership drift with same incarnation fails closed',async()=>{
 const t=await fabricEnv();const {conn,nodeB}=await connectPair(t);await commitFlow(t,conn.id);
 t.sqlite.exec("UPDATE resources SET owner_id='u_bob' WHERE id='r_gpu1'");
 const r=await auth(t,nodeB.id);assert.equal(r.json.decision,'deny',`old owner grant still authorizes: ${r.text}`);
});
test('F1R STRESS: pre-repair idempotency secrets must not replay after upgrade',async()=>{
 const t=await fabricEnv();const key=freshKey();const b={label:'legacy'};const hash=await digestJson(b);
 t.sqlite.prepare('INSERT INTO idempotency_records (idem_key,actor,method,path,request_hash,status,response_code,response_body,created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(key,'session:u_alice','POST','/v1/fabric/nodes',hash,'completed',201,JSON.stringify({id:'legacy-node',nodeSecret:'SYNTHETIC_LEGACY_SECRET'}),'2000-01-01');
 const r=await post(t,t.alice,'nodes',b,key);assert.equal(r.status,201);assert.ok(!r.json.nodeSecret,`legacy secret returned on replay (synthetic)`);
});
test('F1R CONTROL: canonical corruption and live resource replacement reject revision',async()=>{
 for(const corrupt of [true,false]){
 const t=await fabricEnv();const {conn}=await connectPair(t);const {grant}=await commitFlow(t,conn.id);const a=await approved(t,conn.id);
 if(corrupt)t.sqlite.prepare("UPDATE grant_previews SET canonical_json='{}' WHERE id=?").run(a.previewId);else t.sqlite.exec("UPDATE resources SET incarnation='gen2' WHERE id='r_gpu1'");
 const r=await post(t,t.alice,`grants/${grant.id}/revise`,a);assert.equal(r.status,corrupt?500:412);assert.equal((await get(t,t.alice,`grants/${grant.id}`)).json.version,1);
 }
});
test('F1R CONTROL: resume nested reference and wrong secret cannot cross owner boundary',async()=>{
 const t=await fabricEnv();const {conn}=await connectPair(t);const {grant}=await commitFlow(t,conn.id);
 assert.equal((await post(t,t.bob,'approvals',{action:'grant.resume',targetId:grant.id})).status,404);
 await post(t,t.alice,`connections/${conn.id}/suspend`,{expectedVersion:1});
 assert.equal((await post(t,t.alice,`connections/${conn.id}/resume`,{expectedVersion:2,nodeKey:'wrong'})).status,403);
 t.sqlite.prepare('UPDATE connections SET suspended_by=NULL WHERE id=?').run(conn.id);
 assert.equal((await post(t,t.alice,`connections/${conn.id}/resume`,{expectedVersion:2,nodeKey:'wrong'})).status,409);
});
test('F1R CONTROL: invitation secret redacted in persistence and REST replay',async()=>{
 const t=await fabricEnv();const {nodeA,nodeB}=await connectPair(t);const key=freshKey();const b={issuerNode:nodeA.id,recipientNode:nodeB.id,recipientWorkspace:'default'};
 const r=await post(t,t.alice,'invitations',b,key);assert.equal(r.status,201);assert.ok(r.json.token);
 const replay=await post(t,t.alice,'invitations',b,key);assert.equal(replay.status,201);assert.ok(!replay.json.token);
 assert.ok(!t.sqlite.prepare('SELECT response_body FROM idempotency_records WHERE idem_key=?').get(key).response_body.includes(r.json.token));
});
test('F1R CONTROL: successful revoke remains terminal in both concurrency orders',async()=>{
 for(const reverse of [false,true]){
 const t=await fabricEnv();const {conn}=await connectPair(t);const {grant}=await commitFlow(t,conn.id);await post(t,t.alice,`grants/${grant.id}/pause`,{expectedVersion:1});
 const a=await post(t,t.alice,'approvals',{action:'grant.resume',targetId:grant.id});await post(t,t.alice,`approvals/${a.json.id}/decide`,{decision:'approve'});
 const actor={kind:'session',user:{id:t.alice.id}};
 const calls=[()=>core.resumeGrant(t.DB,actor,grant.id,{expectedVersion:2,approvalId:a.json.id}),()=>core.revokeGrant(t.DB,actor,grant.id,{expectedVersion:2})];if(reverse)calls.reverse();
 const r=await Promise.allSettled(calls.map(f=>f()));const revoked=r[reverse?0:1];
 if(revoked.status==='fulfilled'&&revoked.value.status===200)assert.equal((await get(t,t.alice,`grants/${grant.id}`)).json.status,'revoked');
 const current=(await get(t,t.alice,`grants/${grant.id}`)).json;
 if(current.status!=='revoked')assert.equal((await post(t,t.alice,`grants/${grant.id}/revoke`,{expectedVersion:current.version})).status,200);
 assert.ok((await post(t,t.alice,`grants/${grant.id}/resume`,{expectedVersion:current.version+1,approvalId:a.json.id})).status>=400);
 }
});
test('F1R CONTROL: removed resource hidden and denied; fresh 4xx REST replay stable',async()=>{
 const t=await fabricEnv();const {conn,nodeB}=await connectPair(t);await commitFlow(t,conn.id);t.sqlite.exec("DELETE FROM resources WHERE id='r_gpu1'");
 assert.equal((await auth(t,nodeB.id)).json.decision,'deny');assert.equal((await get(t,t.bob,'discovery')).json.total,0);
 const key=freshKey();const a=await post(t,t.alice,'nodes',{label:''},key);const b=await post(t,t.alice,'nodes',{label:''},key);assert.equal(b.status,a.status);assert.equal(b.json.code,a.json.code);
});
test('F1R SCOPE: preview consumer is caller attribution, not separate consumer authentication',async()=>{
 const t=await fabricEnv();const {conn,nodeB}=await connectPair(t);await commitFlow(t,conn.id);
 assert.equal((await auth(t,nodeB.id,'wrong-op')).json.decision,'deny');assert.equal((await auth(t,nodeB.id,'bob-op')).json.decision,'allow');
});
