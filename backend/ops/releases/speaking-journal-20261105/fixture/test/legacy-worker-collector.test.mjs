import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import * as legacy from './fixture-legacy.mjs';
import {runSpeakingCheckJob} from '../legacy/src/speaking-check-worker.js';
import {runPracticeCheckJob} from '../legacy/src/speaking-practice-worker.js';
const root=process.env.SPEAKING_JOURNAL_LIBRARY_ROOT;
if(!root)throw Error('SPEAKING_JOURNAL_LIBRARY_ROOT_REQUIRED');
const library=name=>import(pathToFileURL(resolve(root,name)).href);
const {createSpeakingHomeworkJournal,speakingHomeworkBinding,speakingHomeworkSchemas}=await library('adapters/speaking-homework.mjs');
const {createJournalService}=await library('src/service.mjs');
const {RemoteJournalStore}=await library('src/remote-store.mjs');
const {ProductLogRegistry,storageScope}=await library('src/product-record.mjs');
const product='speaking-homework',registry=new ProductLogRegistry({product,schemas:speakingHomeworkSchemas});
const identity={accessToken:legacy.accessToken,studentRef:legacy.studentRef};
const passing=()=>({kind:'pass',fingerprint:'9'.repeat(64),count:6,countVerified:true});
async function fixture(t){
 const key=Buffer.alloc(32,9),collector=await createJournalService({version:1,role:'primary',
  dataRoot:mkdtempSync(join(tmpdir(),'speaking-legacy-check-log-')),maxPhysicalBytes:64*1024*1024,incrementalAccounting:true,
  products:{[product]:{storageEngine:'scoped-drive-v2',encryptionKeys:{fixture:Buffer.alloc(32,4)},currentKeyId:'fixture',
   ingestKey:key,genericSchemas:speakingHomeworkSchemas,replicas:[{id:'fixture-copy',endpoint:'http://127.0.0.1:1/replica',key}],
   drive:{broker:'http://127.0.0.1:1/fixture-broker',receiptKey:key.toString('base64')}}}},{fixtureMode:true});
 await new Promise(done=>collector.server.listen(0,'127.0.0.1',done));
 const remote=new RemoteJournalStore({endpoint:`http://127.0.0.1:${collector.server.address().port}/rpc/${product}`,productId:product,key,fixtureMode:true});
 await remote.ready;t.after(async()=>{await remote.close();await collector.close();});
 const projections=[],journal=createSpeakingHomeworkJournal({append:remote.append.bind(remote)});
 const f=await legacy.fixture({journal:p=>{projections.push(structuredClone(p));return journal.recordCommitted(speakingHomeworkBinding(p.scope),p);}});
 t.after(()=>f.db.close());
 return{...f,projections,async read({unknown=0}={}){
  const until=Date.now()+5000;while(f.service.journalHealth().pending&&Date.now()<until)await delay(10);
  assert.equal(f.service.journalHealth().pending,0);assert.equal(f.service.journalHealth().unknown,unknown);
  assert.equal(f.service.journalHealth().overflow,0);
  const scopes=new Map(projections.map(p=>{const b=speakingHomeworkBinding(p.scope);return[JSON.stringify(b),storageScope(b)];}));
  const rows=[];for(const scope of scopes.values())for(const row of await collector.stores.get(product).read(scope))rows.push(registry.decode(scope,row));
  assert.ok(!JSON.stringify(rows).includes('chatgpt.com'));assert.ok(!JSON.stringify(rows).includes(legacy.accessToken));
  assert.ok(!JSON.stringify(rows).includes('doc-A'));return rows;
 }};
}

