// Independent review only: safety assertions intentionally fail on F1R2.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fabricEnv,connectPair,commitFlow,S,freshKey,readJson} from './qa-helpers.mjs';
import * as core from '../src/fabric/store.mjs';
const post=(t,u,p,b={},key=freshKey())=>t.call('/v1/fabric/'+p,{method:'POST',headers:S(t,u,{'Idempotency-Key':key}),body:b}).then(readJson);
const actor=t=>({kind:'session',user:{id:t.alice.id}});
async function approval(t,conn,maxTokens=9000){
 const p=await post(t,t.alice,'previews',{connectionId:conn,resourceIds:['r_gpu1'],consumers:['bob-op'],models:['llama'],maxTokens,maxRequests:10});assert.equal(p.status,201);
 const a=await post(t,t.alice,'approvals',{previewId:p.json.id});assert.equal(a.status,201);
 assert.equal((await post(t,t.alice,`approvals/${a.json.id}/decide`,{decision:'approve'})).status,200);
 return {approvalId:a.json.id,previewHash:p.json.digest};
}
function interceptRun(db,pattern,before){
 let fired=false;
 const wrap=s=>({...s,bind(...p){return wrap(s.bind(...p));},async run(){if(!fired&&pattern.test(s.sql)){fired=true;await before();}return s.run();}});
 return {...db,prepare(sql){return wrap(db.prepare(sql));}};
}
test('ARCH-1: prior joint-resume bearer proof cannot clear a later fresh owner veto',async()=>{
 const t=await fabricEnv(),{conn,nodeA,nodeB}=await connectPair(t);await commitFlow(t,conn.id);
 assert.equal((await post(t,t.alice,`connections/${conn.id}/suspend`,{expectedVersion:1})).status,200);
 assert.equal((await post(t,t.bob,`connections/${conn.id}/disconnect`,{expectedVersion:2})).status,200);
 const keys=[nodeA.nodeSecret,nodeB.nodeSecret];
 // Explicitly authorized joint resume, as in the F1R2 owner's positive test.
 assert.equal((await post(t,t.bob,`connections/${conn.id}/resume`,{expectedVersion:3,nodeKeys:keys})).status,200);
 assert.equal((await post(t,t.alice,`connections/${conn.id}/suspend`,{expectedVersion:4})).status,200);
 const r=await post(t,t.bob,`connections/${conn.id}/resume`,{expectedVersion:5,nodeKeys:keys});
 const a=await post(t,t.bob,'authorization/preview',{nodeId:nodeB.id,resourceId:'r_gpu1',incarnation:'gen1',consumer:'bob-op',model:'llama',maxTokens:1});
 assert.equal(a.json.decision,'deny',`reused prior consent: resume=${r.status}, admission=${a.json.decision}`);
});
test('ARCH-2: later-inserted approval captured before a grant change must be stale',async()=>{
 const t=await fabricEnv(),{conn}=await connectPair(t),{grant}=await commitFlow(t,conn.id);
 const narrow=await approval(t,conn.id,50),broad=await approval(t,conn.id,9000);
 assert.equal((await post(t,t.alice,`grants/${grant.id}/revise`,narrow)).status,200);
 const r=await post(t,t.alice,`grants/${grant.id}/revise`,broad);
 const g=t.sqlite.prepare('SELECT version,ceilings FROM fabric_grants WHERE id=?').get(grant.id);
 assert.ok(r.status>=400,`stale approval status=${r.status}, live=${JSON.stringify(g)}`);
});
test('ARCH-3: commit versus revise must consume one approval once globally',async()=>{
 const t=await fabricEnv(),{conn}=await connectPair(t),{grant}=await commitFlow(t,conn.id),a=await approval(t,conn.id);
 let revision;
 const db=interceptRun(t.DB,/^INSERT INTO fabric_grants /,async()=>{revision=await core.reviseGrant(t.DB,actor(t),grant.id,a);});
 const creation=await core.commitGrant(db,actor(t),a);
 const uses=t.sqlite.prepare('SELECT (SELECT count(*) FROM fabric_grants WHERE approval_id=?)+(SELECT count(*) FROM fabric_grant_revisions WHERE approval_id=?) n').get(a.approvalId,a.approvalId).n;
 assert.equal(uses,1,`create=${creation.status}, revise=${revision.status}, uses=${uses}`);
});
test('ARCH-4: completed suspension invalidates revision at write time',async()=>{
 const t=await fabricEnv(),{conn}=await connectPair(t),{grant}=await commitFlow(t,conn.id),a=await approval(t,conn.id);
 const db=interceptRun(t.DB,/^UPDATE fabric_grants SET consumers/,async()=>{assert.equal((await core.suspendConnection(t.DB,actor(t),conn.id,{expectedVersion:1})).status,200);});
 const r=await core.reviseGrant(db,actor(t),grant.id,a);
 assert.ok(r.status>=400,`revision=${r.status}; connection is suspended, grant version=${t.sqlite.prepare('SELECT version FROM fabric_grants WHERE id=?').get(grant.id).version}`);
});
test('ARCH-5: old processing attempt cannot replace a newer completed outcome',async()=>{
 const t=await fabricEnv(),key=freshKey(),args=[t.DB,actor(t),'POST','/synthetic',key,'synthetic-hash'];
 assert.equal(await core.checkIdempotency(...args),null);
 t.sqlite.prepare("UPDATE idempotency_records SET created_at='2000-01-01T00:00:00.000Z' WHERE idem_key=?").run(key);
 assert.equal(await core.checkIdempotency(...args),null);
 await core.storeIdempotency(t.DB,actor(t),key,201,{attempt:'new'});
 await core.storeIdempotency(t.DB,actor(t),key,201,{attempt:'old'});
 assert.equal((await core.checkIdempotency(...args)).body.attempt,'new');
});
test('ARCH-6: unknown-outcome retry preserves original request hash binding',async()=>{
 const t=await fabricEnv(),key=freshKey();
 t.sqlite.exec("CREATE TRIGGER qa_audit BEFORE INSERT ON audit WHEN NEW.action='fabric.node.register' BEGIN SELECT RAISE(ABORT,'synthetic'); END");
 assert.equal((await post(t,t.alice,'nodes',{label:'original'},key)).status,500);t.sqlite.exec('DROP TRIGGER qa_audit');
 const r=await post(t,t.alice,'nodes',{label:'different'},key);
 assert.equal(r.status,409,`mismatch accepted: status=${r.status}, returnedLabel=${r.json.label}`);
});
test('ARCH-7: successful reconciled creation includes its durable audit event',async()=>{
 const t=await fabricEnv(),key=freshKey();
 t.sqlite.exec("CREATE TRIGGER qa_audit BEFORE INSERT ON audit WHEN NEW.action='fabric.node.register' BEGIN SELECT RAISE(ABORT,'synthetic'); END");
 assert.equal((await post(t,t.alice,'nodes',{label:'original'},key)).status,500);t.sqlite.exec('DROP TRIGGER qa_audit');
 const r=await post(t,t.alice,'nodes',{label:'original'},key);assert.equal(r.status,200);
 assert.equal(t.sqlite.prepare("SELECT count(*) n FROM audit WHERE action='fabric.node.register'").get().n,1,'reconciled success omits original audit');
});
test('ARCH-8 CONDITIONAL: discovery uses the same exporter binding as authorization',async()=>{
 const t=await fabricEnv(),{conn,nodeB}=await connectPair(t);await commitFlow(t,conn.id);
 const now=new Date().toISOString();
 t.sqlite.prepare('INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,?,?,?)').run('u_third','Third','third@synthetic.invalid',1,now,now);
 t.sqlite.exec("UPDATE resources SET owner_id='u_third' WHERE id='r_gpu1'");
 const a=await post(t,t.bob,'authorization/preview',{nodeId:nodeB.id,resourceId:'r_gpu1',incarnation:'gen1',consumer:'bob-op',model:'llama',maxTokens:1});assert.equal(a.json.decision,'deny');
 const d=await t.call('/v1/fabric/discovery',{headers:S(t,t.bob)}).then(readJson);
 assert.equal(d.json.items.some(x=>x.id==='r_gpu1'),false,`authorization=${a.json.decision}, discovery=${d.text}`);
});
