/* Built with Meta Muse. */
// Local synthetic state/invariants only. No provider or deployed service.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations, createTestEnv, MIGRATION_FILES, readJson } from './d1-shim.mjs';
import { budgetWindow, WRITE_BUDGET_PER_HOUR } from '../src/lib/quotas.js';
import { claimQualOp } from '../src/qualification/admission.mjs';

const now = '2026-11-15T17:00:00.000Z';
const later = '2026-11-15T17:10:00.000Z';
const row = (db, sql, ...p) => db.prepare(sql).get(...p);
const query = (db, sql, ...p) => db.prepare(sql).all(...p);
const change = (db, sql, ...p) => db.prepare(sql).run(...p);
const req = (t, path, method, user, body) => t.call(path, { method, headers: { ...t.as(user), ...t.csrf }, body }).then(readJson);
const auditN = (t, action) => row(t.sqlite,'SELECT COUNT(*) AS n FROM audit WHERE action=?',action).n;
const budget = (t) => row(t.sqlite,'SELECT count FROM write_budget WHERE user_id=? AND window=?', t.alice.id,budgetWindow())?.count ?? 0;

function seedResource(db, id, owner) {
  change(db, "INSERT INTO resources(id,owner_id,name,kind,origin,cpu,gpu,limits_json,verification_json,credits_json,created_at) VALUES (?,?,?,'local','owner-private-origin','private-cpu','private-gpu',?,?,?,?)",
    id,owner,'Shared label',JSON.stringify({ note:'private-limit' }),JSON.stringify({ note:'private-verification' }),
    JSON.stringify({ note:'private-credit' }),now);
}

test('migration reconciles legacy duplicates conservatively and leaves historical counters and revocations intact', () => {
  const d = new DatabaseSync(':memory:');
  applyMigrations(d,MIGRATION_FILES.slice(0,-1));
  for (const id of ['owner','grantee']) {
    change(d,'INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,?,?,?)',id,id,id+'@test.invalid',1,now,now);
  }
  seedResource(d,'r_test','owner');
  const ins=(id,created,maxJobs,maxTokens,usedJobs,usedTokens,revoked=null) => change(d,`INSERT INTO grants
    (id,resource_id,owner_id,grantee_id,max_jobs,max_tokens,used_jobs,used_tokens,created_at,revoked_at)
    VALUES (?,'r_test','owner','grantee',?,?,?,?,?,?)`,id,maxJobs,maxTokens,usedJobs,usedTokens,created,revoked);
  ins('g_keep',now,10,1000,4,300);
  ins('g_retire',later,8,700,7,650);
  ins('g_old','2026-11-14',9,2000,1,1,now);
  change(d,"INSERT INTO routing_refunds VALUES('rs_keep','g_keep',1,50,?)",now);
  change(d,"INSERT INTO routing_refunds VALUES('rs_retire','g_retire',1,10,?)",now);
  applyMigrations(d,[MIGRATION_FILES.at(-1)]);
  const grants=query(d,'SELECT id,max_jobs,max_tokens,used_jobs,used_tokens,revoked_at FROM grants ORDER BY id').map(r=>({...r}));
  assert.deepEqual(grants[0],{id:'g_keep',max_jobs:5,max_tokens:310,used_jobs:4,used_tokens:300,revoked_at:null});
  assert.deepEqual(grants[1],{id:'g_old',max_jobs:9,max_tokens:2000,used_jobs:1,used_tokens:1,revoked_at:now});
  assert.equal(grants[2].used_jobs,7);
  assert.ok(grants[2].revoked_at);
  assert.equal(row(d,"SELECT COUNT(*) AS n FROM routing_refunds").n,2);
  assert.equal(row(d,"SELECT COUNT(*) AS n FROM audit WHERE action LIKE 'grant.duplicate_%'").n,2);
  assert.throws(()=>ins('g_later',later,2,100,0,0),/UNIQUE/);
  assert.doesNotThrow(()=>ins('g_history',later,2,100,0,0,later));
  d.close();
});