test('legacy main: runner native nối started/accepted đúng claim và scope, không đổi DTO',async t=>{
 const f=await fixture(t);await f.service.requestCheck({...identity,part:'paraphrase',rawUrl:legacy.share('a')});
 const job=await f.service.claimCheckJob();
 assert.deepEqual(Object.keys(job).sort(),['class_id','course_id','course_work_id','job_id','link_id','min_questions','part','share_url','student_ref'].sort());
 assert.equal(await runSpeakingCheckJob(f.service,job,async()=>passing()),'accepted');
 const rows=await f.read(),checks=rows.filter(r=>r.kind==='check.progress');assert.equal(checks.length,2);
 assert.deepEqual(checks.map(r=>r.data.phase),['started','accepted']);
 assert.ok(checks.every(r=>r.data.jobAttempt===1&&r.data.currentJobAttempt===1&&r.data.claimCurrent===true));
 assert.equal(checks[0].data.runHash,checks[1].data.runHash);assert.equal(checks[1].data.questionCount,6);
 assert.equal(checks[1].data.countVerified,true);assert.equal(checks[1].data.requiredCount,5);
 const grant=(await f.pool.query('SELECT id FROM speaking_homework.access_grant WHERE student_ref=$1 AND document_id=$2',[legacy.studentRef,'doc-A'])).rows[0].id;
 assert.ok(f.projections.every(p=>p.scope.unitId===grant&&p.scope.mode==='legacy'&&p.scope.subjectRef===legacy.studentRef));
 const native=(await f.pool.query('SELECT updated_at FROM speaking_homework.check_job WHERE id=$1',[job.job_id])).rows[0];
 assert.equal(checks[1].occurredAt,new Date(native.updated_at).toISOString());
});

test('legacy retry: AI lỗi khác bài chưa đạt; reset attempts vẫn có run riêng và cùng kết quả commit',async t=>{
 const f=await fixture(t);await f.service.requestCheck({...identity,part:'paraphrase',rawUrl:legacy.share('b')});
 const first=await f.service.claimCheckJob();
 assert.equal(await runSpeakingCheckJob(f.service,first,async()=>({kind:'error',errorCode:'AI_TIMEOUT'})),'retry');
 assert.equal((await f.pool.query('SELECT check_status FROM speaking_homework.submission_link WHERE id=$1',[first.link_id])).rows[0].check_status,'pending');
 await f.pool.query("UPDATE speaking_homework.check_job SET attempts=0,updated_at=now()-interval '1 minute' WHERE id=$1",[first.job_id]);
 const retry=await f.service.claimCheckJob();
 assert.equal(await runSpeakingCheckJob(f.service,retry,async()=>({kind:'blocked',title:'Chưa mở được hội thoại'})),'rejected');
 const checks=(await f.read()).filter(r=>r.kind==='check.progress');assert.equal(checks.length,4);
 assert.deepEqual(checks.map(r=>r.data.phase),['started','failed','started','rejected']);
 assert.ok(checks.every(r=>r.data.jobAttempt===1&&r.data.claimCurrent));
 assert.equal(checks[0].data.runHash,checks[1].data.runHash);assert.equal(checks[2].data.runHash,checks[3].data.runHash);
 assert.notEqual(checks[0].data.runHash,checks[2].data.runHash);
 assert.equal(checks[1].data.errorCode,'AI_TIMEOUT');assert.equal(checks[3].data.errorCode,'SHARE_UNAVAILABLE');
});

test('legacy late result: giữ native không có owner fence nhưng log đúng run cũ và chỉ rõ claim đã đổi',async t=>{
 const f=await fixture(t);await f.service.requestCheck({...identity,part:'paraphrase',rawUrl:legacy.share('c')});
 const old=await f.service.claimCheckJob();
 await f.pool.query("UPDATE speaking_homework.check_job SET updated_at=now()-interval '6 minutes' WHERE id=$1",[old.job_id]);
 const current=await f.service.claimCheckJob();assert.equal(current.job_id,old.job_id);
 assert.equal(await runSpeakingCheckJob(f.service,old,async()=>passing()),'accepted','giữ quyết định native khi worker cũ về muộn');
 await runSpeakingCheckJob(f.service,current,async()=>passing());
 const checks=(await f.read()).filter(r=>r.kind==='check.progress');assert.equal(checks.length,3);
 const starts=checks.filter(r=>r.data.phase==='started'),done=checks.find(r=>r.data.phase==='accepted');
 assert.deepEqual(starts.map(r=>r.data.jobAttempt),[1,2]);assert.equal(done.data.runHash,starts[0].data.runHash);
 assert.equal(done.data.jobAttempt,1);assert.equal(done.data.currentJobAttempt,2);assert.equal(done.data.claimCurrent,false);
});

