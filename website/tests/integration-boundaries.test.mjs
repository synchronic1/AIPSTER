// Synthetic local-D1 integration regressions. No hosted bindings or inference.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {fabricEnv,connectPair,commitFlow,S,freshKey,readJson} from './qa-helpers.mjs';
import {MIGRATION_FILES} from './d1-shim.mjs';
import {budgetWindow} from '../src/lib/quotas.js';

async function realDb(t,c){
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("synthetic")}}',compatibilityDate:'2026-10-01',d1Databases:{DB:'independent-combined'},outboundService:()=>new Response('blocked',{status:403})}));
 c.after(()=>mf.dispose()); const db=await mf.getD1Database('DB');
 for(const file of MIGRATION_FILES) await apply(db,file);
 const stmts=[db.prepare('PRAGMA defer_foreign_keys = ON')];
 for(const {name} of t.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all())
  for(const row of t.sqlite.prepare(`SELECT * FROM "${name}"`).all()){
   const cols=Object.keys(row);stmts.push(db.prepare(`INSERT INTO "${name}"(${cols.map(x=>`"${x}"`).join(',')}) VALUES(${cols.map(()=>'?').join(',')})`).bind(...cols.map(x=>row[x])));
  }
 await db.batch(stmts);t.env.DB=db;t.DB=db;return db;
}
async function apply(db,file){
 const sql=(await readFile(new URL('../migrations/'+file,import.meta.url),'utf8')).split('\n').filter(l=>!l.trimStart().startsWith('--')).join('\n');
 for(const stmt of sql.split(';').map(s=>s.replace(/\s+/g,' ').trim()).filter(Boolean))await db.exec(stmt);
}
for(const heartbeatFirst of [false,true])test(`sprint integration: real-D1: heartbeat migration ${heartbeatFirst?'before':'after'} federation preserves identity,budget,columns`,async c=>{
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("synthetic")}}',compatibilityDate:'2026-10-01',d1Databases:{DB:'migration-order'},outboundService:()=>new Response('blocked',{status:403})}));c.after(()=>mf.dispose());const db=await mf.getD1Database('DB');
 const files=(await readdir(new URL('../migrations/',import.meta.url))).filter(x=>x.endsWith('.sql')).sort();assert.deepEqual(files,MIGRATION_FILES);assert.equal(new Set(files.map(x=>x.split('_')[0])).size,13);
 for(const file of files.slice(0,5))await apply(db,file);
 await db.prepare('INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,?,?)').bind('order-user','synthetic','order@synthetic.invalid','2026-01-01','2026-01-01').run();
 await db.prepare('INSERT INTO write_budget VALUES(?,?,17)').bind('order-user','2026-10-28T00').run();
 const original=await db.prepare('SELECT * FROM "user"').first();
 const federation=files.slice(5,12),heartbeat=files[12];
 for(const file of heartbeatFirst?[heartbeat,...federation]:[...federation,heartbeat])await apply(db,file);
 assert.deepEqual(await db.prepare('SELECT * FROM "user"').first(),original);
 assert.equal((await db.prepare('SELECT count FROM write_budget').first()).count,17);
 const columns=(await db.prepare('PRAGMA table_info(key_verifiers)').all()).results.map(r=>r.name);
 for(const col of ['resource_id','peer_node','audience','delegate'])assert.ok(columns.includes(col),col);
 assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results,[]);
});

for(const ceiling of ['hour','retention','both'])test(`sprint integration: combined real-D1 router: restriction remains available at ${ceiling} exhaustion; heartbeat keys cannot enter fabric`,async c=>{
 const t=await fabricEnv();c.after(()=>t.sqlite.close());const {conn}=await connectPair(t);
 const a=(await commitFlow(t,conn.id)).grant,b=(await commitFlow(t,conn.id)).grant;
 const post=(path,body={},user=t.alice)=>t.call(path,{method:'POST',headers:S(t,user,{'Idempotency-Key':freshKey()}),body}).then(readJson);
 const key=(await post('/api/keys',{name:'synthetic-hb',scope:'heartbeat',resourceId:'r_gpu1'})).json;
 assert.ok(key.secret);const db=await realDb(t,c);
 if(ceiling!=='retention')await db.prepare('INSERT OR REPLACE INTO write_budget VALUES(?,?,120)').bind(t.alice.id,budgetWindow()).run();
 if(ceiling!=='hour')await db.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<10000) INSERT INTO fabric_operation_admissions(owner_id,actor_kind,idem_key,method,path,request_hash,admitted_at) SELECT ?,'key','independent-'||x,'POST','/synthetic','h','2026-01-01' FROM n`).bind(t.alice.id).run();
 const before=(await db.prepare('SELECT COUNT(*) n FROM fabric_operation_admissions').first()).n;
 const cv=(await db.prepare('SELECT version FROM connections WHERE id=?').bind(conn.id).first()).version;
 assert.equal((await post(`/v1/fabric/grants/${a.id}/revoke`,{expectedVersion:a.version})).status,200);
 assert.equal((await post('/v1/fabric/mcp',{tool:'fabric.pause_grant',params:{id:b.id,expectedVersion:b.version},idempotencyKey:freshKey()})).status,200);
 assert.equal((await post(`/v1/fabric/connections/${conn.id}/suspend`,{expectedVersion:cv})).status,200);
 assert.equal((await db.prepare('SELECT status FROM fabric_grants WHERE id=?').bind(a.id).first()).status,'revoked');
 assert.equal((await db.prepare('SELECT status FROM fabric_grants WHERE id=?').bind(b.id).first()).status,'paused');
 assert.equal((await db.prepare('SELECT state FROM connections WHERE id=?').bind(conn.id).first()).state,'suspended');
 assert.equal((await db.prepare('SELECT COUNT(*) n FROM fabric_operation_admissions').first()).n,before+3);
 assert.ok([429,409].includes((await post('/v1/fabric/nodes',{label:'blocked'})).status));
 for(const [method,path,body] of [['GET','/v1/fabric/nodes'],['GET','/v1/fabric/grants'],['POST',`/v1/fabric/grants/${b.id}/revoke`,{expectedVersion:b.version+1}],['POST','/v1/fabric/mcp',{tool:'fabric.pause_grant',params:{id:b.id,expectedVersion:b.version+1},idempotencyKey:freshKey()}]]){
  const response=await readJson(await t.call(path,{method,headers:{Authorization:'Bearer '+key.secret,'Idempotency-Key':freshKey()},...(body?{body}:{})}));assert.equal(response.status,403,path);
 }
 const job=await post('/api/jobs',{});assert.equal(job.status,501);assert.equal(job.json.code,'INFERENCE_DISABLED');
 assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results,[]);
});
