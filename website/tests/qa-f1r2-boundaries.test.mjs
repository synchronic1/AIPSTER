import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fabricEnv,connectPair,commitFlow,S,freshKey,readJson} from './qa-helpers.mjs';
import * as core from '../src/fabric/store.mjs';
const post=(t,u,p,b={},key=freshKey())=>t.call('/v1/fabric/'+p,{method:'POST',headers:S(t,u,{'Idempotency-Key':key}),body:b}).then(readJson);
const get=(t,u,p)=>t.call('/v1/fabric/'+p,{headers:S(t,u)}).then(readJson);
const actor=t=>({kind:'session',user:{id:t.alice.id}});
async function preview(t,conn,limit=9000){const p=await post(t,t.alice,'previews',{connectionId:conn,resourceIds:['r_gpu1'],consumers:['bob-op'],models:['llama'],maxTokens:limit,maxRequests:10});assert.equal(p.status,201);return p.json}
async function approve(t,p){const a=await post(t,t.alice,'approvals',{previewId:p.id});assert.equal(a.status,201);assert.equal((await post(t,t.alice,`approvals/${a.json.id}/decide`,{decision:'approve'})).status,200);return{approvalId:a.json.id,previewHash:p.digest}}
const auth=(t,node)=>post(t,t.bob,'authorization/preview',{nodeId:node,resourceId:'r_gpu1',incarnation:'gen1',model:'llama',consumer:'bob-op',maxTokens:10});