test('grant identity, application quota, owner-view minimization and revocation are single-transition', async t0 => {
  const t = await createTestEnv();
  t0.after(()=>t.sqlite.close());
  seedResource(t.sqlite,'r_test',t.alice.id);
  const body={resourceId:'r_test',grantee:t.bob.email,maxJobs:3,maxTokens:300};
  const made=await req(t,'/api/grants','POST',t.alice,body);
  assert.equal(made.status,201);
  assert.equal(auditN(t,'grant.create'),1);
  assert.equal(budget(t),1);
  const repeat=await req(t,'/api/grants','POST',t.alice,body);
  assert.deepEqual([repeat.status,repeat.json.code],[409,'GRANT_EXISTS']);
  assert.equal(auditN(t,'grant.create'),1);
  assert.equal(budget(t),1);
  const owner=await req(t,'/api/inventory/r_test','GET',t.alice);
  const shared=await req(t,'/api/inventory/r_test','GET',t.bob);
  assert.equal(owner.json.origin,'owner-private-origin');
  assert.deepEqual(owner.json.limits,{note:'private-limit'});
  assert.deepEqual(shared.json,{id:'r_test',name:'Shared label',kind:'local'});
  change(t.sqlite,'UPDATE write_budget SET count=? WHERE user_id=? AND window=?',WRITE_BUDGET_PER_HOUR,t.alice.id,budgetWindow());
  const target='/api/grants/'+made.json.id;
  assert.equal((await req(t,target,'DELETE',t.alice)).status,200);
  assert.equal((await req(t,target,'DELETE',t.alice)).status,200);
  assert.equal(auditN(t,'grant.revoke'),1);
  assert.equal(budget(t),WRITE_BUDGET_PER_HOUR);
  assert.equal((await req(t,'/api/inventory/r_test','GET',t.bob)).status,404);
});

test('rejected audit storage cannot leave a grant, key, quota debit or partial revocation', async t0 => {
  const t=await createTestEnv();
  t0.after(()=>t.sqlite.close());
  seedResource(t.sqlite,'r_test',t.alice.id);
  const body={resourceId:'r_test',grantee:t.bob.email,maxJobs:2,maxTokens:200};
  const auditFault=kind=>t.sqlite.exec(`CREATE TRIGGER denied_audit BEFORE INSERT ON audit WHEN NEW.action='${kind}'
    BEGIN SELECT RAISE(ABORT,'synthetic local audit failure'); END`);
  auditFault('grant.create');
  assert.equal((await req(t,'/api/grants','POST',t.alice,body)).status,500);
  assert.equal(row(t.sqlite,'SELECT COUNT(*) AS n FROM grants').n,0);
  assert.equal(budget(t),0);
  t.sqlite.exec('DROP TRIGGER denied_audit');
  auditFault('key.create');
  assert.equal((await req(t,'/api/keys','POST',t.alice,{name:'test-only read key',scope:'read'})).status,500);
  assert.equal(row(t.sqlite,'SELECT COUNT(*) AS n FROM key_verifiers').n,0);
  assert.equal(budget(t),0);
  t.sqlite.exec('DROP TRIGGER denied_audit');
  // In the batch, the guarded audit marker precedes the mutation and debit.
  // Force each later stage to fail; neither may leave that marker committed.
  t.sqlite.exec("CREATE TRIGGER denied_mutation BEFORE INSERT ON grants BEGIN SELECT RAISE(ABORT,'synthetic mutation failure'); END");
  assert.equal((await req(t,'/api/grants','POST',t.alice,body)).status,500);
  assert.equal(auditN(t,'grant.create'),0);
  assert.equal(budget(t),0);
  t.sqlite.exec('DROP TRIGGER denied_mutation');
  t.sqlite.exec("CREATE TRIGGER denied_debit BEFORE INSERT ON write_budget BEGIN SELECT RAISE(ABORT,'synthetic debit failure'); END");
  assert.equal((await req(t,'/api/grants','POST',t.alice,body)).status,500);
  assert.equal(auditN(t,'grant.create'),0);
  assert.equal(row(t.sqlite,'SELECT COUNT(*) AS n FROM grants').n,0);
  assert.equal(budget(t),0);
  t.sqlite.exec('DROP TRIGGER denied_debit');
  const key=await req(t,'/api/keys','POST',t.alice,{name:'test-only read key',scope:'read'});
  assert.equal(key.status,201);
  const grant=await req(t,'/api/grants','POST',t.alice,body);
  assert.equal(grant.status,201);
  for (const [kind,path,table,id] of [
    ['key','/api/keys/','key_verifiers',key.json.id],
    ['grant','/api/grants/','grants',grant.json.id],
  ]) {
    auditFault(kind+'.revoke');
    assert.equal((await req(t,path+id,'DELETE',t.alice)).status,500);
    assert.equal(row(t.sqlite,`SELECT revoked_at FROM ${table} WHERE id=?`,id).revoked_at,null);
    assert.equal(auditN(t,kind+'.revoke'),0);
    t.sqlite.exec('DROP TRIGGER denied_audit');
    assert.equal((await req(t,path+id,'DELETE',t.alice)).status,200);
    assert.equal((await req(t,path+id,'DELETE',t.alice)).status,200);
    assert.ok(row(t.sqlite,`SELECT revoked_at FROM ${table} WHERE id=?`,id).revoked_at);
    assert.equal(auditN(t,kind+'.revoke'),1);
  }
  assert.equal(budget(t),2);
});

