import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {randomUUID} from 'node:crypto';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import * as modern from './fixture-independent.mjs';
import {createIndependentApp} from '../independent/src/speaking-independent-server.js';
import {SpeakingHomeworkError} from '../independent/src/speaking-homework.js';
const root=process.env.SPEAKING_JOURNAL_LIBRARY_ROOT;if(!root)throw Error('SPEAKING_JOURNAL_LIBRARY_ROOT_REQUIRED');
const lib=p=>import(pathToFileURL(resolve(root,p)).href);
const {createSpeakingHomeworkJournal,createSpeakingHomeworkIntake,speakingHomeworkBinding,speakingHomeworkSchemas}=await lib('adapters/speaking-homework.mjs');
const {createJournalService}=await lib('src/service.mjs');
const {RemoteJournalStore}=await lib('src/remote-store.mjs');
const {ProductLogRegistry,storageScope}=await lib('src/product-record.mjs');
const origin='https://fixture.invalid',prefix='/api/speaking-homework-independent',product='speaking-homework';
async function fixture(t){
 const key=Buffer.alloc(32,9),collector=await createJournalService({version:1,role:'primary',dataRoot:mkdtempSync(join(tmpdir(),'speaking-client-intake-')),
  maxPhysicalBytes:64*1024*1024,incrementalAccounting:true,products:{[product]:{storageEngine:'scoped-drive-v2',encryptionKeys:{fixture:Buffer.alloc(32,4)},currentKeyId:'fixture',
   ingestKey:key,genericSchemas:speakingHomeworkSchemas,replicas:[{id:'fixture-copy',endpoint:'http://127.0.0.1:1/replica',key}],
   drive:{broker:'http://127.0.0.1:1/fixture-broker',receiptKey:key.toString('base64')}}}},{fixtureMode:true});
 await new Promise(resolve=>collector.server.listen(0,'127.0.0.1',resolve));
 const remote=new RemoteJournalStore({endpoint:`http://127.0.0.1:${collector.server.address().port}/rpc/${product}`,productId:product,key,fixtureMode:true});
 t.after(async()=>{await remote.close();await collector.close();});
 const metadata=createSpeakingHomeworkJournal({append:(...args)=>remote.append(...args)});
 const journal=p=>metadata.recordCommitted(speakingHomeworkBinding(p.scope),p);
 const f=await modern.fixture({journal});t.after(async()=>{await f.service.flushJournal();await f.db.close();});
 const intake=createSpeakingHomeworkIntake({journal:metadata,keys:{fixture:key},currentKeyId:'fixture',allowedOrigins:[origin]});
 const app=createIndependentApp({service:f.service,origin,journalRuntime:{journal,intake}}),client=request(app);
 const post=(path,body,id)=>{const call=client.post(prefix+path).set('Origin',origin).send(body);return id?call.set('x-exam-journal-request-id',id):call;};
 return{...f,post,client,collector,async context(){return(await post('/journal-context',f.identity).expect(200)).body.journalContext;},
  async rows(){await f.service.flushJournal();const u=(await f.pool.query('SELECT u.*,p.identity_ref,p.class_id FROM speaking_independent.work_unit u JOIN speaking_independent.profile p ON p.id=u.profile_id')).rows[0];
   const scope=storageScope(speakingHomeworkBinding({mode:'independent',assignmentRef:u.assignment_code,classRef:String(u.class_id),subjectRef:u.identity_ref,unitId:u.id}));
   const events=await collector.stores.get(product).read(scope),registry=new ProductLogRegistry({product,schemas:speakingHomeworkSchemas});return events.map(e=>registry.decode(scope,e));}};
}
function clientPacket(context,requestId,linkId){
 const id=randomUUID();return{schemaVersion:1,bindingId:context.bindingId,auth:{ticket:context.ticket,ticketId:context.ticketId},events:[{id,pageVisitId:randomUUID(),sequence:1,
  occurredAt:new Date().toISOString(),elapsedMs:10,build:'speaking-client-fixture',kind:'client.request',dataSchemaVersion:1,traceId:randomUUID(),requestId,
  data:{route:'check_main',outcome:'ok',durationMs:30,httpStatus:202,linkId}}]};
}
test('native HTTP grant issues frozen browser ticket; replayed batch and request IDs join SQL facts through signed Collector',async t=>{
 const f=await fixture(t),context=await f.context(),requestId=randomUUID();
 const response=await f.post('/checks/request',{...f.identity,part:'reason_action',url:modern.url(101)},requestId).expect(202);
 assert.equal(response.headers['x-exam-journal-request-id'],requestId);
 assert.equal(response.headers['access-control-expose-headers'],'x-exam-journal-request-id');
 const payload=clientPacket(context,requestId,response.body.check.id);
 for(let n=0;n<2;n++){const ack=await f.post('/journal-events',payload).expect(202);assert.equal(ack.body.persisted,true);assert.deepEqual(ack.body.acknowledgedIds,[payload.events[0].id]);}
 const rows=await f.rows();assert.equal(rows.length,3);
 const client=rows.find(r=>r.kind==='client.request'),api=rows.find(r=>r.kind==='api.request'),link=rows.find(r=>r.kind==='link.saved');
 assert.equal(client.requestId,api.requestId);assert.equal(api.data.outcome,'http_response_only');assert.equal(api.data.httpStatus,202);
 assert.equal(client.data.linkId,link.data.linkId);assert.equal(api.data.linkId,link.data.linkId);assert.equal(link.data.linkId,response.body.check.id);
 assert.equal(client.subjectRef,modern.ref);assert.equal(client.sessionRef,api.sessionRef);
 const raw=JSON.stringify(rows);for(const secret of [f.identity.accessToken,modern.url(101),'PRIVATE_MESSAGE'])assert.ok(!raw.includes(secret));
});
test('native logging context denies forged identity, foreign origin and revoked membership without new work',async t=>{
 const f=await fixture(t),before=(await f.pool.query('SELECT count(*)::int AS n FROM speaking_independent.work_unit')).rows[0].n;
 await f.post('/journal-context',{...f.identity,studentRef:randomUUID()}).expect(403);
 await f.client.post(prefix+'/journal-context').set('Origin','https://other.invalid').send(f.identity).expect(403);
 // Match the real source HTTP adapter, which preserves membership 403 as this native error type.
 const context=f.source.context;f.source.context=async input=>{try{return await context(input);}catch(error){throw new SpeakingHomeworkError(error.code,'Fixture source denied',403);}};
 f.drop();await f.post('/journal-context',f.identity).expect(403);
 assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM speaking_independent.work_unit')).rows[0].n,before);
 assert.equal((await f.rows()).length,0);
});
test('native rejected finish produces HTTP observation only, never a committed submission receipt',async t=>{
 const f=await fixture(t),id=randomUUID();await f.post('/finish',f.identity,id).expect(409);
 const rows=await f.rows();assert.equal(rows.length,1);assert.equal(rows[0].kind,'api.request');assert.equal(rows[0].requestId,id);
 assert.equal(rows[0].data.httpStatus,409);assert.equal(rows[0].data.outcome,'http_response_only');
 assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM speaking_independent.receipt')).rows[0].n,0);
});
test('native logging off leaves HTTP behavior and session access independent of logging routes',async t=>{
 const f=await modern.fixture({journal:false});t.after(()=>f.db.close());const client=request(createIndependentApp({service:f.service,origin}));
 const response=await client.post(prefix+'/open').set('Origin',origin).send(f.identity).expect(200);
 assert.equal(response.headers['x-exam-journal-request-id'],undefined);
 await client.post(prefix+'/journal-context').set('Origin',origin).send(f.identity).expect(404);
 assert.equal(f.service.journalHealth().enabled,false);
});

test('native repeated successful reads are one server summary, while a rejected write remains an individual HTTP fact',async t=>{
 const f=await fixture(t);
 for(let n=0;n<12;n++)await f.post('/open',f.identity,randomUUID()).expect(200);
 assert.equal(f.service.journalHealth().readSummary.pendingGroups,1);
 await f.post('/finish',f.identity,randomUUID()).expect(409);
 const rows=await f.rows(),summary=rows.filter(row=>row.kind==='api.summary');assert.equal(summary.length,1);assert.equal(summary[0].data.requests,12);
 assert.equal(summary[0].data.route,'open');assert.ok(summary[0].data.sumDurationMs>=summary[0].data.maxDurationMs);
 assert.equal(rows.filter(row=>row.kind==='api.request'&&row.data.route==='open').length,0);
 assert.equal(rows.filter(row=>row.kind==='api.request'&&row.data.route==='finish'&&row.data.httpStatus===409).length,1);
});
