import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {randomUUID} from 'node:crypto';
import * as modern from './fixture-independent.mjs';
const libraryRoot=process.env.SPEAKING_JOURNAL_LIBRARY_ROOT;
if(!libraryRoot)throw Error('SPEAKING_JOURNAL_LIBRARY_ROOT_REQUIRED');
const library=relative=>import(pathToFileURL(resolve(libraryRoot,relative)).href);
const {createSpeakingHomeworkJournal,speakingHomeworkBinding,speakingHomeworkSchemas}=await library('adapters/speaking-homework.mjs');
const {createJournalService}=await library('src/service.mjs');
const {RemoteJournalStore}=await library('src/remote-store.mjs');
const {ProductLogRegistry,storageScope}=await library('src/product-record.mjs');
const product='speaking-homework',registry=new ProductLogRegistry({product,schemas:speakingHomeworkSchemas});
async function fixture(t){
 const key=Buffer.alloc(32,9),service=await createJournalService({version:1,role:'primary',
  dataRoot:mkdtempSync(join(tmpdir(),'speaking-worker-log-')),maxPhysicalBytes:64*1024*1024,incrementalAccounting:true,
  products:{[product]:{storageEngine:'scoped-drive-v2',encryptionKeys:{fixture:Buffer.alloc(32,4)},currentKeyId:'fixture',
   ingestKey:key,genericSchemas:speakingHomeworkSchemas,replicas:[{id:'fixture-copy',endpoint:'http://127.0.0.1:1/replica',key}],
   drive:{broker:'http://127.0.0.1:1/fixture-broker',receiptKey:key.toString('base64')}}}}, {fixtureMode:true});
 await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));
 const remote=new RemoteJournalStore({endpoint:`http://127.0.0.1:${service.server.address().port}/rpc/${product}`,productId:product,key,fixtureMode:true});
 await remote.ready;t.after(async()=>{await remote.close();await service.close();});
 const appendErrors=[];
 const journal=createSpeakingHomeworkJournal({append:async(...args)=>{try{return await remote.append(...args);}catch(error){appendErrors.push(error.code||error.message);throw error;}}}),projections=[];
 const f=await modern.fixture({journal:projection=>{projections.push(structuredClone(projection));return journal.recordCommitted(speakingHomeworkBinding(projection.scope),projection);}});
 t.after(()=>f.db.close());
 return {...f,projections,async read(){
  const until=Date.now()+5000;while(f.service.journalHealth().pending&&Date.now()<until)await delay(10);
  assert.equal(f.service.journalHealth().pending,0);assert.equal(f.service.journalHealth().unknown,0,JSON.stringify(appendErrors));
  assert.equal(f.service.journalHealth().overflow,0);
  const scopes=new Map(projections.map(p=>{const b=speakingHomeworkBinding(p.scope);return[JSON.stringify(b),storageScope(b)];}));
  const rows=[];for(const scope of scopes.values())for(const row of await service.stores.get(product).read(scope))rows.push(registry.decode(scope,row));
  assert.ok(!JSON.stringify(rows).includes('chatgpt.com'));assert.ok(!JSON.stringify(rows).includes(f.identity.accessToken));
  return rows;
 }};
}
const pass=(n=1)=>({qualityPassed:true,questionCount:2,fingerprint:modern.fingerprint(n)});

test('modern worker: started lấy attempt mới từ SQL, completion cùng run; không đổi payload worker cũ',async t=>{
 const f=await fixture(t);
 await f.service.requestCheck({...f.identity,part:'reason_action',rawUrl:modern.url(21)});
 const job=await f.service.claimJob();assert.equal(job.attempts,0,'giữ ready.attempts native trước claim');
 assert.ok(!Object.keys(job).some(k=>k.startsWith('_journal_')));
 assert.ok(!Object.keys(job.u).some(k=>k.startsWith('_journal_')));
 await f.service.workerService(job).completeCheck(pass());
 const rows=await f.read(),checks=rows.filter(r=>r.kind==='check.progress');assert.equal(checks.length,2);
 assert.deepEqual(checks.map(r=>r.data.phase),['started','accepted']);
 assert.ok(checks.every(r=>r.data.jobAttempt===1&&r.subjectRef===modern.ref&&r.data.linkRevision===1));
 assert.equal(checks[0].data.runHash,checks[1].data.runHash);
 assert.equal(checks[1].data.questionCount,2);
 const native=(await f.pool.query('SELECT updated_at FROM speaking_independent.job WHERE id=$1',[job.job_id])).rows[0];
 assert.equal(checks[1].occurredAt,new Date(native.updated_at).toISOString());
});

