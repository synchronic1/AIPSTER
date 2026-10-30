import {test} from 'node:test';
import assert from 'node:assert/strict';
import {pairingEnv,mint,claim,paired,remove,snapshot,hookDb,readJson} from './pairing-review-fixtures.mjs';

for(const real of [false,true]){
 const engine=real?'local D1':'sqlite';
 test(`${engine}: spent-code false secret does not disclose or revoke sender credentials`,async c=>{
  const t=await pairingEnv(c,real),p=await paired(t),before=await snapshot(t);
  const forged=p.code.code.slice(0,14)+(p.code.code.endsWith('0000-0000-0000')?'1111-1111-1111':'0000-0000-0000');
  assert.equal((await claim(t,forged)).status,404);
  const after=await snapshot(t);assert.deepEqual(after.keys,before.keys);assert.deepEqual(after.resources,before.resources);
  assert.equal(after.codes[0].attempts,before.codes[0].attempts+1);
 });
 for(const column of ['disabled','demo'])for(const reclaim of [false,true])test(`${engine}: ${column} owner rejected on ${reclaim?'reclaim':'initial claim'}`,async c=>{
  const t=await pairingEnv(c,real),code=reclaim?(await paired(t)).code:(await mint(t)).json;
  await t.DB.prepare(`UPDATE "user" SET ${column}=1 WHERE id=?`).bind(t.alice.id).run();const before=await snapshot(t);
  assert.equal((await claim(t,code.code)).status,404);assert.deepEqual(await snapshot(t),before);
 });
 test(`${engine}: stale node/resource identity cannot reclaim`,async c=>{
  const t=await pairingEnv(c,real),p=await paired(t);
  await t.DB.prepare("UPDATE resources SET node_id='different-node' WHERE id=?").bind(p.resourceId).run();const before=await snapshot(t);
  assert.equal((await claim(t,p.code.code)).status,404);assert.deepEqual(await snapshot(t),before);
 });
 for(const reclaim of [false,true])test(`${engine}: owner closes at enrollment batch boundary with no effect`,async c=>{
  const t=await pairingEnv(c,real),code=reclaim?(await paired(t)).code:(await mint(t)).json;
  const before=await snapshot(t),db=t.DB;let fired=false;
  t.env.DB=hookDb(db,{beforeBatch:async stmts=>{if(!fired&&stmts.some(s=>/UPDATE pairing_codes SET used_at/.test(s.sql))){fired=true;await db.prepare('UPDATE "user" SET disabled=1 WHERE id=?').bind(t.alice.id).run();}}});
  assert.equal((await claim(t,code.code)).status,404);assert.ok(fired);assert.deepEqual(await snapshot(t),before);
 });
 test(`${engine}: overlapping reclaims leave exactly one live winning sender`,async c=>{
  const t=await pairingEnv(c,real),p=await paired(t),db=t.DB;
  let entered=0,release;const gate=new Promise(r=>release=r);const meet=async()=>{if(++entered===2)release();await gate;};
  t.env.DB=hookDb(db,{afterInsert:meet,beforeBatch:async stmts=>{if(stmts.some(s=>/UPDATE pairing_codes SET used_at/.test(s.sql)))await meet();}});
  const results=await Promise.all([claim(t,p.code.code),claim(t,p.code.code)]);
  assert.deepEqual(results.map(r=>r.status),[200,200]);
  const live=(await db.prepare("SELECT id FROM key_verifiers WHERE resource_id=? AND revoked_at IS NULL").bind(p.resourceId).all()).results;
  assert.equal(live.length,1);assert.ok(results.some(r=>r.json.keyId===live[0].id));
 });
 test(`${engine}: simultaneous different codes for one node converge on one resource`,async c=>{
  const t=await pairingEnv(c,real),a=await mint(t),b=await mint(t),db=t.DB;
  let n=0,release;const gate=new Promise(r=>release=r);
  t.env.DB=hookDb(db,{beforeBatch:async stmts=>{if(stmts.some(s=>/UPDATE pairing_codes SET used_at/.test(s.sql))){if(++n===2)release();await gate;}}});
  const results=await Promise.all([claim(t,a.json.code),claim(t,b.json.code)]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,201]);assert.equal(results[0].json.resourceId,results[1].json.resourceId);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM resources').first()).n,1);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM key_verifiers WHERE revoked_at IS NULL').first()).n,1);
 });
 for(const reclaim of [false,true])test(`${engine}: audit failure rolls back ${reclaim?'rotation':'enrollment'} and exact retry succeeds`,async c=>{
  const t=await pairingEnv(c,real),code=reclaim?(await paired(t)).code:(await mint(t)).json,before=await snapshot(t);
  await t.DB.prepare("CREATE TRIGGER claim_fault BEFORE INSERT ON audit WHEN NEW.action='pairing.claim' BEGIN SELECT RAISE(ABORT,'synthetic claim audit fault'); END").run();
  assert.equal((await claim(t,code.code)).status,500);assert.deepEqual(await snapshot(t),before);
  await t.DB.prepare('DROP TRIGGER claim_fault').run();assert.equal((await claim(t,code.code)).status,reclaim?200:201);
 });
 test(`${engine}: teardown clears revoked bindings and removes grant-linked jobs atomically`,async c=>{
  const t=await pairingEnv(c,real),p=await paired(t);assert.equal((await claim(t,p.code.code)).status,200);
  const revoked=await t.DB.prepare('SELECT id,revoked_at FROM key_verifiers WHERE id=?').bind(p.keyId).first();assert.ok(revoked.revoked_at);
  const grant=await t.call('/api/grants',{method:'POST',headers:{...t.as(t.alice),...t.csrf},body:{resourceId:p.resourceId,grantee:'bob@example.com',maxJobs:10,maxTokens:100}}).then(readJson);assert.equal(grant.status,201);
  await t.DB.prepare("INSERT INTO jobs(id,owner_id,resource_id,grant_id,adapter,model,status,tokens_in,tokens_out,cost_source,created_at,updated_at) VALUES('fixture-job',?,?,?,'synthetic','none','fixture',0,0,'unknown','2026-01-01','2026-01-01')").bind(t.bob.id,p.resourceId,grant.json.id).run();
  assert.equal((await remove(t,p.resourceId)).status,200);
  assert.equal(await t.DB.prepare('SELECT id FROM resources WHERE id=?').bind(p.resourceId).first(),null);
  assert.equal(await t.DB.prepare("SELECT id FROM jobs WHERE id='fixture-job'").first(),null);
  const keys=(await t.DB.prepare('SELECT resource_id,revoked_at FROM key_verifiers').all()).results;assert.ok(keys.every(k=>k.resource_id===null&&k.revoked_at));
  assert.equal((await t.DB.prepare('SELECT revoked_at FROM key_verifiers WHERE id=?').bind(p.keyId).first()).revoked_at,revoked.revoked_at);
  assert.deepEqual((await t.DB.prepare('PRAGMA foreign_key_check').all()).results,[]);
 });
 test(`${engine}: failed teardown audit rolls back revocation and deletion`,async c=>{
  const t=await pairingEnv(c,real),p=await paired(t),before=await snapshot(t);
  await t.DB.prepare("CREATE TRIGGER delete_fault BEFORE INSERT ON audit WHEN NEW.action='resource.delete' BEGIN SELECT RAISE(ABORT,'synthetic deletion audit fault'); END").run();
  assert.equal((await remove(t,p.resourceId)).status,500);assert.deepEqual(await snapshot(t),before);
  await t.DB.prepare('DROP TRIGGER delete_fault').run();assert.equal((await remove(t,p.resourceId)).status,200);
 });
}
