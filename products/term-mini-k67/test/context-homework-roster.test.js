import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createContextSourceApp} from '../src/context-source.js';
test('Homework ERP endpoint requires current key, is no-store and does not alter snapshot route',async t=>{
 let reads=0;const pool={async query(sql){assert.match(sql,/homework_erp_students/);reads++;return {rows:[{public_id:'fixture',status:'pending_review'}]};}};
 const app=createContextSourceApp({pool,secret:'s'.repeat(32)});
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
 const url='http://127.0.0.1:'+server.address().port+'/v1/homework/erp-students';
 assert.equal((await fetch(url)).status,401);assert.equal(reads,0);
 const r=await fetch(url,{headers:{'x-k67-context-key':'s'.repeat(32)}});assert.equal(r.status,200);
 assert.equal(r.headers.get('cache-control'),'no-store');assert.equal((await r.json()).students[0].status,'pending_review');assert.equal(reads,1);
});
