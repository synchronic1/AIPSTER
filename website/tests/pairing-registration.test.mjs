import {test} from 'node:test';import assert from 'node:assert/strict';
import {pairingEnv,hookDb,readJson} from './pairing-review-fixtures.mjs';
import {budgetWindow} from '../src/lib/quotas.js';
const register=(t,key='same-registration',name='synthetic')=>t.call('/api/inventory',{method:'POST',headers:{...t.as(t.alice),...t.csrf,'Idempotency-Key':key},body:{name}}).then(readJson);
const snapshot=async t=>({resources:(await t.DB.prepare('SELECT * FROM resources ORDER BY id').all()).results,mappings:(await t.DB.prepare('SELECT * FROM idempotency_keys ORDER BY key').all()).results,budget:(await t.DB.prepare('SELECT * FROM write_budget ORDER BY user_id,window').all()).results,audits:(await t.DB.prepare("SELECT * FROM audit WHERE action='resource.register' ORDER BY id").all()).results});
for(const real of [false,true]){
 const engine=real?'local D1':'sqlite';
 test(`${engine}: stalled registration batch replays the later winner after the legacy lease window`,async c=>{
  const t=await pairingEnv(c,real),db=t.DB;c.mock.timers.enable({apis:['Date'],now:Date.now()});
  let entered,release;const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r);c.after(()=>release());
  t.env.DB=hookDb(db,{beforeBatch:async stmts=>{if(stmts.some(s=>/INSERT OR IGNORE INTO idempotency_keys/.test(s.sql))){entered();await gate;}}});
  const original=register(t,'delayed-registration','original');await ready;t.env.DB=db;
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM idempotency_keys').first()).n,0,'new atomic claims publish no unbound reservation');
  c.mock.timers.tick(10*60*1000);
  const winner=await register(t,'delayed-registration','winner');assert.equal(winner.status,201,winner.text);
  const committed=await snapshot(t);release();const late=await original;
  assert.equal(late.status,200,late.text);assert.equal(late.json.id,winner.json.id);assert.equal(late.json.name,'winner');
  assert.deepEqual(await snapshot(t),committed,'late original cannot duplicate, rebind, audit or charge');
  assert.equal((await register(t,'delayed-registration','original')).json.id,winner.json.id);
  assert.deepEqual(await snapshot(t),committed);
 });
 test(`${engine}: legacy NULL registration claims keep their grace without charging rejected retries`,async c=>{
  const t=await pairingEnv(c,real);c.mock.timers.enable({apis:['Date'],now:Date.now()});
  await t.DB.prepare('INSERT INTO idempotency_keys(owner_id,key,resource_id,created_at) VALUES(?,?,NULL,?)').bind(t.alice.id,'legacy-pending',new Date().toISOString()).run();
  const before=await snapshot(t);
  for(let n=0;n<3;n++){const r=await register(t,'legacy-pending');assert.equal(r.status,409);assert.equal(r.json.code,'IDEMPOTENT_IN_FLIGHT');}
  assert.deepEqual(await snapshot(t),before);
  c.mock.timers.tick(5*60*1000+1);
  const recovered=await register(t,'legacy-pending');assert.equal(recovered.status,201);
  assert.equal((await register(t,'legacy-pending')).status,200);
  const after=await snapshot(t);assert.equal(after.resources.length,1);assert.equal(after.mappings.length,1);assert.equal(after.budget[0].count,1);assert.equal(after.audits.length,1);
 });

 test(`${engine}: registration audit failure rolls back resource, mapping and budget`,async c=>{
  const t=await pairingEnv(c,real),before=await snapshot(t);
  await t.DB.prepare("CREATE TRIGGER registration_fault BEFORE INSERT ON audit WHEN NEW.action='resource.register' BEGIN SELECT RAISE(ABORT,'synthetic registration fault'); END").run();
  assert.equal((await register(t)).status,500);assert.deepEqual(await snapshot(t),before);
  await t.DB.prepare('DROP TRIGGER registration_fault').run();assert.equal((await register(t)).status,201);
 });
 test(`${engine}: lost registration response replays at exhausted budget without duplicate or charge`,async c=>{
  const t=await pairingEnv(c,real),db=t.DB;let fired=false;
  t.env.DB=hookDb(db,{afterBatch:async stmts=>{if(!fired&&stmts.some(s=>/INSERT OR IGNORE INTO idempotency_keys/.test(s.sql))){fired=true;throw new Error('synthetic lost response');}}});
  assert.equal((await register(t)).status,500);assert.ok(fired);t.env.DB=db;
  await db.prepare('UPDATE write_budget SET count=120 WHERE user_id=? AND window=?').bind(t.alice.id,budgetWindow()).run();const before=await snapshot(t);
  const retry=await register(t,'same-registration','changed body');assert.equal(retry.status,200);assert.equal(retry.json.name,'synthetic');assert.deepEqual(await snapshot(t),before);
 });
 test(`${engine}: simultaneous same-key registration has one resource, admission and audit`,async c=>{
  const t=await pairingEnv(c,real),db=t.DB;let n=0,release;const gate=new Promise(r=>release=r);
  t.env.DB=hookDb(db,{beforeBatch:async stmts=>{if(stmts.some(s=>/INSERT OR IGNORE INTO idempotency_keys/.test(s.sql))){if(++n===2)release();await gate;}}});
  const results=await Promise.all([register(t),register(t)]);assert.deepEqual(results.map(r=>r.status).sort(),[200,201]);assert.equal(results[0].json.id,results[1].json.id);
  const after=await snapshot(t);assert.equal(after.resources.length,1);assert.equal(after.mappings.length,1);assert.equal(after.budget[0].count,1);assert.equal(after.audits.length,1);
 });
 test(`${engine}: fresh registration at exhausted budget or actor closure writes nothing`,async c=>{
  const t=await pairingEnv(c,real),db=t.DB;
  await db.prepare('INSERT INTO write_budget VALUES(?,?,120)').bind(t.alice.id,budgetWindow()).run();const before=await snapshot(t);
  assert.equal((await register(t)).status,429);assert.deepEqual(await snapshot(t),before);
  await db.prepare('DELETE FROM write_budget').run();const uncharged=await snapshot(t);let fired=false;
  t.env.DB=hookDb(db,{beforeBatch:async stmts=>{if(!fired&&stmts.some(s=>/INSERT OR IGNORE INTO idempotency_keys/.test(s.sql))){fired=true;await db.prepare('UPDATE "user" SET disabled=1 WHERE id=?').bind(t.alice.id).run();}}});
  assert.equal((await register(t)).status,401);assert.ok(fired);assert.deepEqual(await snapshot(t),uncharged);
 });
}