test('modern worker: kết quả link cũ superseded; sai owner/lease hết hạn không phát hoặc đổi link mới',async t=>{
 const f=await fixture(t);
 await f.service.requestCheck({...f.identity,part:'reason_action',rawUrl:modern.url(22)});
 const old=await f.service.claimJob();
 await f.service.requestCheck({...f.identity,part:'reason_action',rawUrl:modern.url(23)});
 assert.equal((await f.service.workerService(old).completeCheck(pass(2))).status,'superseded');
 const current=await f.service.claimJob();
 await assert.rejects(f.service.workerService({...current,owner:randomUUID()}).completeCheck(pass(3)),e=>e.code==='STALE_JOB');
 await f.pool.query("UPDATE speaking_independent.job SET lease_until=now()-interval '1 minute' WHERE id=$1",[current.job_id]);
 await assert.rejects(f.service.workerService(current).completeCheck(pass(3)),e=>e.code==='STALE_JOB');
 const reclaimed=await f.service.claimJob();assert.notEqual(reclaimed.owner,current.owner);
 await assert.rejects(f.service.workerService(current).completeCheck(pass(3)),e=>e.code==='STALE_JOB');
 await f.service.workerService(reclaimed).completeCheck(pass(3));
 const checks=(await f.read()).filter(r=>r.kind==='check.progress');
 assert.equal(checks.length,5);
 assert.equal(checks.filter(r=>r.data.phase==='superseded').length,1);
 const starts=checks.filter(r=>r.data.jobId===current.job_id&&r.data.phase==='started');
 assert.deepEqual(starts.map(r=>r.data.jobAttempt),[1,2]);assert.notEqual(starts[0].data.runHash,starts[1].data.runHash);
 const done=checks.find(r=>r.data.phase==='accepted');assert.equal(done.data.linkRevision,2);
 assert.equal(done.data.runHash,starts[1].data.runHash);assert.equal(done.data.jobAttempt,2);
});

test('modern worker: lỗi dịch vụ khác bài chưa đạt; reset attempts vẫn tạo run mới',async t=>{
 const f=await fixture(t);
 await f.service.requestCheck({...f.identity,part:'reason_action',rawUrl:modern.url(24)});
 const first=await f.service.claimJob();await f.service.failJob(first,'AI_TIMEOUT');
 assert.equal((await f.pool.query('SELECT status FROM speaking_independent.link WHERE id=$1',[first.link_id])).rows[0].status,'pending');
 await f.pool.query("UPDATE speaking_independent.job SET status='failed',attempts=0,available_at=now()-interval '1 second' WHERE id=$1",[first.job_id]);
 const retry=await f.service.claimJob();
 await f.service.workerService(retry).rejectCheckJob({checkCode:'SHARE_UNAVAILABLE',questionCount:0});
 const checks=(await f.read()).filter(r=>r.kind==='check.progress');assert.equal(checks.length,4);
 const starts=checks.filter(r=>r.data.phase==='started');assert.ok(starts.every(r=>r.data.jobAttempt===1));
 assert.notEqual(starts[0].data.runHash,starts[1].data.runHash);
 assert.equal(checks.find(r=>r.data.phase==='failed').data.errorCode,'AI_TIMEOUT');
 assert.equal(checks.find(r=>r.data.phase==='rejected').data.errorCode,'SHARE_UNAVAILABLE');
});

test('modern Doctor: job thực từ accepted practice nối started/failed/retry/completed cùng owner đã commit',async t=>{
 const f=await fixture(t);
 await f.service.requestPracticeCheck({...f.identity,slot:1,exerciseId:modern.exercise(1),rawUrl:modern.url(25)});
 const check=await f.service.claimJob();
 await f.service.workerService(check).completePracticeCheck({...pass(4),matchedExerciseId:modern.exercise(1)});
 const first=await f.service.claimJob();assert.equal(first.kind,'analyze_practice');
 await f.service.workerService(first).failPracticeAnalysisJob({errorCode:'AI_TIMEOUT'});
 await f.pool.query("UPDATE speaking_independent.job SET available_at=now()-interval '1 second' WHERE id=$1",[first.job_id]);
 const retry=await f.service.claimJob(),worker=f.service.workerService(retry),catalog=await worker.getPracticeDoctorCatalog();
 await assert.rejects(worker.completePracticeAnalysisJob({catalogDigest:'0'.repeat(64),matches:[]}),e=>e.code==='DOCTOR_RESULT_INVALID');
 await worker.completePracticeAnalysisJob({catalogDigest:catalog.digest,matches:[]});
 const docs=(await f.read()).filter(r=>r.kind==='doctor.progress');assert.equal(docs.length,5);
 assert.deepEqual(docs.map(r=>r.data.phase),['queued','started','failed','started','completed']);
 assert.deepEqual(docs.map(r=>r.data.jobAttempt),[0,1,1,2,2]);assert.equal(docs[0].data.runHash,undefined);
 assert.equal(docs[1].data.runHash,docs[2].data.runHash);assert.equal(docs[3].data.runHash,docs[4].data.runHash);
 assert.notEqual(docs[1].data.runHash,docs[3].data.runHash);assert.equal(docs[4].data.receivedCount,0);
 assert.ok(docs.every(r=>r.data.jobKind==='analyze_practice'&&r.data.linkId===check.link_id));
});