test('R2 BOUNDARY: approval insertion order cannot override later human narrowing decision',async()=>{
 const t=await fabricEnv();const {conn}=await connectPair(t);const {grant}=await commitFlow(t,conn.id);
 const oldPreview=await preview(t,conn.id,9000);const narrowPreview=await preview(t,conn.id,50);
 const narrowPending=await post(t,t.alice,'approvals',{previewId:narrowPreview.id});assert.equal(narrowPending.status,201);
 const oldWithNewApproval=await approve(t,oldPreview);
 assert.equal((await post(t,t.alice,`approvals/${narrowPending.json.id}/decide`,{decision:'approve'})).status,200);
 const narrow={approvalId:narrowPending.json.id,previewHash:narrowPreview.digest};
 assert.equal((await post(t,t.alice,`grants/${grant.id}/revise`,narrow)).status,200);
 const r=await post(t,t.alice,`grants/${grant.id}/revise`,oldWithNewApproval);
 assert.ok(r.status>=400,`earlier decision overwrites later narrowing: ${r.status}, ceiling=${(await get(t,t.alice,`grants/${grant.id}`)).json.ceilings.maxTokens}`);
});
test('R2 BOUNDARY: commit and revise cannot both consume one approval concurrently',async()=>{
 const t=await fabricEnv();const {conn}=await connectPair(t);const {grant}=await commitFlow(t,conn.id);const a=await approve(t,await preview(t,conn.id));
 // Pause commit after its approval read; let revise claim/apply before that stale read continues.
 let release,seen;const hold=new Promise(r=>release=r);const started=new Promise(r=>seen=r);
 const delayed={...t.DB,prepare(sql){const st=t.DB.prepare(sql);return {...st,bind(...args){const b=st.bind(...args);if(sql==='SELECT * FROM approvals WHERE id = ?'&&args[0]===a.approvalId)return {...b,async first(){const row=await b.first();seen();await hold;return row}};return b}}}};
 const pending=core.commitGrant(delayed,actor(t),a);await started;const revision=await core.reviseGrant(t.DB,actor(t),grant.id,a);release();const r=await Promise.allSettled([pending,Promise.resolve(revision)]);
 const applications=t.sqlite.prepare('SELECT count(*) n FROM fabric_grants WHERE approval_id=?').get(a.approvalId).n+t.sqlite.prepare('SELECT count(*) n FROM fabric_grant_revisions WHERE approval_id=?').get(a.approvalId).n;
 assert.equal(applications,1,`approval applied ${applications} times, results=${JSON.stringify(r.map(x=>x.status==='fulfilled'?x.value.status:x.reason.code))}`);
});
test('R2 BOUNDARY: failed revision history write must reconcile history before reporting success',async()=>{
 const t=await fabricEnv();const {conn}=await connectPair(t);const {grant}=await commitFlow(t,conn.id);const a=await approve(t,await preview(t,conn.id));const key=freshKey();
 t.sqlite.exec("CREATE TRIGGER qa_history BEFORE INSERT ON fabric_grant_revisions BEGIN SELECT RAISE(ABORT,'synthetic history failure'); END");
 assert.equal((await post(t,t.alice,`grants/${grant.id}/revise`,a,key)).status,500);t.sqlite.exec('DROP TRIGGER qa_history');
 const retry=await post(t,t.alice,`grants/${grant.id}/revise`,a,key);assert.equal(retry.status,200);
 assert.equal(t.sqlite.prepare('SELECT count(*) n FROM fabric_grant_revisions WHERE grant_id=?').get(grant.id).n,1,`retry claimed success without revision history: ${retry.text}`);
});
test('R2 BOUNDARY: changed payload stays mismatch after post-insert 5xx releases record',async()=>{
 const t=await fabricEnv();const key=freshKey();t.sqlite.exec("CREATE TRIGGER qa_audit BEFORE INSERT ON audit WHEN NEW.action='fabric.node.register' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END");
 assert.equal((await post(t,t.alice,'nodes',{label:'original'},key)).status,500);t.sqlite.exec('DROP TRIGGER qa_audit');
 const r=await post(t,t.alice,'nodes',{label:'changed'},key);
 assert.equal(r.status,409,`changed request reconciled as success: ${r.text}`);
});
test('R2 BOUNDARY: recovered registration restores missing audit event',async()=>{
 const t=await fabricEnv();const key=freshKey();t.sqlite.exec("CREATE TRIGGER qa_audit BEFORE INSERT ON audit WHEN NEW.action='fabric.node.register' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END");
 await post(t,t.alice,'nodes',{label:'audit'},key);t.sqlite.exec('DROP TRIGGER qa_audit');
 assert.equal((await post(t,t.alice,'nodes',{label:'audit'},key)).status,200);
 assert.equal(t.sqlite.prepare("SELECT count(*) n FROM audit WHERE action='fabric.node.register'").get().n,1,'reconciled node has no creation audit event');
});
test('R2 BOUNDARY: discovery excludes ownership-drift grants just as authorization does',async()=>{
 const t=await fabricEnv();const {conn,nodeB}=await connectPair(t);await commitFlow(t,conn.id);
 const now=new Date().toISOString();t.sqlite.prepare('INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,?,?,?)').run('u_third','Third','third@example.com',1,now,now);
 t.sqlite.exec("UPDATE resources SET owner_id='u_third' WHERE id='r_gpu1'");assert.equal((await auth(t,nodeB.id)).json.decision,'deny');
 const d=await get(t,t.bob,'discovery');assert.ok(!d.json.items.some(x=>x.id==='r_gpu1'),`drifted resource still visible: ${d.text}`);
});
test('R2 MIGRATION: exporter backfill derives issuer from approval, not changed resource owner',async()=>{
 const t=await fabricEnv();const {conn,nodeB}=await connectPair(t);const {grant}=await commitFlow(t,conn.id);
 t.sqlite.exec('ALTER TABLE connections DROP COLUMN vetoed_by; ALTER TABLE fabric_grants DROP COLUMN exporter_id; ALTER TABLE fabric_grants DROP COLUMN last_approval_id;');
 const now=new Date().toISOString();t.sqlite.prepare('INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,?,?,?)').run('u_third','Third','third@example.com',1,now,now);
 t.sqlite.exec("UPDATE resources SET owner_id='u_third' WHERE id='r_gpu1'");
 t.sqlite.exec(await readFile(new URL('../migrations/0007_repair2.sql',import.meta.url),'utf8'));
 const row=t.sqlite.prepare('SELECT exporter_id FROM fabric_grants WHERE id=?').get(grant.id);const r=await auth(t,nodeB.id);
 assert.equal(row.exporter_id,'u_alice',`backfill assigns ${row.exporter_id}; admission=${r.json.decision}`);
});
test('R2 CONTROL: failure immediately after approval claim stays closed and requires reapproval',async()=>{
 const t=await fabricEnv();const {conn}=await connectPair(t);const {grant}=await commitFlow(t,conn.id);const a=await approve(t,await preview(t,conn.id));const key=freshKey();
 t.sqlite.exec("CREATE TRIGGER qa_grant BEFORE UPDATE ON fabric_grants BEGIN SELECT RAISE(ABORT,'synthetic write failure'); END");
 assert.equal((await post(t,t.alice,`grants/${grant.id}/revise`,a,key)).status,500);t.sqlite.exec('DROP TRIGGER qa_grant');
 assert.equal((await get(t,t.alice,`grants/${grant.id}`)).json.version,1);assert.equal((await post(t,t.alice,`grants/${grant.id}/revise`,a,key)).status,409);
 const fresh=await approve(t,await preview(t,conn.id));assert.equal((await post(t,t.alice,`grants/${grant.id}/revise`,fresh)).status,200);
});
test('R2 CONTROL: simultaneous same-key registration converges and normal payload/path binding holds',async()=>{
 const t=await fabricEnv();const key=freshKey();const r=await Promise.all([post(t,t.alice,'nodes',{label:'same'},key),post(t,t.alice,'nodes',{label:'same'},key)]);
 assert.ok(r.some(x=>x.status===201));assert.equal(t.sqlite.prepare('SELECT count(*) n FROM fabric_nodes').get().n,1);
 assert.equal((await post(t,t.alice,'nodes',{label:'other'},key)).status,409);
 assert.equal((await post(t,t.alice,'denies',{},key)).json.code,'IDEMPOTENCY_MISMATCH');
 const bob=await post(t,t.bob,'nodes',{label:'same'},key);assert.equal(bob.status,201);assert.notEqual(bob.json.id,r.find(x=>x.status===201).json.id);
});
test('R2 CONTROL: 0007 actual migration purges secrets and preserves intact exporter/veto',async()=>{
 const t=await fabricEnv();const {conn,nodeA}=await connectPair(t);const {grant}=await commitFlow(t,conn.id);await post(t,t.alice,`connections/${conn.id}/suspend`,{expectedVersion:1});
 t.sqlite.exec('ALTER TABLE connections DROP COLUMN vetoed_by; ALTER TABLE fabric_grants DROP COLUMN exporter_id; ALTER TABLE fabric_grants DROP COLUMN last_approval_id;');
 t.sqlite.prepare("INSERT INTO idempotency_records (idem_key,actor,method,path,request_hash,status,response_code,response_body,created_at) VALUES ('legacy','session:u_alice','POST','/v1/fabric/nodes','h','completed',201,?,'2000')").run(JSON.stringify({nodeSecret:'SYNTHETIC',token:'SYNTHETIC',secret:'SYNTHETIC',id:'keep'}));
 t.sqlite.exec(await readFile(new URL('../migrations/0007_repair2.sql',import.meta.url),'utf8'));
 const b=JSON.parse(t.sqlite.prepare("SELECT response_body FROM idempotency_records WHERE idem_key='legacy'").get().response_body);assert.equal(b.id,'keep');assert.ok(!b.nodeSecret&&!b.token&&!b.secret);
 assert.equal(t.sqlite.prepare('SELECT exporter_id FROM fabric_grants WHERE id=?').get(grant.id).exporter_id,'u_alice');assert.deepEqual(JSON.parse(t.sqlite.prepare('SELECT vetoed_by FROM connections WHERE id=?').get(conn.id).vetoed_by),[nodeA.id]);
});
test('R2 CONTROL: all five deterministic entity creators converge after audit failure',async()=>{
 for(const kind of ['nodes','invitations','previews','approvals','denies']){
 const t=await fabricEnv();const {conn,nodeA,nodeB}=await connectPair(t);const p=await preview(t,conn.id);const key=freshKey();
 const spec={nodes:['fabric_nodes','fabric.node.register',{label:'new'}],invitations:['invitations','fabric.invitation.create',{issuerNode:nodeA.id,recipientNode:nodeB.id,recipientWorkspace:'default'}],previews:['grant_previews','fabric.preview.create',{connectionId:conn.id,resourceIds:['r_gpu1'],consumers:['bob-op'],models:['llama'],maxTokens:10,maxRequests:1}],approvals:['approvals','fabric.approval.request',{previewId:p.id}],denies:['fabric_denies','fabric.deny.create',{resourceId:'r_gpu1'}]}[kind];
 const [table,event,body]=spec;const before=t.sqlite.prepare(`SELECT count(*) n FROM ${table}`).get().n;
 t.sqlite.exec(`CREATE TRIGGER qa_all BEFORE INSERT ON audit WHEN NEW.action='${event}' BEGIN SELECT RAISE(ABORT,'synthetic'); END`);
 assert.equal((await post(t,t.alice,kind,body,key)).status,500,kind);t.sqlite.exec('DROP TRIGGER qa_all');
 const r=await post(t,t.alice,kind,body,key);assert.equal(r.status,200,kind);assert.equal(t.sqlite.prepare(`SELECT count(*) n FROM ${table}`).get().n,before+1,kind);assert.ok(!r.json.nodeSecret&&!r.json.token);
 }
});
test('R2 CONTROL: concurrent connection restrictions cannot silently overwrite a successful veto',async()=>{
 const t=await fabricEnv();const {conn,nodeA,nodeB}=await connectPair(t);
 const r=await Promise.allSettled([core.suspendConnection(t.DB,actor(t),conn.id,{expectedVersion:1}),core.disconnectConnection(t.DB,{kind:'session',user:{id:t.bob.id}},conn.id,{expectedVersion:1})]);
 const winners=r.map((v,i)=>v.status==='fulfilled'&&v.value.status===200?i:-1).filter(i=>i>=0);assert.equal(winners.length,1);
 const row=t.sqlite.prepare('SELECT * FROM connections WHERE id=?').get(conn.id);assert.equal(row.version,2);assert.ok(JSON.parse(row.vetoed_by).includes(winners[0]===0?nodeA.id:nodeB.id));assert.notEqual(row.state,'active');
});
