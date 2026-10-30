import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fabricEnv,connectPair,commitFlow,S,K,freshKey,readJson} from './qa-helpers.mjs';
import {faultOnce} from './revision-fixtures.mjs';
const post = (t,u,p,b={},key=freshKey()) => t.call('/v1/fabric/'+p,{method:'POST',headers:S(t,u,{'Idempotency-Key':key}),body:b}).then(readJson);
const get = (t,u,p) => t.call('/v1/fabric/'+p,{headers:S(t,u)}).then(readJson);
async function approved(t,u,conn,resource='r_gpu1') {
 const p=await post(t,u,'previews',{connectionId:conn,resourceIds:[resource],consumers:['bob-op'],models:['llama'],maxTokens:1000,maxRequests:10}); assert.equal(p.status,201);
 const a=await post(t,u,'approvals',{previewId:p.json.id}); assert.equal(a.status,201);
 assert.equal((await post(t,u,`approvals/${a.json.id}/decide`,{decision:'approve'})).status,200);
 return {approvalId:a.json.id,previewHash:p.json.digest};
}
const auth = (t,node) => post(t,t.bob,'authorization/preview',{nodeId:node,resourceId:'r_gpu1',incarnation:'gen1',model:'llama',consumer:'bob-op',maxTokens:10});