test('legacy practice: lane clone giữ claim, runner đọc Share/AI giả và SQL accepted trước log',async t=>{
 const f=await fixture(t);
 await f.pool.query("UPDATE speaking_homework.assignment SET required_practice_count=1 WHERE assignment_code='67-speaking-lesson-2'");
 const exercise=(await f.pool.query("INSERT INTO speaking_homework.doctor_exercise(course_key,source_record_id,title,exercise_url) VALUES('67','fixture-check','Fixture','https://example.invalid') RETURNING id")).rows[0].id;
 await f.service.requestPracticeCheck({...identity,slot:1,exerciseId:exercise,rawUrl:legacy.share('d')});
 const [job]=await f.service.claimWorkerJobs({practice:1});assert.equal(job.work_kind,'practice_check');
 const result=await runPracticeCheckJob(f.service,job,{readShare:async()=>({messages:[{role:'user',text:'Fixture practice answer'},{role:'assistant',text:'Fixture feedback'}]}),
  analyze:async()=>({completed:true,matched:true,completedTurns:[]})});assert.equal(result.status,'accepted');
 const checks=(await f.read()).filter(r=>r.kind==='check.progress');assert.equal(checks.length,2);
 assert.deepEqual(checks.map(r=>r.data.phase),['started','accepted']);assert.equal(checks[0].data.runHash,checks[1].data.runHash);
 assert.ok(checks.every(r=>r.data.claimCurrent&&r.data.jobAttempt===1&&r.data.linkRevision===1));
});

test('legacy claim COMMIT lỗi: rollback giữ pending/attempt0 và không phát started',async t=>{
 const f=await fixture(t);await f.service.requestCheck({...identity,part:'paraphrase',rawUrl:legacy.share('e')});
 await f.read();const count=f.projections.length,connect=f.pool.connect.bind(f.pool);
 f.pool.connect=async()=>{const db=await connect(),query=db.query.bind(db);return{...db,query(sql,...args){if(sql==='COMMIT')throw Error('FIXTURE_LEGACY_CLAIM_COMMIT_FAILED');return query(sql,...args);}};};
 await assert.rejects(f.service.claimCheckJob(),/FIXTURE_LEGACY_CLAIM_COMMIT_FAILED/);
 assert.equal((await f.read()).filter(r=>r.kind==='check.progress').length,0);assert.equal(f.projections.length,count);
 const row=(await f.pool.query('SELECT status,attempts FROM speaking_homework.check_job')).rows[0];assert.equal(row.status,'pending');assert.equal(row.attempts,0);
});

test('legacy checker logger tắt/lỗi không cản kết quả nghiệp vụ hoặc thêm field vào DTO',async t=>{
 for(const journal of [false,()=>{throw Error('fixture collector unavailable');}]){
  const f=await legacy.fixture({journal});t.after(()=>f.db.close());
  await f.service.requestCheck({...identity,part:'paraphrase',rawUrl:legacy.share('f')});const job=await f.service.claimCheckJob();
  assert.equal(await runSpeakingCheckJob(f.service,job,async()=>passing()),'accepted');
  assert.equal((await f.pool.query('SELECT check_status FROM speaking_homework.submission_link WHERE id=$1',[job.link_id])).rows[0].check_status,'accepted');
  for(let i=0;i<50&&f.service.journalHealth().pending;i++)await delay(1);
  if(journal===false)assert.equal(f.service.journalHealth().committed,0);
  else assert.equal(f.service.journalHealth().unknown,3);
 }
});

