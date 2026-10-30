// Isolated local workerd D1 contract checks; no Cloudflare account or remote DB.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
test('local D1: rollback, zero-row success, SQL assertion, no interactive BEGIN',async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("local-only")}}',compatibilityDate:'2026-10-01',d1Databases:{DB:'architecture-synthetic'},outboundService:()=>new Response('blocked',{status:403})}));
 try {
 const db=await mf.getD1Database('DB');
 await db.batch([
  db.prepare('CREATE TABLE item(id TEXT PRIMARY KEY, version INTEGER NOT NULL, value INTEGER NOT NULL)'),
  db.prepare('CREATE TABLE effect(id TEXT PRIMARY KEY)'),
  db.prepare('CREATE TABLE assertion(ok INTEGER NOT NULL CHECK(ok=1))'),
  db.prepare("INSERT INTO item VALUES('g',1,10)")
 ]);
 await assert.rejects(db.batch([db.prepare("UPDATE item SET value=20 WHERE id='g'"),db.prepare('INSERT INTO assertion VALUES(0)')]));
 assert.equal((await db.prepare("SELECT value FROM item WHERE id='g'").first()).value,10);
 const r=await db.batch([db.prepare("UPDATE item SET value=30 WHERE id='g' AND version=9"),db.prepare("INSERT INTO effect VALUES('unguarded')")]);
 assert.equal(r[0].meta.changes,0);
 assert.equal((await db.prepare('SELECT count(*) n FROM effect').first()).n,1);
 await db.prepare('DELETE FROM effect').run();
 // A conditional operation marker followed by a SQL assertion protects the whole batch.
 await assert.rejects(db.batch([
  db.prepare("INSERT INTO effect SELECT 'guarded' WHERE EXISTS(SELECT 1 FROM item WHERE id='g' AND version=9)"),
  db.prepare("INSERT INTO assertion SELECT CASE WHEN EXISTS(SELECT 1 FROM effect WHERE id='guarded') THEN 1 ELSE 0 END"),
  db.prepare("UPDATE item SET value=99 WHERE id='g'")
 ]));
 assert.equal((await db.prepare("SELECT value FROM item WHERE id='g'").first()).value,10);
 assert.equal((await db.prepare('SELECT count(*) n FROM effect').first()).n,0);
 let beginError=''; try{await db.prepare('BEGIN TRANSACTION').run();}catch(e){beginError=String(e);}
 assert.ok(beginError,/BEGIN must not be assumed interactive/);
 console.log('BEGIN rejection:',beginError);
 console.log('Local D1 contract: constraint rollback PASS; zero-row is success PASS; guarded batch rollback PASS');
 } finally {await mf.dispose();}
});
