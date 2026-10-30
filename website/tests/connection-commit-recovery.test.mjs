// Actual SQLite/native D1 fault and scheduler boundaries; synthetic users only.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {revisionFixture,faultOnce} from './revision-fixtures.mjs';
import * as core from '../src/fabric/store.mjs';
import {handleFabric} from '../src/fabric/router.mjs';
import {budgetWindow} from '../src/lib/quotas.js';
import {MAX_RETAINED_FABRIC_OPERATIONS} from '../src/fabric/admission.mjs';

async function fixture(c,real,connection=false){
 c.mock.timers.enable({apis:['Date'],now:Date.now()});
 const t=await revisionFixture(real);c.after(t.close);
 if(!connection)return {...t,path:'/v1/fabric/grants',input:await t.approval(100),key:'commit-recovery'};
 const a=(await core.registerNode(t.db,t.alice,{label:'resume-a'})).body;
 const b=(await core.registerNode(t.db,t.bob,{label:'resume-b'})).body;
 const inv=(await core.createInvitation(t.db,t.alice,{issuerNode:a.id,recipientNode:b.id,recipientWorkspace:'default'})).body;
 const conn=(await core.acceptInvitation(t.db,t.bob,{token:inv.token,nodeId:b.id,nodeKey:b.nodeSecret})).body.id;
 assert.equal((await core.suspendConnection(t.db,t.alice,conn,{expectedVersion:1})).status,200);
 return {...t,conn,a,b,path:`/v1/fabric/connections/${conn}/resume`,input:{expectedVersion:2,nodeKey:a.nodeSecret},key:'connection-recovery'};
}
async function route(t,{db=t.db,input=t.input,key=t.key,actor=t.alice,mcp=false}={}){
 const url=new URL(mcp?'/v1/fabric/mcp':t.path,'https://synthetic.invalid');
 const body=mcp?{tool:t.path.includes('/connections/')?'fabric.resume_connection':'fabric.commit_grant',params:{...(t.path.includes('/connections/')?{id:t.conn}:{}),...input},idempotencyKey:key}:input;
 const request=new Request(url,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':key},body:JSON.stringify(body)});
 const r=await handleFabric({db,actor,url,request,env:{FEDERATION_ENABLED:'1'},json:(status,data)=>Response.json(data,{status}),needSession:()=>null,needCsrf:()=>null,needAuthz:()=>null,needNotDemo:()=>null});
 return {status:r.status,body:await r.json()};
}
async function snapshot(t){
 const s={};for(const table of ['connections','connection_vetoes','fabric_grants','approvals','fabric_restriction_receipts','audit'])s[table]=(await t.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results;
 return s;
}
async function ledger(t){return t.db.prepare('SELECT * FROM idempotency_records WHERE idem_key=? AND actor=?').bind(t.key,`session:${t.alice.user.id}`).first()}
async function expire(t){await t.db.prepare("UPDATE idempotency_records SET created_at='2000-01-01' WHERE idem_key=?").bind(t.key).run()}
function hold(db,pattern){
 let entered,release;const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
 return {ready,release,db:faultOnce(db,pattern,'before',true,async()=>{entered();await gate})};
}
function closeAtAttempt(t,field){
 let fired=false;
 const wrap=(raw,sql)=>({raw,sql,bind:(...p)=>wrap(raw.bind(...p),sql),run:(...p)=>raw.run(...p),all:(...p)=>raw.all(...p),async first(...p){if(!fired&&/SELECT attempt FROM idempotency_records/.test(sql)){fired=true;await t.db.prepare(`UPDATE "user" SET ${field}=1 WHERE id=?`).bind(t.alice.user.id).run()}return raw.first(...p)}});
 return {prepare:sql=>wrap(t.db.prepare(sql),sql),exec:sql=>t.db.exec(sql),batch:stmts=>t.db.batch(stmts.map(s=>s.raw||s))};
}
async function assertPending(t){const r=await ledger(t);assert.equal(r.status,'uncertain');assert.equal(r.response_code,null);assert.equal(r.response_body,null)}
async function noGrowth(t,count){assert.equal((await t.db.prepare('SELECT count(*) n FROM fabric_operation_admissions WHERE owner_id=?').bind(t.alice.user.id).first()).n,count)}
async function commitOnKnownConnection(c,real){
 const t=await fixture(c,real,true);assert.equal((await core.resumeConnection(t.db,t.alice,t.conn,t.input)).status,200);
 t.path='/v1/fabric/grants';t.key='precondition-commit';
 t.freshApproval=async()=>{
  const preview=(await core.createPreview(t.db,t.alice,{connectionId:t.conn,resourceIds:['r_gpu1'],consumers:['bob-op'],models:['llama'],maxTokens:100,maxRequests:10})).body;
  const approval=(await core.requestApproval(t.db,t.alice,{previewId:preview.id})).body;
  assert.equal((await core.decideApproval(t.db,t.alice,approval.id,{decision:'approve'})).status,200);
  return {approvalId:approval.id,previewHash:preview.digest};
 };
 t.input=await t.freshApproval();return t;
}
function beforeRead(db,pattern,hook){
 let fired=false;
 const wrap=(raw,sql)=>({raw,sql,bind:(...p)=>wrap(raw.bind(...p),sql),run:(...p)=>raw.run(...p),all:(...p)=>raw.all(...p),async first(...p){if(!fired&&pattern.test(sql)){fired=true;await hook()}return raw.first(...p)}});
 return {prepare:sql=>wrap(db.prepare(sql),sql),exec:sql=>db.exec(sql),batch:stmts=>db.batch(stmts.map(s=>s.raw||s))};
}

for(const real of [false,true]){
 const engine=real?'local D1':'sqlite';
 for(const boundary of ['withdrawal','connection','receipt','audit'])test(`${engine}: connection resume ${boundary} persistence fault rolls back veto, epoch, receipt and audit`,async c=>{
  const t=await fixture(c,real,true),before=await snapshot(t);
  const clause=boundary==='withdrawal'?'BEFORE DELETE ON connection_vetoes':boundary==='connection'?'BEFORE UPDATE ON connections':boundary==='receipt'?'BEFORE INSERT ON fabric_restriction_receipts':"BEFORE INSERT ON audit WHEN NEW.action='fabric.connection.resume'";
  await t.db.prepare(`CREATE TRIGGER resume_connection_fault ${clause} BEGIN SELECT RAISE(ABORT,'synthetic connection resume fault'); END`).run();
  const first=await route(t);assert.equal(first.status,500);assert.deepEqual(await snapshot(t),before);await assertPending(t);
  await t.db.prepare('DROP TRIGGER resume_connection_fault').run();
  const applied=await route(t);assert.equal(applied.status,200);assert.equal(applied.body.state,'active');
  const after=await snapshot(t),receipt=after.fabric_restriction_receipts.find(r=>r.action==='fabric.connection.resume');
  const audits=after.audit.filter(r=>r.action==='fabric.connection.resume');assert.equal(audits.length,1);assert.equal(receipt.applied_at,audits[0].at);
  assert.equal(audits[0].detail,'withdrew 1, 0 remain via session');assert.deepEqual(JSON.parse(receipt.response_body),{id:t.conn,state:'active',withdrawn:[t.a.id],remainingVetoes:[]});
  assert.ok(!JSON.stringify(receipt).includes(t.a.nodeSecret));assert.equal((await ledger(t)).response_code,200);
 });
 for(const later of ['suspend','disconnect'])test(`${engine}: connection unknown batch result recovers immutable response after later ${later}`,async c=>{
  const t=await fixture(c,real,true),op={key:t.key,path:t.path};
  const expected={status:200,body:{id:t.conn,state:'active',withdrawn:[t.a.id],remainingVetoes:[]}};
  const unknown=faultOnce(t.db,/DELETE FROM connection_vetoes/,'after',true);
  assert.deepEqual(await core.resumeConnection(unknown,t.alice,t.conn,t.input,op),expected);
  assert.equal((await core[`${later}Connection`](t.db,t.bob,t.conn,{expectedVersion:3})).status,200);
  const before=await snapshot(t);for(let i=0;i<3;i++)assert.deepEqual(await core.resumeConnection(t.db,t.alice,t.conn,t.input,op),expected);
  assert.deepEqual(await snapshot(t),before);
  await assert.rejects(core.resumeConnection(t.db,t.alice,t.conn,{...t.input,nodeKey:'forged'},op),{code:'IDEMPOTENCY_CONFLICT'});
  await assert.rejects(core.resumeConnection(t.db,t.alice,t.conn,t.input,{...op,key:'fresh'}),{code:'VERSION_MISMATCH'});
 });
 test(`${engine}: direct connection call reconciles its own lost batch response without stable router context`,async c=>{
  const t=await fixture(c,real,true);
  const result=await core.resumeConnection(faultOnce(t.db,/DELETE FROM connection_vetoes/,'after',true),t.alice,t.conn,t.input);
  assert.equal(result.status,200);assert.equal(result.body.state,'active');
  assert.equal((await t.db.prepare("SELECT count(*) n FROM audit WHERE action='fabric.connection.resume'").first()).n,1);
 });
 for(const mcp of [false,true])test(`${engine}: ${mcp?'MCP':'REST'} lost connection finalization survives later peer restriction with live-owner checks`,async c=>{
  const t=await fixture(c,real,true),lost=faultOnce(t.db,/UPDATE idempotency_records SET status = \?, response_code/);
  const first=await route(t,{db:lost,mcp});assert.equal(first.status,500);await expire(t);
  assert.equal((await core.disconnectConnection(t.db,t.bob,t.conn,{expectedVersion:3})).status,200);const before=await snapshot(t);
  for(const [field,status] of [['disabled',401],['demo',403]]){
   await t.db.prepare(`UPDATE "user" SET ${field}=1 WHERE id=?`).bind(t.alice.user.id).run();assert.equal((await route(t,{mcp})).status,status);
   await t.db.prepare(`UPDATE "user" SET ${field}=0 WHERE id=?`).bind(t.alice.user.id).run();
  }
  const replay=await route(t,{mcp});assert.equal(replay.status,200);assert.deepEqual(mcp?replay.body.result:{id:replay.body.id,state:replay.body.state,withdrawn:replay.body.withdrawn,remainingVetoes:replay.body.remainingVetoes},{id:t.conn,state:'active',withdrawn:[t.a.id],remainingVetoes:[]});
  assert.deepEqual(await snapshot(t),before);assert.equal((await ledger(t)).response_code,200);
  const changed=await route(t,{mcp,input:{...t.input,nodeKey:'forged'}});assert.equal(changed.status,409);
  const keyActor={kind:'key',user:t.alice.user};await assert.rejects(core.resumeConnection(t.db,keyActor,t.conn,t.input,{key:t.key,path:t.path}),{code:'HUMAN_REQUIRED'});
 });
 test(`${engine}: two same-op connection attempts converge after winner withdrawal and later disconnect`,async c=>{
  const t=await fixture(c,real,true),a=hold(t.db,/DELETE FROM connection_vetoes/),b=hold(t.db,/DELETE FROM connection_vetoes/);c.after(a.release);c.after(b.release);
  const original=route(t,{db:a.db});await a.ready;await expire(t);const takeover=route(t,{db:b.db});await b.ready;
  a.release();assert.equal((await original).status,200);assert.equal((await core.disconnectConnection(t.db,t.bob,t.conn,{expectedVersion:3})).status,200);
  const before=await snapshot(t);b.release();assert.equal((await takeover).status,200);assert.equal((await ledger(t)).response_code,200);assert.deepEqual(await snapshot(t),before);
 });
 test(`${engine}: partial withdrawal receipt preserves the peer veto after later complete withdrawal`,async c=>{
  const t=await fixture(c,real,true);await core.disconnectConnection(t.db,t.bob,t.conn,{expectedVersion:2});t.input.expectedVersion=3;
  const op={key:t.key,path:t.path},first=await core.resumeConnection(t.db,t.alice,t.conn,t.input,op);
  assert.deepEqual(first.body,{id:t.conn,state:'disconnected',withdrawn:[t.a.id],remainingVetoes:[t.b.id]});
  const peer=await core.resumeConnection(t.db,t.bob,t.conn,{expectedVersion:4,nodeKey:t.b.nodeSecret});assert.equal(peer.body.state,'active');
  const before=await snapshot(t);assert.deepEqual(await core.resumeConnection(t.db,t.alice,t.conn,t.input,op),first);assert.deepEqual(await snapshot(t),before);
 });
 for(const ceiling of ['hour','retention'])test(`${engine}: connection historical completion remains charged once at ${ceiling} ceiling`,async c=>{
  const t=await fixture(c,real,true),lost=faultOnce(t.db,/UPDATE idempotency_records SET status = \?, response_code/);
  assert.equal((await route(t,{db:lost})).status,500);await expire(t);
  if(ceiling==='hour')await t.db.prepare('UPDATE write_budget SET count=120 WHERE user_id=? AND window=?').bind(t.alice.user.id,budgetWindow()).run();
  else await t.db.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<?) INSERT INTO fabric_operation_admissions(owner_id,actor_kind,idem_key,method,path,request_hash,admitted_at) SELECT ?,'key','ceiling-'||x,'POST','/synthetic','h','2026-01-01' FROM n`).bind(MAX_RETAINED_FABRIC_OPERATIONS-1,t.alice.user.id).run();
  const count=(await t.db.prepare('SELECT count(*) n FROM fabric_operation_admissions WHERE owner_id=?').bind(t.alice.user.id).first()).n;
  assert.equal((await route(t)).status,200);await noGrowth(t,count);
  const fresh=await route(t,{key:'fresh-expansion'});assert.equal(fresh.status,ceiling==='hour'?429:409);await noGrowth(t,count);
 });
 for(const race of ['consumed','claim-race'])test(`${engine}: commit ${race} exact-operation takeover stays uncertain until original grant settles`,async c=>{
  const t=await fixture(c,real),a=hold(t.db,/INSERT INTO fabric_grants/);c.after(a.release);let original,takeover;
  if(race==='consumed'){
   original=route(t,{db:a.db});await a.ready;await expire(t);takeover=await route(t);
  }else{
   let entered,releaseClaim;const readyClaim=new Promise(r=>entered=r),claimGate=new Promise(r=>releaseClaim=r);c.after(releaseClaim);
   const first=faultOnce(a.db,/UPDATE approvals SET consumed_at/,'before',false,async()=>{entered();await claimGate});
   original=route(t,{db:first});await readyClaim;await expire(t);
   const b=faultOnce(t.db,/UPDATE approvals SET consumed_at/,'before',false,async()=>{releaseClaim();await a.ready});
   takeover=await route(t,{db:b});
  }
  assert.equal(takeover.status,503);assert.equal(takeover.body.code,'COMMIT_UNCERTAIN');await assertPending(t);
  const pending=await snapshot(t);assert.equal(pending.fabric_grants.filter(g=>g.approval_id===t.input.approvalId).length,0);
  a.release();assert.equal((await original).status,201);
  const row=await t.db.prepare('SELECT * FROM fabric_grants WHERE approval_id=?').bind(t.input.approvalId).first();
  await core.revokeGrant(t.db,t.alice,row.id,{expectedVersion:1});const before=await snapshot(t);
  for(let i=0;i<3;i++){const replay=await route(t);assert.equal(replay.status,200);assert.equal(replay.body.id,row.id)}
  assert.deepEqual(await snapshot(t),before);assert.equal((await ledger(t)).response_code,200);
 });
 test(`${engine}: outstanding commit preserves request/operation binding and bounded admission at both ceilings`,async c=>{
  const t=await fixture(c,real),a=hold(t.db,/INSERT INTO fabric_grants/);c.after(a.release);
  const original=route(t,{db:a.db});await a.ready;await expire(t);
  assert.equal((await route(t,{input:{...t.input,previewHash:'changed'}})).status,409);
  const foreign=await core.commitGrant(t.db,t.alice,t.input,{key:'foreign-operation',path:t.path});assert.equal(foreign.status,409);assert.equal(foreign.body.code,'APPROVAL_CONSUMED');
  await t.db.prepare('UPDATE write_budget SET count=120 WHERE user_id=? AND window=?').bind(t.alice.user.id,budgetWindow()).run();
  await t.db.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<?) INSERT INTO fabric_operation_admissions(owner_id,actor_kind,idem_key,method,path,request_hash,admitted_at) SELECT ?,'key','pending-'||x,'POST','/synthetic','h','2026-01-01' FROM n`).bind(MAX_RETAINED_FABRIC_OPERATIONS-1,t.alice.user.id).run();
  for(let i=0;i<3;i++){assert.equal((await route(t)).status,503);await assertPending(t)}await noGrowth(t,MAX_RETAINED_FABRIC_OPERATIONS);
  assert.equal((await t.db.prepare('SELECT count FROM write_budget WHERE user_id=? AND window=?').bind(t.alice.user.id,budgetWindow()).first()).count,120);
  a.release();assert.equal((await original).status,201);assert.equal((await route(t)).status,200);await noGrowth(t,MAX_RETAINED_FABRIC_OPERATIONS);
 });
 test(`${engine}: MCP outstanding commit releases uncertainty and later replays without restoring revoked access`,async c=>{
  const t=await fixture(c,real),a=hold(t.db,/INSERT INTO fabric_grants/);c.after(a.release);
  const original=route(t,{db:a.db,mcp:true});await a.ready;await expire(t);
  const takeover=await route(t,{mcp:true});assert.equal(takeover.status,503);await assertPending(t);
  a.release();assert.equal((await original).status,201);
  const grant=await t.db.prepare('SELECT id FROM fabric_grants WHERE approval_id=?').bind(t.input.approvalId).first();await core.revokeGrant(t.db,t.alice,grant.id,{expectedVersion:1});
  const before=await snapshot(t),replay=await route(t,{mcp:true});assert.equal(replay.status,200);assert.equal(replay.body.result.id,grant.id);assert.equal((await ledger(t)).response_code,200);assert.deepEqual(await snapshot(t),before);
 });
 test(`${engine}: zero-effect old commit cannot finalize over newer uncertainty; fresh consent recovers safely`,async c=>{
  const t=await fixture(c,real),a=hold(t.db,/INSERT INTO fabric_grants/);c.after(a.release);
  const original=route(t,{db:a.db});await a.ready;await expire(t);assert.equal((await route(t)).status,503);await assertPending(t);
  await t.db.prepare("UPDATE resources SET incarnation='after-claim-generation' WHERE id='r_gpu1'").run();a.release();assert.equal((await original).status,503);await assertPending(t);
  const before=await snapshot(t);for(let i=0;i<3;i++){assert.equal((await route(t)).status,503);await assertPending(t)}assert.deepEqual(await snapshot(t),before);
  const input=await t.approval(75),fresh=await route(t,{input,key:'fresh-consent-after-zero'});assert.equal(fresh.status,201);
  assert.equal((await t.db.prepare('SELECT count(*) n FROM fabric_grants WHERE approval_id=?').bind(t.input.approvalId).first()).n,0);
 });
 for(const [field,status] of [['disabled',401],['demo',403]])test(`${engine}: ${field} takeover cannot cache denial over an older held commit`,async c=>{
  const t=await fixture(c,real),a=hold(t.db,/INSERT INTO fabric_grants/);c.after(a.release);const original=route(t,{db:a.db});await a.ready;await expire(t);
  const denied=await route(t,{db:closeAtAttempt(t,field)});assert.equal(denied.status,status);assert.equal(denied.body.id,undefined);await assertPending(t);
  await t.db.prepare(`UPDATE "user" SET ${field}=0 WHERE id=?`).bind(t.alice.user.id).run();a.release();assert.equal((await original).status,201);
  const grant=await t.db.prepare('SELECT id FROM fabric_grants WHERE approval_id=?').bind(t.input.approvalId).first();await core.revokeGrant(t.db,t.alice,grant.id,{expectedVersion:1});
  const before=await snapshot(t);const replay=await route(t);assert.equal(replay.status,200);assert.equal(replay.body.id,grant.id);assert.deepEqual(await snapshot(t),before);
 });
 for(const boundary of ['lost-result','SQL-failure','zero-effect'])test(`${engine}: commit ${boundary} never guesses success or reuses spent consent for another effect`,async c=>{
  const t=await fixture(c,real);let first;
  if(boundary==='lost-result')first=await route(t,{db:faultOnce(t.db,/INSERT INTO fabric_grants/,'after',true)});
  if(boundary==='SQL-failure'){
   await t.db.prepare("CREATE TRIGGER commit_fault BEFORE INSERT ON fabric_grants BEGIN SELECT RAISE(ABORT,'synthetic commit insert failure'); END").run();
   first=await route(t);await t.db.prepare('DROP TRIGGER commit_fault').run();
  }
  if(boundary==='zero-effect'){
   const zero=faultOnce(t.db,/INSERT INTO fabric_grants/,'before',true,async()=>{await t.db.prepare("UPDATE resources SET incarnation='changed-generation' WHERE id='r_gpu1'").run()});first=await route(t,{db:zero});
  }
  assert.equal(first.status,boundary==='zero-effect'?503:500);const before=await snapshot(t);
  const applied=before.fabric_grants.filter(g=>g.approval_id===t.input.approvalId);
  assert.equal(applied.length,boundary==='lost-result'?1:0);
  if(boundary==='lost-result'){
   await core.revokeGrant(t.db,t.alice,applied[0].id,{expectedVersion:1});const revoked=await t.db.prepare('SELECT * FROM fabric_grants WHERE id=?').bind(applied[0].id).first();
   const retry=await route(t);assert.equal(retry.status,200);assert.equal(retry.body.id,applied[0].id);assert.deepEqual(await t.db.prepare('SELECT * FROM fabric_grants WHERE id=?').bind(applied[0].id).first(),revoked);
  }else{
   // The direct effect's observed zero rows are not a durable failure
   // witness for the shared ledger; a spent claim remains uncertain.
   for(let i=0;i<3;i++){const retry=await route(t);assert.equal(retry.status,503);await assertPending(t)}
   assert.deepEqual(await snapshot(t),before);
   const freshInput=await t.approval(75);assert.equal((await route(t,{input:freshInput,key:'fresh-approved-commit'})).status,201);
  }
 });
 for(const boundary of ['expiry','connection-state','connection-version','snapshot'])test(`${engine}: ${boundary} precheck re-reads a same-op claim made after the approval snapshot`,async c=>{
  const t=await commitOnKnownConnection(c,real),a=hold(t.db,/INSERT INTO fabric_grants/);c.after(a.release);
  let entered,releaseClaim;const claimReady=new Promise(r=>entered=r),claimGate=new Promise(r=>releaseClaim=r);c.after(releaseClaim);
  const first=faultOnce(a.db,/UPDATE approvals SET consumed_at/,'before',false,async()=>{entered();await claimGate});
  const original=route(t,{db:first});await claimReady;await expire(t);
  const b=beforeRead(t.db,/SELECT \* FROM grant_previews WHERE id/,async()=>{
   releaseClaim();await a.ready;
   if(boundary==='expiry')c.mock.timers.tick(61*60e3);
   else if(boundary==='snapshot')await t.db.prepare("UPDATE resources SET incarnation='changed-before-check' WHERE id='r_gpu1'").run();
   else{
    assert.equal((await core.suspendConnection(t.db,t.bob,t.conn,{expectedVersion:3})).status,200);
    if(boundary==='connection-version')assert.equal((await core.resumeConnection(t.db,t.bob,t.conn,{expectedVersion:4,nodeKey:t.b.nodeSecret})).status,200);
   }
  });
  const takeover=await route(t,{db:b});assert.equal(takeover.status,503);assert.equal(takeover.body.code,'COMMIT_UNCERTAIN');await assertPending(t);
  const foreign=await core.commitGrant(t.db,t.alice,t.input,{key:'different-operation',path:t.path});assert.equal(foreign.status,409);assert.equal(foreign.body.code,'APPROVAL_CONSUMED');
  a.release();assert.equal((await original).status,boundary==='expiry'?201:503);
  const applied=await t.db.prepare('SELECT * FROM fabric_grants WHERE approval_id=?').bind(t.input.approvalId).first();
  if(boundary==='expiry'){
   assert.ok(applied);await core.revokeGrant(t.db,t.alice,applied.id,{expectedVersion:1});const before=await snapshot(t);
   const retry=await route(t);assert.equal(retry.status,200);assert.equal(retry.body.id,applied.id);assert.deepEqual(await snapshot(t),before);
  }else{
   assert.equal(applied,null);const before=await snapshot(t);assert.equal((await route(t)).status,503);await assertPending(t);assert.deepEqual(await snapshot(t),before);
   if(boundary==='connection-state')assert.equal((await core.resumeConnection(t.db,t.bob,t.conn,{expectedVersion:4,nodeKey:t.b.nodeSecret})).status,200);
   assert.equal((await route(t,{input:await t.freshApproval(),key:'fresh-after-precheck'})).status,201);
  }
 });
 for(const [field,status] of [['disabled',401],['demo',403]])test(`${engine}: ${field} owner is denied before catch-path completed-commit audit recovery`,async c=>{
  const t=await commitOnKnownConnection(c,real),a=hold(t.db,/INSERT INTO fabric_grants/);c.after(a.release);
  let entered,releaseClaim;const claimReady=new Promise(r=>entered=r),claimGate=new Promise(r=>releaseClaim=r);c.after(releaseClaim);
  const first=faultOnce(a.db,/UPDATE approvals SET consumed_at/,'before',false,async()=>{entered();await claimGate});
  const original=route(t,{db:first});await claimReady;await expire(t);let applied;
  const b=beforeRead(t.db,/SELECT \* FROM connections WHERE id/,async()=>{
   releaseClaim();await a.ready;a.release();assert.equal((await original).status,201);
   applied=await t.db.prepare('SELECT id FROM fabric_grants WHERE approval_id=?').bind(t.input.approvalId).first();
   assert.equal((await core.disconnectConnection(t.db,t.bob,t.conn,{expectedVersion:3})).status,200);
   await t.db.prepare(`UPDATE "user" SET ${field}=1 WHERE id=?`).bind(t.alice.user.id).run();
  });
  let auditWrites=0;
  const watched={...b,prepare:sql=>{const raw=b.prepare(sql);if(!/INSERT OR IGNORE INTO audit/.test(sql))return raw;const wrap=s=>({raw:s,sql,bind:(...p)=>wrap(s.bind(...p)),first:(...p)=>s.first(...p),all:(...p)=>s.all(...p),run:(...p)=>{auditWrites++;return s.run(...p)}});return wrap(raw)}};
  const denied=await route(t,{db:watched});assert.equal(denied.status,status);assert.equal(denied.body.id,undefined);assert.equal(auditWrites,0);await assertPending(t);
  const before=await snapshot(t);await t.db.prepare(`UPDATE "user" SET ${field}=0 WHERE id=?`).bind(t.alice.user.id).run();
  const replay=await route(t);assert.equal(replay.status,200);assert.equal(replay.body.id,applied.id);assert.deepEqual(await snapshot(t),before);
 });
 for(const mcp of [false,true])for(const order of ['failure-first','claim-first','effect-first'])test(`${engine}: ${mcp?'MCP':'REST'} terminal ledger and delayed commit ${order} serialize without a false outcome`,async c=>{
  const t=await fixture(c,real),a=hold(t.db,/INSERT INTO fabric_grants/);c.after(a.release);
  let entered,releaseClaim;const claimReady=new Promise(r=>entered=r),claimGate=new Promise(r=>releaseClaim=r);c.after(releaseClaim);
  const held=faultOnce(a.db,/UPDATE approvals SET consumed_at/,'before',false,async()=>{entered();await claimGate});
  const original=route(t,{db:held,mcp});await claimReady;
  const before=await snapshot(t),generation=(await t.db.prepare('SELECT grant_gen FROM connections WHERE id=?').bind(t.conn).first()).grant_gen;
  const budgets=(await t.db.prepare('SELECT * FROM write_budget ORDER BY rowid').all()).results;
  const admissions=(await t.db.prepare('SELECT * FROM fabric_operation_admissions ORDER BY rowid').all()).results;
  await expire(t);c.mock.timers.tick(61*60e3);let winner,revoked;
  const db=order==='failure-first'?t.db:faultOnce(t.db,/UPDATE idempotency_records SET status = \?, response_code/,'before',false,async()=>{
   // The store has already read "no claim" in its precondition catch. The
   // SQL finalizer must itself observe this now-winning claim.
   releaseClaim();await a.ready;
   if(order==='effect-first'){
    a.release();winner=await original;assert.equal(winner.status,201);
    const grant=await t.db.prepare('SELECT id FROM fabric_grants WHERE approval_id=?').bind(t.input.approvalId).first();
    await core.revokeGrant(t.db,t.alice,grant.id,{expectedVersion:1});revoked=await snapshot(t);
   }
  });
  const takeover=await route(t,{db,mcp});
  if(order==='failure-first'){
   assert.equal(takeover.status,410);assert.equal(takeover.body.code,'APPROVAL_EXPIRED');assert.equal((await ledger(t)).response_code,410);
   // Terminal records do not expire/re-admit. Even a much later delayed
   // SQL claim using its old timestamp must remain fenced.
   c.mock.timers.tick(24*60*60e3);releaseClaim();const old=await original;assert.equal(old.status,503);
   assert.equal((await t.db.prepare('SELECT consumed_at FROM approvals WHERE id=?').bind(t.input.approvalId).first()).consumed_at,null);
   assert.deepEqual(await snapshot(t),before);assert.equal((await t.db.prepare('SELECT grant_gen FROM connections WHERE id=?').bind(t.conn).first()).grant_gen,generation);
   for(let i=0;i<3;i++){const replay=await route(t,{mcp});assert.equal(replay.status,410);assert.equal(replay.body.id,undefined)}
  }else{
   assert.equal(takeover.status,503);assert.equal(takeover.body.code,'COMMIT_UNCERTAIN');await assertPending(t);
   if(order==='claim-first'){a.release();winner=await original;assert.equal(winner.status,201)}
   const grant=await t.db.prepare('SELECT * FROM fabric_grants WHERE approval_id=?').bind(t.input.approvalId).first();assert.ok(grant);
   assert.equal((await t.db.prepare("SELECT count(*) n FROM audit WHERE action='fabric.grant.commit' AND target=?").bind(grant.id).first()).n,1);
   if(!revoked){await core.revokeGrant(t.db,t.alice,grant.id,{expectedVersion:1});revoked=await snapshot(t)}
   for(let i=0;i<3;i++){const replay=await route(t,{mcp});assert.equal(replay.status,200);assert.equal((mcp?replay.body.result:replay.body).id,grant.id)}
   assert.equal((await ledger(t)).response_code,200);assert.deepEqual(await snapshot(t),revoked);
  }
  assert.deepEqual((await t.db.prepare('SELECT * FROM write_budget ORDER BY rowid').all()).results,budgets);
  assert.deepEqual((await t.db.prepare('SELECT * FROM fabric_operation_admissions ORDER BY rowid').all()).results,admissions);
  assert.equal((await t.db.prepare('SELECT count(*) n FROM fabric_grants WHERE approval_id=?').bind(t.input.approvalId).first()).n,order==='failure-first'?0:1);
 });
 test(`${engine}: stable direct commit without router attempt cannot bypass a terminal failure fence`,async c=>{
  const t=await fixture(c,real);let entered,release;const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r);c.after(release);
  const held=faultOnce(t.db,/UPDATE approvals SET consumed_at/,'before',false,async()=>{entered();await gate});
  const original=core.commitGrant(held,t.alice,t.input,{key:t.key,path:t.path});await ready;c.mock.timers.tick(61*60e3);
  const before=await snapshot(t),denied=await route(t);assert.equal(denied.status,410);release();assert.equal((await original).status,409);
  assert.deepEqual(await snapshot(t),before);assert.equal((await ledger(t)).response_code,410);
 });
 test(`${engine}: legacy finalizer without an attempt cannot cache failure over a winning claim`,async c=>{
  const t=await fixture(c,real),a=hold(t.db,/INSERT INTO fabric_grants/);c.after(a.release);let entered,release;const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r);c.after(release);
  const held=faultOnce(a.db,/UPDATE approvals SET consumed_at/,'before',false,async()=>{entered();await gate});
  const original=route(t,{db:held});await ready;
  const db=faultOnce(t.db,/UPDATE idempotency_records SET status = \?, response_code/,'before',false,async()=>{release();await a.ready});
  const pending=await core.storeIdempotency(db,t.alice,t.key,410,{error:'Approval expired.',code:'APPROVAL_EXPIRED'});assert.equal(pending.status,503);await assertPending(t);
  a.release();assert.equal((await original).status,201);const retry=await route(t);assert.equal(retry.status,200);assert.equal((await ledger(t)).response_code,200);
 });
 for(const mcp of [false,true])for(const phase of ['before','after'])test(`${engine}: ${mcp?'MCP':'REST'} ${phase} terminal-fence SQL failure reports uncertainty and preserves one outcome`,async c=>{
  const t=await fixture(c,real);let entered,release;const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r);c.after(release);
  const held=faultOnce(t.db,/UPDATE approvals SET consumed_at/,'before',false,async()=>{entered();await gate});
  const original=route(t,{db:held,mcp});await ready;const before=await snapshot(t);
  await expire(t);c.mock.timers.tick(61*60e3);
  const failed=faultOnce(t.db,/UPDATE idempotency_records SET status = \?, response_code/,phase);
  const takeover=await route(t,{db:failed,mcp});release();const old=await original;
  assert.equal(takeover.status,503);assert.equal(takeover.body.code,'COMMIT_UNCERTAIN');
  const grant=await t.db.prepare('SELECT id FROM fabric_grants WHERE approval_id=?').bind(t.input.approvalId).first();
  if(phase==='before'){
   assert.equal(old.status,201);assert.ok(grant);await core.revokeGrant(t.db,t.alice,grant.id,{expectedVersion:1});const revoked=await snapshot(t);
   const replay=await route(t,{mcp});assert.equal(replay.status,200);assert.equal((mcp?replay.body.result:replay.body).id,grant.id);assert.deepEqual(await snapshot(t),revoked);assert.equal((await ledger(t)).response_code,200);
  }else{
   assert.equal(old.status,503);assert.equal(grant,null);assert.deepEqual(await snapshot(t),before);assert.equal((await route(t,{mcp})).status,410);assert.equal((await ledger(t)).response_code,410);
  }
 });
}
