import assert from 'node:assert/strict';
import test,{before,after} from 'node:test';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import request from 'supertest';
import {createMiniFixture} from './helpers/mini-answer-sheet-fixture.js';
import {createTermTestWritingGradingService} from '../src/term-test-writing-grading.js';
import {createApp} from '../src/app.js';

// Bài và Portal đều giả; chạy PostgreSQL/HTTP thật. Điểm 0 phải là kết quả cuối,
// không sinh việc AI; job ghi điểm được thử lại đúng học viên khi đích tạm lỗi.
let fixture,service,api,sent=[],failSync=false;
const definitions=slug=>(slug==='term-test-1'?[2]:[1,2]).map(n=>({id:`task${n}`,prompt:`Đề giả Task ${n}`}));
before(async()=>{
  fixture=await createMiniFixture({completeSchema:true,examOrder:true});
  await fixture.db.exec(await readFile(new URL('../db/017-writing-scope.sql',import.meta.url),'utf8'));
  for(const slug of ['term-test-1','term-test-2'])await fixture.db.query(`INSERT INTO assessment.test_definition
    (slug,title,version,listening_definition,reading_definition,is_active)
    SELECT $1,$1,1,listening_definition,reading_definition,true FROM assessment.test_definition WHERE slug='mini-test-lesson-5'`,[slug]);
  const syncErpGrades=async payload=>{if(failSync)throw Error('Portal giả đang lỗi');sent.push(payload);return{status:'synced'};};
  service=createTermTestWritingGradingService({pool:fixture.pool,syncErpGrades});
  api=request(createApp({pool:fixture.pool,config:{authMode:'legacy',legacyReviewToken:'fixture-only-key',allowedOrigins:new Set(),trustProxyHops:0},
    termTestWritingGradingService:service,syncErpGrades,
    termTestAssetService:{supports:()=>true,getTiming:()=>({writingDurationMinutes:60}),getContent:async slug=>({writing:{tasks:definitions(slug)}})}}));
});
after(async()=>fixture?.db.close());
async function clean(){
  await fixture.db.exec(`DELETE FROM assessment.term_test_writing_grading_job;DELETE FROM assessment.term_test_writing_grading_final;
    DELETE FROM assessment.term_test_writing_grading_component;DELETE FROM assessment.term_test_writing_grading_criterion;
    DELETE FROM assessment.term_test_writing_grading_run;DELETE FROM assessment.term_test_attempt;`);
  sent=[];failSync=false;
}
async function seed(slug,mode,{task1='',task2='',scope='exam',submitted=true,source=null}={}){
  const id=randomUUID();
  await fixture.db.query(`INSERT INTO assessment.term_test_attempt
    (id,client_submission_id,test_slug,definition_version,erp_course_class_id,class_name_snapshot,erp_student_contact_id,student_name_snapshot,
    listening_answers,listening_result,listening_submitted_at,reading_answers,reading_result,reading_submitted_at,completed_at,combined_result,
    writing_task_1,writing_task_2,writing_started_at,writing_updated_at,writing_submitted_at,exam_mode,exam_delivery,writing_scope,writing_source_attempt_id)
    VALUES($1,$2,$3,1,1293,'IC2304',900001,'Học viên giả','{}','{}',now(),'{}','{}',now(),now(),$4,$5,$6,
    now(),now(),CASE WHEN $7 THEN now() ELSE NULL END,$8,'cbt',$9,$10)`,
    [id,randomUUID(),slug,JSON.stringify({listening:{band:6.5},reading:{band:6}}),task1,task2,submitted,mode,scope,source]);
  return{id,task1,task2,testSlug:slug,attemptToken:id,taskDefinitions:definitions(slug)};
}
for(const slug of ['term-test-1','term-test-2'])for(const mode of ['lis_first','read_first']){
  test(`${slug} · ${mode}: bài bắt buộc trắng nhận 0, không AI, Portal nhận đúng 0 và retry`,async()=>{
    await clean();const row=await seed(slug,mode,{task1:' \n\t',task2:'\r\n '});
    const result=await service.ensureSubmission(row);
    assert.equal(result.ready,true);assert.equal(result.writingScore,0);
    assert.equal(result.task1Score,slug==='term-test-1'?null:0);assert.equal(result.task2Score,0);
    assert.equal(result.tasks.length,definitions(slug).length);
    for(const t of result.tasks){assert.equal(t.taskScore,0);assert.equal(t.wordCount,0);assert.equal(t.gradingMethod,'blank_rule');assert.deepEqual(t.criteria,[]);assert.match(t.report,/Không có nội dung bài làm/);}
    assert.equal((await fixture.db.query("SELECT count(*)::int AS n FROM assessment.term_test_writing_grading_job WHERE job_type='dispatch'")).rows[0].n,0);
    failSync=true;assert.deepEqual(await service.claimJobs({workerId:'worker-blank'}),[]);assert.equal(sent.length,0);
    failSync=false;await fixture.db.exec("UPDATE assessment.term_test_writing_grading_job SET next_attempt_at=now()");
    assert.deepEqual(await service.claimJobs({workerId:'worker-blank'}),[]);
    assert.equal(sent.length,1);assert.equal(sent[0].grades.writing,0);assert.equal(sent[0].studentId,'900001');
    await service.ensureSubmission(row);await service.claimJobs({workerId:'worker-blank'});assert.equal(sent.length,1);
  });
  test(`${slug} · ${mode}: chưa nộp không chốt 0; phiếu L/R không tạo Writing`,async()=>{
    await clean();const draft=await seed(slug,mode,{submitted:false});
    await assert.rejects(service.ensureSubmission(draft),/chưa được máy chủ xác nhận nộp/);
    const lr=await seed(slug,mode,{scope:'lr_only',source:draft.id});
    const result=await service.ensureSubmission(lr);assert.equal(result.status,'not_applicable');assert.equal(result.writingScore,null);
    assert.equal((await fixture.db.query('SELECT count(*)::int AS n FROM assessment.term_test_writing_grading_run')).rows[0].n,0);
    const r=await api.post('/api/term-tests/writing').send({attemptToken:lr.id,task1:'',task2:'',action:'start'});
    assert.equal(r.status,409);assert.equal(r.body.error,'WRITING_NOT_APPLICABLE');
  });
}
for(const mode of ['lis_first','read_first'])for(const blankTask of [1,2])test(`term-test-2 · ${mode}: Task ${blankTask} trắng vẫn tính hệ số đúng`,async()=>{
  await clean();const row=await seed('term-test-2',mode,{task1:blankTask===1?'':'Bài Task 1',task2:blankTask===2?'':'Bài Task 2'});
  const pending=await service.ensureSubmission(row);assert.equal(pending.ready,false);
  const [job]=await service.claimJobs({workerId:'worker-mixed'});assert.ok(job);assert.equal(job.taskNumber,blankTask===1?2:1);
  await service.completeDispatch({jobId:job.jobId,workerId:'worker-mixed'});
  await fixture.db.exec("UPDATE assessment.term_test_writing_grading_job SET next_attempt_at=now() WHERE job_type='collect'");
  const [collect]=await service.claimJobs({workerId:'worker-mixed'});
  const criteria=(collect.taskNumber===1?['TA','CC','LR','GRA']:['TR','CC','LR','GRA']).map(code=>({code,bandScore:6,feedback:'Nhận xét giả'}));
  const result=await service.completeResult({jobId:collect.jobId,workerId:'worker-mixed',runKey:collect.runKey,result:{taskScore:6,criteria}});
  assert.equal(result.grading.writingScore,blankTask===1?4:2);
  assert.equal(result.grading[`task${blankTask}Score`],0);
  assert.equal(sent.at(-1).grades.writing,blankTask===1?4:2);
});

for(const slug of ['term-test-1','term-test-2'])for(const mode of ['lis_first','read_first'])test(`${slug} · ${mode}: thu hết giờ giữ bản đã lưu, không chốt 0 từ payload rỗng`,async()=>{
  await clean();const row=await seed(slug,mode,{submitted:false,task1:slug==='term-test-2'?'Bản Task 1 đã lưu':'',task2:'Bản Task 2 đã lưu'});
  await fixture.db.query("UPDATE assessment.term_test_attempt SET writing_deadline_at=now()-interval '1 minute' WHERE id=$1",[row.id]);
  const response=await api.post('/api/term-tests/writing').send({attemptToken:row.id,task1:'',task2:'',action:'submit',baseRevision:0});
  assert.equal(response.status,200);assert.equal(response.body.writing.reason,'deadline_expired');
  const status=await service.getStatus(row.id);assert.equal(status.ready,false);
  const runs=(await fixture.db.query('SELECT task_number,essay_text,status,result_json FROM assessment.term_test_writing_grading_run ORDER BY task_number')).rows;
  assert.equal(runs.length,definitions(slug).length);
  for(const run of runs){assert.match(run.essay_text,/đã lưu/);assert.equal(run.status,'queued');assert.equal(run.result_json,null);}
});
