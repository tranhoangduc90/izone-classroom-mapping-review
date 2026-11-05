import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import * as modern from './fixture-independent.mjs';
import {createSpeakingProgressDocsWorker} from '../independent/src/speaking-progress-docs.js';
const root=process.env.SPEAKING_JOURNAL_LIBRARY_ROOT;if(!root)throw Error('SPEAKING_JOURNAL_LIBRARY_ROOT_REQUIRED');
const library=name=>import(pathToFileURL(resolve(root,name)).href);
const {createSpeakingHomeworkJournal,speakingHomeworkBinding,speakingHomeworkSchemas}=await library('adapters/speaking-homework.mjs');
const {createJournalService}=await library('src/service.mjs');
const {RemoteJournalStore}=await library('src/remote-store.mjs');
const {ProductLogRegistry,storageScope}=await library('src/product-record.mjs');
const product='speaking-homework',registry=new ProductLogRegistry({product,schemas:speakingHomeworkSchemas});
const docId='fixture-speaking-progress-doc';
function google(){
 let text='',link='',writes=0;const api={wrong:false,readOnly:false,onWrite:null,loseAck:false};
 api.get=async()=>({documentId:api.wrong?'fixture-other-doc':docId,...(api.readOnly?{}:{revisionId:'fixture-rev-'+writes}),
  tabs:[{tabProperties:{tabId:'t.0'},documentTab:{body:{content:[{paragraph:{elements:[{textRun:{content:modern.code+'\n'}}]}},
   {table:{tableRows:[{tableCells:[{content:[{paragraph:{elements:[{textRun:{content:'TÌNH TRẠNG NỘP BÀI SPEAKING\n'}}]}}]}]},
    {tableCells:[{content:[{paragraph:{elements:[{startIndex:100,endIndex:101+text.length,textRun:{content:text+'\n',textStyle:{link:{url:link}}}}]}}]}]}]}}]}}}]});
 api.write=async(id,body)=>{
  assert.equal(id,docId);writes++;text=body.requests.find(r=>r.insertText).insertText.text;
  link=body.requests.find(r=>r.updateTextStyle?.textStyle?.link).updateTextStyle.textStyle.link.url;
  if(api.onWrite)await api.onWrite();if(api.loseAck){api.loseAck=false;throw Error('DOC_TIMEOUT');}
 };
 api.writes=()=>writes;return api;
}
async function fixture(t,options={}){
 const key=Buffer.alloc(32,9),collector=await createJournalService({version:1,role:'primary',
  dataRoot:mkdtempSync(join(tmpdir(),'speaking-webapp-docs-log-')),maxPhysicalBytes:64*1024*1024,incrementalAccounting:true,
  products:{[product]:{storageEngine:'scoped-drive-v2',encryptionKeys:{fixture:Buffer.alloc(32,4)},currentKeyId:'fixture',ingestKey:key,
   genericSchemas:speakingHomeworkSchemas,replicas:[{id:'fixture-copy',endpoint:'http://127.0.0.1:1/replica',key}],
   drive:{broker:'http://127.0.0.1:1/fixture-broker',receiptKey:key.toString('base64')}}}},{fixtureMode:true});
 await new Promise(done=>collector.server.listen(0,'127.0.0.1',done));
 const remote=new RemoteJournalStore({endpoint:`http://127.0.0.1:${collector.server.address().port}/rpc/${product}`,productId:product,key,fixtureMode:true});
 t.after(async()=>{await remote.close();await collector.close();});
 await remote.ready;
 const projections=[],workers=[],journal=createSpeakingHomeworkJournal({append:remote.append.bind(remote)});
 const callback=Object.hasOwn(options,'journal')?options.journal:p=>{projections.push(structuredClone(p));return journal.recordCommitted(speakingHomeworkBinding(p.scope),p);};
 const f=await modern.fixture({journal:callback});t.after(()=>f.db.close());
 const id=f.session.workUnitId;await f.pool.query("UPDATE speaking_independent.work_unit SET document_id=$2,tab_id='t.0' WHERE id=$1",[id,docId]);
 return{...f,id,callback,projections,prepare:()=>f.service.requestCheck({...f.identity,part:'benefit_harm',rawUrl:modern.url(900)}),
  worker(gateway){const w=createSpeakingProgressDocsWorker({pool:f.pool,schema:'speaking_independent',gateway,journal:callback});workers.push(w);return w;},
  row:async()=>(await f.pool.query('SELECT * FROM speaking_independent.doc_progress WHERE unit_id=$1',[id])).rows[0],
  async read(){
   const health=()=>[f.service.journalHealth(),...workers.map(w=>w.journalHealth?.()||{pending:0,unknown:0,overflow:0})];
   const until=Date.now()+5000;while(health().some(h=>h.pending)&&Date.now()<until)await delay(10);
   for(const h of health()){assert.equal(h.pending,0);assert.equal(h.unknown,0);assert.equal(h.overflow,0);}
   const scopes=new Map(projections.map(p=>{const b=speakingHomeworkBinding(p.scope);return[JSON.stringify(b),storageScope(b)];}));
   const rows=[];for(const scope of scopes.values())for(const row of await collector.stores.get(product).read(scope))rows.push(registry.decode(scope,row));
   const serialized=JSON.stringify(rows);for(const secret of [docId,modern.url(900),f.identity.accessToken])assert.ok(!serialized.includes(secret));
   return rows.filter(r=>r.kind==='docs.progress');
  }};
}