test('owned worker teardown retires qualification FK rows with private receipts and retains spend', async t0=>{
  const t=await createTestEnv();
  t0.after(()=>t.sqlite.close());
  t.sqlite.exec('PRAGMA foreign_keys=ON');
  seedResource(t.sqlite,'r_test',t.alice.id);
  seedResource(t.sqlite,'r_other',t.bob.id);
  change(t.sqlite,`INSERT INTO qualification_recommendations(owner_id,node_id,profile_digest,op_key,input_digest,state,receipt_json,created_at,updated_at)
    VALUES (?,'r_test','prof','retained-key','digest','fetching','{"fixture":true}',?,?)`,t.alice.id,now,now);
  change(t.sqlite,`INSERT INTO qualification_cache(owner_id,node_id,profile_digest,advice_json,receipt_json,created_at,updated_at)
    VALUES (?,'r_test','prof','{}','{}',?,?)`,t.alice.id,now,now);
  change(t.sqlite,`INSERT INTO qualification_runs(run_id,owner_id,node_id,profile_digest,lease_id,state,claim_by,execution_deadline,result_json,created_at,updated_at)
    VALUES ('run-a',?,'r_test','prof','lease-a','leased',?,?,'{"trace":"retained"}',?,?)`,t.alice.id,later,later,now,now);
  change(t.sqlite,`INSERT INTO qualification_runs(run_id,owner_id,node_id,profile_digest,lease_id,state,claim_by,created_at,updated_at)
    VALUES ('run-b',?,'r_other','prof','lease-b','assigned',?,?,?)`,t.bob.id,later,now,now);
  change(t.sqlite,'INSERT INTO qualification_spend VALUES (?,?,?)',t.alice.id,42,now);
  assert.equal((await req(t,'/api/inventory/r_test','DELETE',t.bob)).status,404);
  assert.equal(row(t.sqlite,'SELECT COUNT(*) AS n FROM qualification_retired_records').n,0);
  assert.equal((await req(t,'/api/inventory/r_test','DELETE',t.alice)).status,200);
  assert.equal(auditN(t,'resource.delete'),1);
  assert.deepEqual(query(t.sqlite,'PRAGMA foreign_key_check'),[]);
  assert.equal(row(t.sqlite,'SELECT COUNT(*) AS n FROM qualification_runs').n,1);
  assert.equal(row(t.sqlite,'SELECT id FROM resources WHERE id=?','r_test'),undefined);
  const archive=query(t.sqlite,'SELECT kind,disposition,record_json FROM qualification_retired_records WHERE owner_id=? ORDER BY kind',t.alice.id);
  assert.deepEqual(archive.map(x=>[x.kind,x.disposition]),[['cache','historical'],['recommendation','outcome-uncertain'],['run','outcome-uncertain']]);
  assert.equal(JSON.parse(archive[1].record_json).receipt_json,'{"fixture":true}');
  assert.equal(JSON.parse(archive[2].record_json).result_json,'{"trace":"retained"}');
  assert.equal(row(t.sqlite,'SELECT usd_micro FROM qualification_spend WHERE owner_id=?',t.alice.id).usd_micro,42);
  seedResource(t.sqlite,'r_new',t.alice.id);
  await assert.rejects(claimQualOp(t.DB,t.alice.id,'r_new','prof2','retained-key','digest2'),
    {code:'QUAL_OPERATION_RETIRED'});
});
