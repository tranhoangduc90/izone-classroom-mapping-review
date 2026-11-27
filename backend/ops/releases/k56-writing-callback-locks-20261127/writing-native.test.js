import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {createNativeOrderFixture} from './helpers/native-exam-order-fixture.js';
import {createTermTestWritingGradingService} from '../src/k56-live/term-test-writing-grading.js';
import {createExamPublisher} from '../src/k56-live/portal-sync/client/exam-source.mjs';

const profiles = [
  {slug:'term-test-1-k56', task:2},
  {slug:'term-test-2-k56', task:1},
  {slug:'mini-test-k56', task:2, homework:true},
];
const homeworkUrl = 'https://ducizone.ddns.net/writing/shared/writing-essays/'+'a'.repeat(48)+'/view?v=1';

async function setup(t, profile) {
  const {db,pool}=await createNativeOrderFixture({examOrder:true});
  t.after(()=>db.close());
  await db.exec(await readFile(new URL('../db/k56-offline-fixture.sql',import.meta.url),'utf8'));
  await db.query(`INSERT INTO assessment.test_definition
    (slug,title,version,listening_definition,reading_definition,is_active)
    SELECT $1,$1,1,listening_definition,reading_definition,true
    FROM assessment.test_definition WHERE slug='mini-test-lesson-5' `,[profile.slug]);
  await db.query('INSERT INTO assessment_k56.term_test_class_access VALUES ($1,1293,true)',[profile.slug]);
  return {db,pool};
}

async function insertAttempt(db, {slug,task}, student) {
  const {rows:[attempt]}=await db.query(`INSERT INTO assessment.term_test_attempt
    (client_submission_id,test_slug,definition_version,erp_course_class_id,class_name_snapshot,
    erp_student_contact_id,student_name_snapshot,listening_answers,listening_result,listening_submitted_at,
    reading_answers,reading_result,reading_submitted_at,completed_at,combined_result,
    writing_task_1,writing_task_2,writing_started_at,writing_updated_at,writing_submitted_at,exam_mode,attempt_mode)
    VALUES ($1,$2,1,1293,'IC2304',$3,'Synthetic learner','{}','{}',now(),
      '{}','{}',now(),now(),'{}',$4,$5,now(),now(),now(),'lis_first','cbt') RETURNING id `,
    [randomUUID(),slug,student,task===1?'Synthetic Task 1':'',task===2?'Synthetic Task 2':'']);
  await db.query('INSERT INTO assessment_k56.term_test_roster VALUES ($1,1293,$2,true)',[slug,student]);
  return {attemptToken:attempt.id,testSlug:slug,task1:'Synthetic Task 1',task2:'Synthetic Task 2',
    taskDefinitions:[{id:'task'+task,prompt:'Synthetic prompt'}]};
}

function resultFor({task,homework}, score=6) {
  if(homework)return {mode:'homework',lmsUrl:homeworkUrl};
  const components={TA:['ta_key_features_overview','ta_data_support'],
    TR:['tr_task_coverage','tr_position','tr_idea_development'],
    CC:['cc_organization','cc_cohesive_devices','cc_referencing'],
    LR:['lr_range','lr_word_choice','lr_word_formation_spelling'],GRA:['gra_detail']};
  return {taskScore:score,report:'Synthetic report',criteria:[task===1?'TA':'TR','CC','LR','GRA'].map(code=>({
    code,bandScore:score,feedback:'Synthetic feedback',components:components[code].map(id=>({code:id,label:id,feedback:'Synthetic detail'})),
  }))};
}

async function startCollect(db, service, profile, student, workerId) {
  const submission=await insertAttempt(db,profile,student);
  await service.ensureSubmission(submission);
  const [dispatch]=await service.claimJobs({workerId,limit:1,testSlug:profile.slug});
  assert.equal(dispatch.jobType,'dispatch');
  await service.completeDispatch({jobId:dispatch.jobId,workerId,sourceRecordId:'synthetic-record'});
  await db.query(`UPDATE assessment.term_test_writing_grading_job
    SET next_attempt_at=now() WHERE idempotency_key=$1 `,[dispatch.runKey+':collect']);
  const [collect]=await service.claimJobs({workerId,limit:1,testSlug:profile.slug});
  assert.equal(collect.jobType,'collect');
  return {submission,input:{jobId:collect.jobId,workerId,runKey:collect.runKey,result:resultFor(profile)}};
}

async function readResult(db, submission) {
  const {rows:[row]}=await db.query(`SELECT final.writing_score::float AS score,run.task_number,
    run.result_json,job.status,job.attempt_count
    FROM assessment.term_test_writing_grading_final final
    JOIN assessment.term_test_writing_grading_run run ON run.attempt_id=final.attempt_id
    JOIN assessment.term_test_writing_grading_job job ON job.run_id=run.id AND job.job_type='collect'
    WHERE final.attempt_id=$1 AND final.status='ready' `,[submission.attemptToken]);
  return row;
}

