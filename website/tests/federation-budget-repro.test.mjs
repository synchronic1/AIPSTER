import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fabricEnv,S,freshKey,readJson} from './qa-helpers.mjs';
test('security repro: federation shares the public signup write budget',async c=>{
 const t=await fabricEnv();c.after(()=>t.sqlite.close());
 for(let i=0;i<121;i++){
 const r=await readJson(await t.call('/v1/fabric/nodes',{method:'POST',headers:S(t,t.alice,{'Idempotency-Key':freshKey()}),body:{label:'budget-'+i}}));
 assert.equal(r.status,i<120?201:429,'request '+(i+1));
 }
 assert.equal(t.sqlite.prepare('SELECT count FROM write_budget WHERE user_id=?').get(t.alice.id).count,120);
});