test('webapp Docs: queued sau SQL commit, started/write/readback verified đúng unit/payload, không ghi nội dung',async t=>{
 const f=await fixture(t);await f.prepare();const gateway=google(),worker=f.worker(gateway);
 assert.equal(await worker.once(f.id),true);const row=await f.row();assert.equal(row.status,'verified');
 const events=await f.read();assert.deepEqual(events.map(r=>r.data.phase),['queued','started','write_attempt','write_received','verified']);
 assert.ok(events.every(r=>r.subjectRef===modern.ref&&r.sessionRef==='independent:'+f.id));
 assert.equal(new Set(events.map(r=>r.data.payloadHash)).size,1);
 const done=events.at(-1).data;assert.equal(done.queueSequence,1);assert.equal(done.appliedSequence,1);assert.equal(done.attemptSequence,1);
 assert.equal(done.readCalls,2);assert.equal(done.writeCalls,1);assert.equal(gateway.writes(),1);assert.ok(done.durationMs>=0);
 assert.equal(events[1].data.runHash,done.runHash);assert.equal(events[0].data.jobAttempt,0);
});

test('webapp Docs mất ACK: outcome_unknown rồi đọc lại, không ghi lần hai hoặc báo verified sớm',async t=>{
 const f=await fixture(t);await f.prepare();const gateway=google();gateway.loseAck=true;const worker=f.worker(gateway);
 await worker.once(f.id);assert.equal((await f.row()).status,'pending');
 let events=await f.read();assert.equal(events.filter(r=>r.data.phase==='verified').length,0);assert.equal(events.at(-1).data.phase,'outcome_unknown');
 await f.pool.query('UPDATE speaking_independent.doc_progress SET available_at=now() WHERE unit_id=$1',[f.id]);
 await worker.once(f.id);events=await f.read();const done=events.at(-1).data;
 assert.equal(done.phase,'verified');assert.equal(done.jobAttempt,2);assert.equal(done.writeCalls,0);assert.equal(done.readCalls,1);assert.equal(gateway.writes(),1);
 const runs=events.filter(r=>r.data.phase==='started');assert.notEqual(runs[0].data.runHash,runs[1].data.runHash);
});

test('webapp Docs bản mới đến trong lúc ghi: snapshot_applied/pending cho bản cũ, chỉ verified bản hiện hành',async t=>{
 const f=await fixture(t);await f.prepare();const gateway=google();let changed=false;
 gateway.onWrite=async()=>{if(!changed){changed=true;await f.service.requestCheck({...f.identity,part:'reason_action',rawUrl:modern.url(901)});}};
 const worker=f.worker(gateway);await worker.once(f.id);
 assert.equal((await f.row()).status,'pending');let events=await f.read();const applied=events.find(r=>r.data.phase==='snapshot_applied');
 assert.ok(applied);assert.equal(applied.data.queueSequence,2);assert.equal(applied.data.appliedSequence,1);assert.equal(applied.data.attemptSequence,1);
 assert.equal(events.filter(r=>r.data.phase==='verified').length,0);
 await worker.once(f.id);events=await f.read();const done=events.at(-1).data;assert.equal(done.phase,'verified');assert.equal(done.appliedSequence,2);
 assert.equal(done.queueSequence,2);assert.notEqual(done.payloadHash,applied.data.payloadHash);assert.equal(gateway.writes(),2);
});