async function seedWave(db, service, profile) {
  const submissions=[];
  for(let index=0;index<17;index++){
    const submission=await insertAttempt(db,profile,900001+index);
    await service.ensureSubmission(submission);
    submissions.push(submission);
  }
  // The queue caps outstanding leases. Seed 17 already-issued callbacks to stress their overlap.
  const {rows}=await db.query(`WITH inserted AS (
      INSERT INTO assessment.term_test_writing_grading_job
        (run_id,job_type,idempotency_key,status,worker_id,leased_at,lease_until,attempt_count)
      SELECT id,'collect',run_key||':collect','processing','wave-worker',now(),now()+interval '3 minutes',1
      FROM assessment.term_test_writing_grading_run WHERE attempt_id=ANY($1::uuid[])
      RETURNING id,run_id
    )
    SELECT inserted.id AS job_id,run.run_key,run.attempt_id FROM inserted
    JOIN assessment.term_test_writing_grading_run run ON run.id=inserted.run_id `,
  [submissions.map(item=>item.attemptToken)]);
  assert.equal(rows.length,17);
  return submissions.map(submission=>{
    const row=rows.find(item=>item.attempt_id===submission.attemptToken);
    return {submission,input:{jobId:row.job_id,workerId:'wave-worker',runKey:row.run_key,result:resultFor(profile)}};
  });
}

function fakeDelivery(profile, loseAck=false) {
  const effective=new Map();
  let calls=0;
  const syncErpGrades=async payload=>{
    calls+=1;
    assert.equal(payload.testSlug,profile.slug);
    assert.equal(payload.grades.writing,6);
    assert.ok(!profile.homework);
    const key=payload.attemptToken;
    if(effective.has(key)) assert.deepEqual(effective.get(key),payload);
    else effective.set(key,payload);
    if(loseAck&&calls===1) throw Object.assign(new Error('Synthetic acknowledgement lost'),{code:'TEST_ACK_LOST'});
    return {status:'synced'};
  };
  return {syncErpGrades,effective,calls:()=>calls};
}