test('QA SECURITY: revision must reject approval for a different recipient connection',async()=>{
 const t=await fabricEnv(); const pair=await connectPair(t); const {grant}=await commitFlow(t,pair.conn.id);
 const pair2=await connectPair(t); const approval=await approved(t,t.alice,pair2.conn.id);
 const r=await post(t,t.alice,`grants/${grant.id}/revise`,approval);
 assert.ok(r.status>=400,`BUG: unrelated recipient preview revised original grant: ${r.status} ${r.text}`);
});
test('QA SECURITY: revision must reject another owner approval/resources',async()=>{
 const t=await fabricEnv(); const {conn}=await connectPair(t); const {grant}=await commitFlow(t,conn.id);
 t.sqlite.exec("INSERT INTO resources(id,owner_id,name,kind,origin,cpu,gpu,capabilities_json,configured,authenticated,online,usable,heartbeat_at,limits_json,scope,verification_json,credits_json,created_at,incarnation,imported_from) SELECT 'r_bob', 'u_bob', name,kind,origin,cpu,gpu,capabilities_json,configured,authenticated,online,usable,heartbeat_at,limits_json,scope,verification_json,credits_json,created_at,incarnation,imported_from FROM resources WHERE id='r_gpu1'");
 const a=await approved(t,t.bob,conn.id,'r_bob');
 const r=await post(t,t.alice,`grants/${grant.id}/revise`,a);
 assert.ok(r.status>=400,`BUG: Alice revised her grant with Bob's approval/resources: ${r.status} ${r.text}`);
});
test('QA SECURITY: stale connection vector must reject revision',async()=>{
 const t=await fabricEnv(); const {conn,nodeA}=await connectPair(t); const {grant}=await commitFlow(t,conn.id); const a=await approved(t,t.alice,conn.id);
 assert.equal((await post(t,t.alice,`connections/${conn.id}/suspend`,{expectedVersion:1})).status,200);
 assert.equal((await post(t,t.alice,`connections/${conn.id}/resume`,{expectedVersion:2,nodeKey:nodeA.nodeSecret})).status,200);
 const r=await post(t,t.alice,`grants/${grant.id}/revise`,a);
 assert.equal(r.status,412,`BUG: stale revision accepted: ${r.text}`);
});
test('QA SECURITY: peer cannot reactivate exporter-disconnected sharing',async()=>{
 const t=await fabricEnv(); const {conn,nodeB}=await connectPair(t); await commitFlow(t,conn.id);
 assert.equal((await post(t,t.alice,`connections/${conn.id}/disconnect`,{expectedVersion:1})).status,200);
 assert.equal((await auth(t,nodeB.id)).json.decision,'deny');
 const r=await post(t,t.bob,`connections/${conn.id}/resume`,{expectedVersion:2,nodeKey:nodeB.nodeSecret});
 const after=await auth(t,nodeB.id);
 assert.equal(after.json.decision,'deny',`BUG: Bob resumed Alice disconnect (${r.status}), admission ${after.text}`);
});
test('QA SECURITY: discovery hides globally denied resource',async()=>{
 const t=await fabricEnv(); const {conn,nodeB}=await connectPair(t); await commitFlow(t,conn.id);
 await post(t,t.alice,'denies',{resourceId:'r_gpu1'});
 assert.equal((await auth(t,nodeB.id)).json.decision,'deny');
 const d=await get(t,t.bob,'discovery'); assert.equal(d.json.items.some(x=>x.id==='r_gpu1'),false,`BUG: denied resource disclosed: ${d.text}`);
});
test('QA SECURITY: live incarnation drift invalidates authorization',async()=>{
 const t=await fabricEnv(); const {conn,nodeB}=await connectPair(t); await commitFlow(t,conn.id);
 t.sqlite.exec("UPDATE resources SET incarnation='gen2' WHERE id='r_gpu1'");
 const r=await auth(t,nodeB.id); assert.equal(r.json.decision,'deny',`BUG: old incarnation still authorizes: ${r.text}`);
});
test('QA SECURITY: failed write idempotency returns stable failure, not permanent processing',async()=>{
 const t=await fabricEnv(); const key=freshKey(); const r=await post(t,t.alice,'nodes',{label:''},key); assert.equal(r.status,400);
 const again=await post(t,t.alice,'nodes',{label:''},key); assert.equal(again.status,400,`BUG: terminal validation error stuck pending: ${again.text}`);
});
test('QA SECURITY: unknown outcome after invitation flip reconciles on retry',async()=>{
 const t=await fabricEnv(); const a=await post(t,t.alice,'nodes',{label:'a'}); const b=await post(t,t.bob,'nodes',{label:'b'});
 const inv=await post(t,t.alice,'invitations',{issuerNode:a.json.id,recipientNode:b.json.id,recipientWorkspace:'default'});
 t.sqlite.exec("CREATE TRIGGER qa_fail BEFORE INSERT ON connections BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
 const body={token:inv.json.token,nodeId:b.json.id,nodeKey:b.json.nodeSecret}; const key=freshKey();
 assert.equal((await post(t,t.bob,'invitations/accept',body,key)).status,500); t.sqlite.exec('DROP TRIGGER qa_fail');
 const retry=await post(t,t.bob,'invitations/accept',body,key); const fresh=await post(t,t.bob,'invitations/accept',body);
 assert.ok(retry.status<300 || fresh.status<300,`BUG: burned invite without connection; same key=${retry.text}; new key=${fresh.text}; connections=${t.sqlite.prepare('SELECT count(*) n FROM connections').get().n}`);
});
test('QA CONTROL: agent self-asserted human approval and MCP forbidden',async()=>{
 const t=await fabricEnv(); const {conn}=await connectPair(t); const a=await approved(t,t.alice,conn.id);
 for(const scope of ['inference','read']) for(const p of ['nodes','invitations','previews','approvals',`approvals/${a.approvalId}/decide`,'grants']) {
  const r=await t.call('/v1/fabric/'+p,{method:'POST',headers:K(t,scope,{'Idempotency-Key':freshKey()}),body:{...a,decision:'approve',kind:'session',human:true,approver:'u_alice'}}).then(readJson); assert.equal(r.status,403,p);
 }
 const r=await t.call('/v1/fabric/mcp',{method:'POST',headers:K(t,'inference'),body:{tool:'fabric.decide_approval',params:{id:a.approvalId,decision:'approve',human:true},idempotencyKey:freshKey()}}).then(readJson);assert.equal(r.status,403);
});
test('QA CONTROL: invitation expiry/workspace proof, no imported re-export, disabled owner',async()=>{
 const t=await fabricEnv(); const {conn,nodeA,nodeB}=await connectPair(t);
 const inv=await post(t,t.alice,'invitations',{issuerNode:nodeA.id,recipientNode:nodeB.id,recipientWorkspace:'wrong'});
 assert.equal((await post(t,t.bob,'invitations/accept',{token:inv.json.token,nodeId:nodeB.id,nodeKey:nodeB.nodeSecret})).status,403);
 const exp=await post(t,t.alice,'invitations',{issuerNode:nodeA.id,recipientNode:nodeB.id,recipientWorkspace:'default'});
 t.sqlite.prepare("UPDATE invitations SET expiry='2000-01-01' WHERE id=?").run(exp.json.id);
 assert.equal((await post(t,t.bob,'invitations/accept',{token:exp.json.token,nodeId:nodeB.id,nodeKey:nodeB.nodeSecret})).status,410);
 t.sqlite.exec("UPDATE resources SET imported_from='peer' WHERE id='r_gpu1'");
 assert.equal((await post(t,t.alice,'previews',{connectionId:conn.id,resourceIds:['r_gpu1'],consumers:['x'],models:['llama'],maxTokens:1,maxRequests:1})).status,422);
 t.sqlite.exec("UPDATE user SET disabled=1 WHERE id='u_alice'"); assert.equal((await get(t,t.alice,'nodes')).status,401);
});
for(const first of ['revoke','resume']) test(`QA SECURITY: deterministic ${first}-first revoke/resume CAS ordering`,async c=>{
 const t=await fabricEnv(); const {conn}=await connectPair(t); const {grant}=await commitFlow(t,conn.id);
 c.after(()=>t.sqlite.close());
 await post(t,t.alice,`grants/${grant.id}/pause`,{expectedVersion:1});
 const a=await post(t,t.alice,'approvals',{action:'grant.resume',targetId:grant.id});
 await post(t,t.alice,`approvals/${a.json.id}/decide`,{decision:'approve'});
 const core=await import('../src/fabric/store.mjs'); const actor={kind:'session',user:{id:t.alice.id}};
 let winner;
 const ordered=faultOnce(t.DB,/UPDATE fabric_grants SET status/,'before',true,async()=>{
  winner=first==='revoke'
   ?await core.revokeGrant(t.DB,actor,grant.id,{expectedVersion:2})
   :await core.resumeGrant(t.DB,actor,grant.id,{expectedVersion:2,approvalId:a.json.id});
 });
 const loser=first==='revoke'
  ?await core.resumeGrant(ordered,actor,grant.id,{expectedVersion:2,approvalId:a.json.id})
  :await core.revokeGrant(ordered,actor,grant.id,{expectedVersion:2});
 assert.equal(winner.status,200);
 const row=t.sqlite.prepare('SELECT status,version FROM fabric_grants WHERE id=?').get(grant.id);
 assert.equal(row.version,3);
 if(first==='revoke'){
  assert.equal(row.status,'revoked');assert.equal(loser.status,409);assert.equal(loser.body.code,'BAD_STATE');
  assert.equal(t.sqlite.prepare("SELECT count(*) n FROM audit WHERE action='fabric.grant.resume' AND target=?").get(grant.id).n,0);
 }else{
  assert.equal(row.status,'enforced');assert.equal(loser.status,412);assert.equal(loser.body.code,'VERSION_MISMATCH');
  assert.equal(t.sqlite.prepare("SELECT count(*) n FROM audit WHERE action='fabric.grant.revoke' AND target=?").get(grant.id).n,0);
  assert.equal((await core.revokeGrant(t.DB,actor,grant.id,{expectedVersion:3})).status,200);
  const revoked=t.sqlite.prepare('SELECT status,version FROM fabric_grants WHERE id=?').get(grant.id);
  assert.equal(revoked.status,'revoked');assert.equal(revoked.version,4);
  await assert.rejects(core.resumeGrant(t.DB,actor,grant.id,{expectedVersion:4,approvalId:a.json.id}),{code:'BAD_STATE'});
 }
});
test('QA SECURITY: unrelated owner cannot request preview approval and retrieve digest',async()=>{
 const t=await fabricEnv(); const {conn}=await connectPair(t);
 const p=await post(t,t.alice,'previews',{connectionId:conn.id,resourceIds:['r_gpu1'],consumers:['bob-op'],models:['llama'],maxTokens:1,maxRequests:1});
 const now=new Date().toISOString(); t.sqlite.prepare('INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,?,?,?)').run('u_third','Third','third@example.com',1,now,now);
 t.sqlite.prepare('INSERT INTO session (id,expiresAt,token,createdAt,updatedAt,userId) VALUES (?,?,?,?,?,?)').run('s_third','2099-01-01','qa-third-token',now,now,'u_third');
 const r=await post(t,{id:'u_third',token:'qa-third-token'},'approvals',{previewId:p.json.id});
 assert.ok(r.status>=400,`BUG: non-exporting owner reads preview digest: ${r.text}`);
});
test('QA CONTROL: disabled routes remain 404 across representative REST and MCP mutations',async()=>{
 const t=await fabricEnv({flag:false});
 for(const p of ['nodes','invitations','invitations/accept','previews','approvals','grants','denies','authorization/preview','mcp','connections/conn_x/resume','grants/fg_x/revise']) assert.equal((await post(t,t.alice,p)).status,404,p);
});
test('QA CONTROL: preview digest binds recipient, resources, limits; stale commit denied',async()=>{
 const {digestJson}=await import('../src/fabric/canonical.mjs'); const t=await fabricEnv();const {conn}=await connectPair(t);
 const p=await post(t,t.alice,'previews',{connectionId:conn.id,resourceIds:['r_gpu1'],consumers:['bob-op'],models:['llama'],maxTokens:1,maxRequests:1});
 for(const [field,value] of [['importerNode','other'],['snapshot',[]],['ceilings',{maxTokens:999,maxRequests:999}]]) assert.notEqual(await digestJson({...p.json.preview,[field]:value}),p.json.digest);
 const a=await approved(t,t.alice,conn.id); await post(t,t.alice,`connections/${conn.id}/suspend`,{expectedVersion:1});
 assert.equal((await post(t,t.alice,'grants',a)).status,409);
});
test('QA SECURITY: one-time node secret must not persist as plaintext in idempotency records',async()=>{
 const t=await fabricEnv();const r=await post(t,t.alice,'nodes',{label:'one-time'});assert.equal(r.status,201);
 const rows=t.sqlite.prepare('SELECT response_body FROM idempotency_records').all();
 assert.ok(!rows.some(x=>x.response_body?.includes(r.json.nodeSecret)),'BUG: raw node secret durably stored in idempotency response_body');
});
test('QA CONTROL: cross-owner idempotency separated; MCP JSON-RPC unsupported as documented',async()=>{
 const t=await fabricEnv();const key=freshKey();const a=await post(t,t.alice,'nodes',{label:'same'},key);const b=await post(t,t.bob,'nodes',{label:'same'},key);assert.equal(a.status,201);assert.equal(b.status,201);assert.notEqual(a.json.id,b.json.id);
 const r=await post(t,t.alice,'mcp',{jsonrpc:'2.0',id:1,method:'tools/list'});assert.equal(r.status,400);assert.equal(r.json.code,'BAD_TOOL');
});
