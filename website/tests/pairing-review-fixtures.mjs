// Disposable real local-D1 fixtures; never uses hosted bindings or inference.
import {readFile} from 'node:fs/promises';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {createTestEnv,readJson,MIGRATION_FILES} from './d1-shim.mjs';
export {readJson};
export async function pairingEnv(c,real){
 const t=await createTestEnv();c.after(()=>t.sqlite.close());if(!real){
  // Match D1's serialized batch execution. The general shim deliberately
  // permits nested statement hooks and cannot serialize overlapping awaits.
  const original=t.DB;let tail=Promise.resolve();
  t.DB={...original,batch(stmts){const next=tail.then(()=>original.batch(stmts));tail=next.catch(()=>{});return next;}};t.env.DB=t.DB;return t;
 }
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("synthetic only")}}',compatibilityDate:'2026-10-01',d1Databases:{DB:'pairing-review'},outboundService:()=>new Response('blocked',{status:403})}));c.after(()=>mf.dispose());
 const db=await mf.getD1Database('DB');
 for(const file of MIGRATION_FILES){
  const sql=(await readFile(new URL('../migrations/'+file,import.meta.url),'utf8')).split('\n').filter(l=>!l.trimStart().startsWith('--')).join('\n');
  for(const stmt of sql.split(';').map(s=>s.replace(/\s+/g,' ').trim()).filter(Boolean))await db.exec(stmt);
 }
 const stmts=[db.prepare('PRAGMA defer_foreign_keys=ON')];
 for(const {name} of t.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all())for(const row of t.sqlite.prepare(`SELECT * FROM "${name}"`).all()){
  const cols=Object.keys(row);stmts.push(db.prepare(`INSERT INTO "${name}"(${cols.map(x=>`"${x}"`).join(',')}) VALUES(${cols.map(()=>'?').join(',')})`).bind(...cols.map(x=>row[x])));
 }
 await db.batch(stmts);t.DB=db;t.env.DB=db;return t;
}
export const mint=t=>t.call('/api/pairing/codes',{method:'POST',headers:{...t.as(t.alice),...t.csrf},body:{}}).then(readJson);
export const claim=(t,code,nodeId='synthetic-node')=>t.call('/api/pairing/claim',{method:'POST',body:{code,nodeId}}).then(readJson);
export const remove=(t,id)=>t.call('/api/inventory/'+id,{method:'DELETE',headers:{...t.as(t.alice),...t.csrf}}).then(readJson);
export async function paired(t){const code=await mint(t);const result=await claim(t,code.json.code);if(result.status!==201)throw new Error(result.text);return {code:code.json,...result.json};}
export async function snapshot(t){return {resources:(await t.DB.prepare('SELECT * FROM resources ORDER BY id').all()).results,keys:(await t.DB.prepare('SELECT * FROM key_verifiers ORDER BY id').all()).results,codes:(await t.DB.prepare('SELECT * FROM pairing_codes ORDER BY id').all()).results};}
export function hookDb(db,{beforeBatch,afterBatch,afterInsert}={}){
 const wrap=(raw,sql)=>({raw,sql,bind:(...p)=>wrap(raw.bind(...p),sql),first:(...p)=>raw.first(...p),all:(...p)=>raw.all(...p),async run(){const r=await raw.run();if(afterInsert&&/INSERT INTO key_verifiers/.test(sql))await afterInsert();return r;}});
 return {prepare:sql=>wrap(db.prepare(sql),sql),exec:sql=>db.exec(sql),async batch(stmts){if(beforeBatch)await beforeBatch(stmts);const result=await db.batch(stmts.map(s=>s.raw||s));if(afterBatch)await afterBatch(stmts);return result;}};
}