for(const profile of profiles){
  test(profile.slug+' rejects a callback with an expired lease before reclaim',{timeout:35_000},async t=>{
    const {db,pool}=await setup(t,profile);
    const delivery=fakeDelivery(profile);
    const service=createTermTestWritingGradingService({pool,syncErpGrades:delivery.syncErpGrades});
    const {input,submission}=await startCollect(db,service,profile,900001,'first-worker');
    await db.query(`UPDATE assessment.term_test_writing_grading_job
      SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1 `,[input.jobId]);
    const [prior]=await Promise.allSettled([service.completeResult(input)]);
    const actual=prior.status==='rejected'?prior.reason.code??prior.reason.message:prior.value.status;
    t.diagnostic(JSON.stringify({slug:profile.slug,task:profile.task,expiredCallback:actual,
      wroteResult:Boolean(await readResult(db,submission)),portalCalls:delivery.calls()}));
    assert.equal(actual,'WRITING_GRADING_JOB_LEASE_MISMATCH');
    assert.equal(await readResult(db,submission),undefined);
    assert.equal(delivery.calls(),0);
    const [reclaimed]=await service.claimJobs({workerId:'new-worker',limit:1,testSlug:profile.slug});
    assert.equal(reclaimed.jobId,input.jobId);
    await assert.rejects(service.completeResult(input),{code:'WRITING_GRADING_JOB_LEASE_MISMATCH'});
    const fresh={...input,workerId:'new-worker'};
    assert.equal((await service.completeResult(fresh)).status,'accepted');
    assert.equal((await service.completeResult(fresh)).status,'duplicate');
    const row=await readResult(db,submission);
    assert.equal(row.task_number,profile.task);
    assert.equal(row.score,profile.homework?null:6);
    assert.equal(row.result_json.lmsUrl,profile.homework?homeworkUrl:undefined);
    assert.equal(row.status,'complete');
    assert.equal(delivery.calls(),profile.homework?0:1);
  });
  test(profile.slug+' fail, reclaim and duplicate preserve destination',{timeout:35_000},async t=>{
    const {db,pool}=await setup(t,profile);
    const delivery=fakeDelivery(profile,true);
    const service=createTermTestWritingGradingService({pool,syncErpGrades:delivery.syncErpGrades});
    const {input,submission}=await startCollect(db,service,profile,900001,'collect-one');
    const failure=await service.failJob({...input,errorCode:'TEST_NO_REPLY'});
    assert.equal(failure.status,'retry_wait');
    await db.query(`UPDATE assessment.term_test_writing_grading_job SET next_attempt_at=now() WHERE id=$1 `,[input.jobId]);
    const [next]=await service.claimJobs({workerId:'collect-two',limit:1,testSlug:profile.slug});
    assert.equal(next.jobId,input.jobId);
    await assert.rejects(service.completeResult(input),{code:'WRITING_GRADING_JOB_LEASE_MISMATCH'});
    const current={...input,workerId:'collect-two'};
    const accepted=await service.completeResult(current);
    assert.equal(accepted.portalSyncStatus,profile.homework?'not_applicable':'unknown');
    assert.equal((await service.completeResult({...current,result:resultFor(profile,8)})).status,'duplicate');
    const row=await readResult(db,submission);
    assert.equal(row.score,profile.homework?null:6);
    assert.equal(row.result_json.lmsUrl,profile.homework?homeworkUrl:undefined);
    assert.equal(row.attempt_count,2);
    assert.equal(delivery.calls(),profile.homework?0:1);
  });
  for(const wave of [1,2,3]){
    test(profile.slug+' wave '+wave+' re-enqueues and collects 17 essays with duplicate callbacks',{timeout:55_000},async t=>{
      const {db,pool}=await setup(t,profile);
      const delivery=fakeDelivery(profile);
      const service=createTermTestWritingGradingService({pool,syncErpGrades:delivery.syncErpGrades});
      const jobs=await seedWave(db,service,profile);
      const started=performance.now();
      const latencies=[];
      const outcomes=await Promise.allSettled(jobs.flatMap(({input,submission},index)=>{
        const complete=async()=>{
          const began=performance.now();
          try { return await service.completeResult(input); }
          finally { latencies.push(performance.now()-began); }
        };
        const enqueue=()=>service.ensureSubmission(submission);
        const sequence=wave===1?[enqueue,complete,complete]:wave===2?[complete,complete,enqueue]:
          index%2?[complete,enqueue,complete]:[enqueue,complete,complete];
        return sequence.map(call=>call());
      }));
      const errors=outcomes.filter(row=>row.status==='rejected')
        .map(row=>({code:row.reason.code,message:row.reason.message}));
      const ordered=latencies.sort((a,b)=>a-b);
      const counts=[];
      for(const {submission} of jobs)counts.push(await readResult(db,submission));
      t.diagnostic(JSON.stringify({slug:profile.slug,wave,attempts:17,finals:counts.filter(Boolean).length,
        callbackErrors:errors,portalCalls:delivery.calls(),effectivePortalWrites:delivery.effective.size,
        p95Ms:Math.round(ordered[Math.ceil(ordered.length*.95)-1]),totalMs:Math.round(performance.now()-started)}));
      assert.deepEqual(errors,[]);
      for(const row of counts){
        assert.equal(row.status,'complete');
        assert.equal(row.task_number,profile.task);
        assert.equal(row.score,profile.homework?null:6);
        assert.equal(row.result_json.lmsUrl,profile.homework?homeworkUrl:undefined);
      }
      assert.equal(delivery.effective.size,profile.homework?0:17);
    });
  }
  test(profile.slug+' native Hub queue keeps at most one destination event per attempt',{timeout:55_000},async t=>{
    const {db,pool}=await setup(t,profile);
    const syncErpGrades=createExamPublisher({pool,family:'k56',cutoverAt:'2026-11-01T00:00:00Z'});
    const service=createTermTestWritingGradingService({pool,syncErpGrades});
    const jobs=await seedWave(db,service,profile);
    const sent=await Promise.allSettled(jobs.flatMap(({input,submission})=>[
      service.ensureSubmission(submission),service.completeResult(input),service.completeResult(input),
    ]));
    assert.deepEqual(sent.filter(row=>row.status==='rejected').map(row=>row.reason.code??row.reason.message),[]);
    const {rows}=await db.query('SELECT attempt_id,field,hub_payload,state FROM portal_exam.source_event ORDER BY attempt_id');
    assert.equal(rows.length,profile.homework?0:17);
    for(const row of rows){
      const exact=jobs.find(job=>job.submission.attemptToken===row.attempt_id);
      assert.ok(exact);
      assert.equal(row.field,'writing');
      assert.equal(row.state,'queued');
      assert.equal(row.hub_payload.value,6);
      assert.equal(row.hub_payload.targetName,'Term Test '+profile.slug.split('-')[2]+' Writing');
    }
    assert.equal(new Set(rows.map(row=>row.attempt_id)).size,rows.length);
    t.diagnostic(JSON.stringify({slug:profile.slug,hubEventCount:rows.length,externalPortalWrites:0}));
  });
}