test('modern Doctor homework: checker native tới receipt, queued0 rồi completed; chưa đồng nghĩa Docs verified',async t=>{
 const f=await fixture(t);
 for(const [i,part]of ['benefit_harm','reason_action','freestyle'].entries())await f.service.requestCheck({...f.identity,part,rawUrl:modern.url(30+i)});
 let fingerprint=5;
 const drain=async()=>{
  for(let batch=0;batch<8;batch++){
   const jobs=await f.service.claimJobs(4);if(!jobs.length)return;
   for(const job of jobs){
    const worker=f.service.workerService(job);
    if(job.kind==='check_main')await worker.completeCheck(pass(fingerprint++));
    else if(job.kind==='check_practice')await worker.completePracticeCheck({...pass(fingerprint++),matchedExerciseId:job.exercise_id});
    else if(['analyze_homework','analyze_practice'].includes(job.kind)){
     const catalog=await worker.getDoctorCatalog();await worker.completeDoctorJob({catalogDigest:catalog.digest,matches:[]});
    }else assert.fail('Không được nhận write_doc khi doc_progress chưa verified');
   }
  }assert.fail('Fixture không thoát được hàng việc hữu hạn');
 };
 await drain();
 for(const slot of [1,2])await f.service.requestPracticeCheck({...f.identity,slot,exerciseId:modern.exercise(slot),rawUrl:modern.url(33+slot)});
 await drain();const receipt=await f.service.finish(f.identity);await drain();
 const rows=await f.read(),homework=rows.filter(r=>r.kind==='doctor.progress'&&r.data.jobKind==='analyze_homework');
 assert.equal(rows.length,23,'đủ mốc link, checker, receipt và Doctor trong một luồng hữu hạn');
 assert.deepEqual(homework.map(r=>r.data.phase),['queued','started','completed']);
 assert.deepEqual(homework.map(r=>r.data.jobAttempt),[0,1,1]);assert.equal(homework[0].data.runHash,undefined);
 assert.equal(rows.filter(r=>r.kind==='submit.accepted'&&r.data.receiptId===receipt.id).length,1);
 const pending=(await f.pool.query("SELECT count(*)::int AS n FROM speaking_independent.job WHERE kind='write_doc' AND status='pending'")).rows[0].n;
 assert.equal(pending,0,'fixture web không có Doc ID; không được tự tạo đích Docs');
 assert.equal(rows.filter(r=>r.kind==='docs.progress').length,0,'không bịa Docs verified từ receipt/Doctor done');
});

test('modern worker: tắt logger hoặc callback lỗi vẫn giữ check accepted và kết quả nghiệp vụ',async t=>{
 for(const journal of [false,()=>{throw Error('fixture logger unavailable');}]){
  const f=await modern.fixture({journal});t.after(()=>f.db.close());
  await f.service.requestCheck({...f.identity,part:'reason_action',rawUrl:modern.url(41)});
  const job=await f.service.claimJob();assert.equal((await f.service.workerService(job).completeCheck(pass(8))).status,'accepted');
  const link=(await f.pool.query('SELECT status FROM speaking_independent.link WHERE id=$1',[job.link_id])).rows[0];
  assert.equal(link.status,'accepted');
  for(let turn=0;turn<20&&f.service.journalHealth().pending;turn++)await delay(1);
  if(journal===false){assert.equal(f.service.journalHealth().enabled,false);assert.equal(f.service.journalHealth().committed,0);}
  else{assert.equal(f.service.journalHealth().pending,0);assert.equal(f.service.journalHealth().unknown,3);}
 }
});

test('modern worker: COMMIT claim lỗi giữ job pending, không phát started',async t=>{
 const f=await fixture(t);
 await f.service.requestCheck({...f.identity,part:'reason_action',rawUrl:modern.url(40)});
 await f.read();const before=f.projections.length;
 const connect=f.pool.connect.bind(f.pool);f.pool.connect=async()=>{
  const db=await connect(),query=db.query.bind(db);return{...db,query(sql,...args){if(sql==='COMMIT')throw Error('FIXTURE_CLAIM_COMMIT_FAILED');return query(sql,...args);}};
 };
 await assert.rejects(f.service.claimJob(),/FIXTURE_CLAIM_COMMIT_FAILED/);
 const rows=await f.read();assert.equal(f.projections.length,before);assert.equal(rows.filter(r=>r.kind==='check.progress').length,0);
 const job=(await f.pool.query('SELECT status,attempts,owner FROM speaking_independent.job')).rows[0];
 assert.equal(job.status,'pending');assert.equal(job.attempts,0);assert.equal(job.owner,null);
});