test('webapp Docs sai chủ/403/không có quyền sửa: không write hoặc nhận verified; lý do riêng, logger không sửa quyết định',async t=>{
 for(const mode of ['wrong','forbidden','readOnly']){
  const f=await fixture(t);await f.prepare();const gateway=google();
  if(mode==='wrong')gateway.wrong=true;if(mode==='readOnly')gateway.readOnly=true;
  if(mode==='forbidden')gateway.get=async()=>{throw Error('DOC_HTTP_403');};
  await f.worker(gateway).once(f.id);const row=await f.row(),events=await f.read();
  assert.equal(row.status,mode==='readOnly'?'pending':'blocked');assert.equal(gateway.writes(),0);
  assert.equal(events.filter(r=>r.data.phase==='verified').length,0);
  assert.equal(events.at(-1).data.errorCode,mode==='wrong'?'DOC_IDENTITY_MISMATCH':mode==='forbidden'?'DOC_HTTP_403':'DOC_WRITE_UNAVAILABLE');
 }
});

test('webapp Docs SQL COMMIT lỗi khi xếp hàng: rollback cả link/queue và không phát queued',async t=>{
 const f=await fixture(t),connect=f.pool.connect.bind(f.pool);
 f.pool.connect=async()=>{const db=await connect(),query=db.query.bind(db);return{...db,query(sql,...args){if(sql==='COMMIT')throw Error('FIXTURE_DOCS_COMMIT_FAILED');return query(sql,...args);}};};
 await assert.rejects(f.prepare(),/FIXTURE_DOCS_COMMIT_FAILED/);assert.equal(await f.row(),undefined);assert.equal((await f.read()).length,0);
});

test('webapp Docs logger tắt/lỗi giữ native verified, không chặn I/O hoặc kết quả',async t=>{
 for(const journal of [false,()=>{throw Error('fixture collector unavailable');}]){
  const f=await fixture(t,{journal});await f.prepare();const gateway=google(),worker=f.worker(gateway);await worker.once(f.id);
  assert.equal((await f.row()).status,'verified');assert.equal(gateway.writes(),1);
  if(journal===false){assert.equal(f.service.journalHealth().enabled,false);assert.equal(worker.journalHealth?.().enabled,false);}
 }
});

test('webapp Docs mất phản hồi SQL sau readback: không bịa verified; retry nhận lại có run mới dù attempts reset',async t=>{
 const f=await fixture(t);await f.prepare();const connect=f.pool.connect.bind(f.pool);let lost=false;
 f.pool.connect=async()=>{const db=await connect(),query=db.query.bind(db);return{...db,async query(sql,...args){
  const result=await query(sql,...args);
  if(!lost&&sql.includes('SET last_text=$2,last_link=$3')){lost=true;throw Error('FIXTURE_SQL_ACK_LOST');}
  return result;
 }};};
 const gateway=google(),worker=f.worker(gateway);await worker.once(f.id);
 assert.equal((await f.row()).status,'pending');let events=await f.read();
 assert.equal(events.filter(r=>r.data.phase==='verified').length,0);assert.equal(events.at(-1).data.phase,'outcome_unknown');
 await f.pool.query('UPDATE speaking_independent.doc_progress SET available_at=now() WHERE unit_id=$1',[f.id]);
 await worker.once(f.id);events=await f.read();assert.equal(events.at(-1).data.phase,'verified');assert.equal(gateway.writes(),1);
 const starts=events.filter(r=>r.data.phase==='started');assert.deepEqual(starts.map(r=>r.data.jobAttempt),[1,1]);
 assert.notEqual(starts[0].data.runHash,starts[1].data.runHash);
});