test('legacy practice retry: lỗi đọc Share giữ pending; HTTP404 chốt rejected, log không lẫn hai lần claim',async t=>{
 const f=await fixture(t);
 await f.pool.query("UPDATE speaking_homework.assignment SET required_practice_count=1 WHERE assignment_code='67-speaking-lesson-2'");
 const exercise=(await f.pool.query("INSERT INTO speaking_homework.doctor_exercise(course_key,source_record_id,title,exercise_url) VALUES('67','fixture-retry','Fixture','https://example.invalid') RETURNING id")).rows[0].id;
 await f.service.requestPracticeCheck({...identity,slot:1,exerciseId:exercise,rawUrl:legacy.share('8')});
 const first=await f.service.claimPracticeCheckJob();
 assert.equal((await runPracticeCheckJob(f.service,first,{readShare:async()=>{throw Error('Fixture network');}})).status,'retry');
 assert.equal((await f.pool.query('SELECT status FROM speaking_homework.practice_link')).rows[0].status,'pending');
 const retry=await f.service.claimPracticeCheckJob();
 assert.equal((await runPracticeCheckJob(f.service,retry,{readShare:async()=>{throw Error('HTTP 404');}})).status,'rejected');
 const rows=(await f.read()).filter(r=>r.kind==='check.progress');assert.deepEqual(rows.map(r=>r.data.phase),['started','failed','started','rejected']);
 assert.deepEqual(rows.map(r=>r.data.jobAttempt),[1,1,2,2]);assert.ok(rows.every(r=>r.data.claimCurrent));
 assert.notEqual(rows[0].data.runHash,rows[2].data.runHash);assert.equal(rows[0].data.runHash,rows[1].data.runHash);
 assert.equal(rows[2].data.runHash,rows[3].data.runHash);
});

test('legacy mất context claim: giữ SQL accepted nhưng báo unknown, không bịa run từ DTO được sao chép ngoài boundary',async t=>{
 const f=await fixture(t);await f.service.requestCheck({...identity,part:'paraphrase',rawUrl:legacy.share('7')});
 const job=await f.service.claimCheckJob();
 assert.equal(await runSpeakingCheckJob(f.service,{...job},async()=>passing()),'accepted');
 const rows=(await f.read({unknown:1})).filter(r=>r.kind==='check.progress');assert.equal(rows.length,1);assert.equal(rows[0].data.phase,'started');
 assert.equal((await f.pool.query('SELECT check_status FROM speaking_homework.submission_link WHERE id=$1',[job.link_id])).rows[0].check_status,'accepted');
});

test('legacy batch hai người: trả ngược thứ tự, lỗi một phần/replay và tên giống nhau vẫn đúng grant/link',async t=>{
 const f=await fixture(t);
 await f.pool.query("UPDATE mapping.student_mapping_review SET erp_student_name_snapshot='Fixture same name'");
 await f.service.requestCheck({...identity,part:'paraphrase',rawUrl:legacy.share('1')});
 await f.service.requestCheck({accessToken:legacy.secondToken,studentRef:legacy.secondStudentRef,part:'clarify_1',rawUrl:legacy.share('2')});
 await f.service.requestCheck({...identity,part:'speaking',rawUrl:legacy.share('3')});
 const jobs=await f.service.claimCheckJobs(2),a=jobs.find(j=>j.student_ref===legacy.studentRef),b=jobs.find(j=>j.student_ref===legacy.secondStudentRef);
 assert.ok(a&&b);const blocked=async()=>({kind:'blocked',title:'Chưa mở được hội thoại'});
 assert.equal(await runSpeakingCheckJob(f.service,b,blocked),'rejected');
 assert.equal(await runSpeakingCheckJob(f.service,a,async()=>passing()),'accepted');
 assert.equal(await runSpeakingCheckJob(f.service,b,blocked),'rejected');
 const checks=(await f.read()).filter(r=>r.kind==='check.progress');assert.equal(checks.length,4);
 for(const [job,subject,phase]of [[a,legacy.studentRef,'accepted'],[b,legacy.secondStudentRef,'rejected']]){
  const own=checks.filter(r=>r.data.jobId===job.job_id);assert.equal(own.length,2);
  assert.ok(own.every(r=>r.subjectRef===subject&&r.data.linkId===job.link_id));assert.equal(own.find(r=>r.data.phase===phase).data.runHash,own.find(r=>r.data.phase==='started').data.runHash);
 }
 const untouched=(await f.pool.query("SELECT l.check_status,j.status FROM speaking_homework.submission_link l JOIN speaking_homework.check_job j ON j.link_id=l.id WHERE l.part='speaking'")).rows[0];
 assert.deepEqual(untouched,{check_status:'pending',status:'pending'});
});
