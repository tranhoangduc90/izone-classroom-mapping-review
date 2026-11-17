import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import request from 'supertest';
import { createMiniFixture } from './helpers/mini-answer-sheet-fixture.js';
import { createTermTestWritingGradingService } from '../src/term-test-writing-grading.js';

const migration = new URL('../db/045-term2-cbt-parallel-entry.sql', import.meta.url);
const options = { examOrder: true, completeSchema: true, term1ParallelEntryEnabled: true, term2CbtJourneyMode: 'on' };
const legacyStudent = 900001;
const newStudent = 900002;

async function seed(db) {
  await db.query(`INSERT INTO assessment.test_definition
    (slug,title,version,listening_definition,reading_definition,is_active)
    SELECT 'term-test-2','Fixture Term 2',1,listening_definition,reading_definition,true
    FROM assessment.test_definition WHERE slug='mini-test-lesson-5'`);
}

async function createDraft(db, student, order) {
  const { rows: [session] } = await db.query(`INSERT INTO assessment.term_test_exam_session
    (test_slug,definition_version,erp_course_class_id,erp_student_contact_id,class_name_snapshot,
      student_name_snapshot,attempt_mode,exam_mode,term2_parallel_entry)
    VALUES('term-test-2',1,1293,$1,'IC2304','Fixture','cbt',$2,true) RETURNING id`, [student, order]);
  if (order === 'lis_first') return { sessionId: session.id, id: null };
  const { rows: [attempt] } = await db.query(`INSERT INTO assessment.term_test_attempt
    (client_submission_id,test_slug,definition_version,erp_course_class_id,erp_student_contact_id,
      class_name_snapshot,student_name_snapshot,exam_session_id,attempt_mode,exam_mode,exam_delivery)
    VALUES($1,'term-test-2',1,1293,$2,'IC2304','Fixture',$3,'cbt',$4,'cbt') RETURNING id,term2_parallel_entry`,
  [randomUUID(), student, session.id, order]);
  assert.equal(attempt.term2_parallel_entry, true);
  return { sessionId: session.id, id: attempt.id };
}

async function listening(db, attempt) {
  if (!attempt.id) {
    const { rows: [written] } = await db.query(`INSERT INTO assessment.term_test_attempt
      (client_submission_id,test_slug,definition_version,erp_course_class_id,erp_student_contact_id,
        class_name_snapshot,student_name_snapshot,exam_session_id,attempt_mode,exam_mode,exam_delivery,
        listening_submitted_at,listening_answers,listening_result)
      SELECT $1,test_slug,definition_version,erp_course_class_id,erp_student_contact_id,
        class_name_snapshot,student_name_snapshot,id,'cbt','lis_first','cbt',now(),'{"11":"B"}','{"score":0}'
      FROM assessment.term_test_exam_session WHERE id=$2 RETURNING id,term2_parallel_entry`, [randomUUID(), attempt.sessionId]);
    assert.equal(written.term2_parallel_entry, true);
    return written.id;
  }
  await db.query(`UPDATE assessment.term_test_attempt SET
    listening_submitted_at=statement_timestamp(),listening_answers='{"11":"B"}',listening_result='{"score":0}',
    completed_at=CASE WHEN reading_submitted_at IS NOT NULL THEN statement_timestamp() END,
    combined_result=CASE WHEN reading_submitted_at IS NOT NULL THEN '{"score":1}'::jsonb END
    WHERE id=$1`, [attempt.id]);
}

function reading(db, attempt) {
  return db.query(`UPDATE assessment.term_test_attempt SET reading_submitted_at=statement_timestamp(),
    reading_answers='{"14":"A"}',reading_result='{"score":1}',
    completed_at=CASE WHEN listening_submitted_at IS NOT NULL THEN statement_timestamp() END,
    combined_result=CASE WHEN listening_submitted_at IS NOT NULL THEN '{"score":1}'::jsonb END
    WHERE id=$1`, [attempt.id]);
}

async function submitted(db, student) {
  const { rows } = await db.query(`SELECT id,listening_answers,listening_result,reading_answers,
    term2_first_submission_guard AS guarded FROM assessment.term_test_attempt
    WHERE test_slug='term-test-2' AND erp_student_contact_id=$1 AND superseded_at IS NULL
      AND (listening_submitted_at IS NOT NULL OR reading_submitted_at IS NOT NULL) ORDER BY id`, [student]);
  return rows;
}

test('Term 2 parallel drafts do not reserve official submissions and historical answers stay intact', async () => {
  const { db, pool } = await createMiniFixture(options);
  try {
    await seed(db);
    const { rows } = await db.query(`INSERT INTO assessment.term_test_attempt
      (client_submission_id,test_slug,definition_version,erp_course_class_id,erp_student_contact_id,
        class_name_snapshot,student_name_snapshot,exam_mode,exam_delivery,completed_at,combined_result,
        listening_submitted_at,listening_answers,listening_result,reading_submitted_at,reading_answers,reading_result)
      VALUES($1,'term-test-2',1,1293,$2,'IC2304','Fixture','lis_first','cbt',now(),'{"score":0}',
        now(),'{"11":"B"}','{"score":0}',now(),'{"14":"B"}','{"score":0}') RETURNING id`, [randomUUID(), legacyStudent]);
    await db.exec(await readFile(migration, 'utf8'));
    const historical = await submitted(db, legacyStudent);
    assert.equal(historical[0].id, rows[0].id);
    assert.equal(historical[0].guarded, false);
    const historicalCompetitor = await createDraft(pool, legacyStudent, 'lis_first');
    await assert.rejects(listening(pool, historicalCompetitor), { code: 'P6751' });
    await assert.rejects(pool.query(`UPDATE assessment.term_test_attempt SET listening_answers='{"11":"A"}'
      WHERE id=$1`, [rows[0].id]), { code: 'P6752' });
    assert.deepEqual(await submitted(db, legacyStudent), historical);

    const a = await createDraft(pool, newStudent, 'lis_first');
    const b = await createDraft(pool, newStudent, 'read_first');
    const rolledBack = await pool.connect();
    try {
      await rolledBack.query('BEGIN');
      await listening(rolledBack, a);
      await rolledBack.query('ROLLBACK');
    } finally { rolledBack.release(); }
    assert.deepEqual(await submitted(db, newStudent), []);
    await reading(pool, b);
    await assert.rejects(listening(pool, a), { code: 'P6751' });
    const [winner] = await submitted(db, newStudent);
    assert.deepEqual(winner, { id:b.id,listening_answers:null,listening_result:null,reading_answers:{14:'A'},guarded:true });
    await assert.rejects(pool.query(`UPDATE assessment.term_test_attempt SET reading_answers='{"14":"B"}' WHERE id=$1`, [b.id]),
      { code: 'P6752' });
    await listening(pool, b);
    assert.deepEqual((await submitted(db, newStudent)).map(row => row.id), [b.id]);
  } finally { await db.close(); }
});

test('Term 2 competing Listening and Reading writers are serialized by the official index', {
  skip: !process.env.K67_ORDER_NATIVE_URL,
}, async () => {
  const { db, pool } = await createMiniFixture(options);
  let first;
  let second;
  let competing;
  try {
    await seed(db);
    await db.exec(await readFile(migration, 'utf8'));
    const a = await createDraft(pool, newStudent, 'lis_first');
    const b = await createDraft(pool, newStudent, 'read_first');
    first = await pool.connect();
    second = await pool.connect();
    const { rows: [{ pid }] } = await second.query('SELECT pg_backend_pid() AS pid');
    await first.query('BEGIN');
    await second.query('BEGIN');
    await second.query("SET LOCAL statement_timeout = '6s'");
    const winner = await listening(first, a);
    competing = reading(second, b).then(() => ({ accepted: true }), error => ({ error }));
    let overlaps = false;
    for (let i = 0; i < 40 && !overlaps; i++) {
      const { rows: [observed] } = await db.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [pid]);
      overlaps = observed?.wait_event_type === 'Lock';
      if (!overlaps) await delay(50);
    }
    assert.ok(overlaps, 'the two submissions must overlap before the winning transaction commits');
    await first.query('COMMIT');
    const { error } = await competing;
    assert.equal(error?.code, '23505');
    assert.equal(error.constraint, 'uq_term2_new_official_attempt');
    await second.query('ROLLBACK');
    assert.deepEqual(await submitted(db, newStudent), [
      { id:winner,listening_answers:{11:'B'},listening_result:{score:0},reading_answers:null,guarded:true },
    ]);
  } finally {
    if (first) { await first.query('ROLLBACK'); first.release(); }
    if (second) { await competing; await second.query('ROLLBACK'); second.release(); }
    await db.close();
  }
});

for (const firstSkill of ['listening','reading']) test(`Term 2 ${firstSkill} first: the competing profile completes the official attempt`, async () => {
  let grading;
  const deliveries=[];
  const { db, app, pool } = await createMiniFixture({ ...options, term2ParallelEntryMode:'on',
    termTestWritingGradingService:{
      ensureSubmission:input=>grading.ensureSubmission(input),
      ensureSubmissionInTransaction:(db,input)=>grading.ensureSubmissionInTransaction(db,input),
      getStatus:id=>grading.getStatus(id),
    }, assets: {
    supports: () => true,
    getContent: () => ({ title:'Fixture', writing:{ tasks:[{id:'task1'},{id:'task2'}] } }),
    getTiming: () => ({ readingDurationMinutes:1, listeningDurationSeconds:1844,
      listeningTotalSeconds:1964, listeningReviewSeconds:120, writingDurationMinutes:1 }),
    getSessionAudioKey: () => Buffer.alloc(32),
  } });
  const root = '/api/term-tests/term-test-2';
  const identity = { classCode:'IC2304', studentRef:'11111111-1111-4111-8111-111111111111',
    examDelivery:'cbt', orderClientVersion:1, term2ContinuationVersion:1 };
  try {
    grading=createTermTestWritingGradingService({pool,syncErpGrades:async payload=>{
      deliveries.push(payload);
      return {status:'synced'};
    }});
    await seed(db);
    async function openProfile(examMode, deviceProof, api=request.agent(app), previous={}) {
      const prepared = await api.post(root+'/session/prepare').send({ ...identity, examMode, ...previous });
      assert.equal(prepared.status,200,prepared.text);
      assert.equal(prepared.body.term2ParallelEntry,true);
      const scope = { examSessionToken:prepared.body.examSessionToken, generation:0, deviceProof };
      const offer = await api.post(root+'/cbt-journey/prepare').send({ ...identity, ...scope });
      assert.ok(offer.ok,offer.text);
      const post = (action, body={}) => api.post(root+'/cbt-journey/'+action).set('x-term2-permit',offer.body.permit)
        .send({ ...scope, ...body });
      const began = await post('begin');
      assert.ok(began.ok,began.text);
      return { api, scope, post, prepared:prepared.body, offer:offer.body };
    }
    const a = await openProfile('lis_first','a'.repeat(64));
    const b = await openProfile('read_first','b'.repeat(64));
    assert.notEqual(a.scope.examSessionToken,b.scope.examSessionToken);
    const hasOtherProof = await a.post('begin',{ deviceProof:b.scope.deviceProof });
    assert.equal(hasOtherProof.status,403);
    assert.deepEqual(await submitted(db,legacyStudent),[]);

    const startedAt = Date.now()-40*60_000;
    await db.query(`UPDATE assessment.term_k67_cbt_journey SET activated_at=$1 WHERE session_id IN ($2,$3)`,
      [new Date(startedAt).toISOString(),a.scope.examSessionToken,b.scope.examSessionToken]);
    const firstListening = { section:'listening', operationId:randomUUID(), previousOperationId:null, startedAt,
      capturedAt:startedAt+1_963_200, revision:1, automatic:true, eofAt:startedAt+1_843_200, heardSeconds:1843.2,
      answers:{11:'B'} };
    const firstReading = { section:'reading', operationId:randomUUID(), previousOperationId:null, startedAt,
      capturedAt:startedAt+2_000, revision:1, automatic:false, eofAt:null, heardSeconds:0, answers:{14:'A'} };
    const listeningProfile={...a,body:firstListening};
    const readingProfile={...b,body:firstReading};
    const [winner,loser]=firstSkill==='listening'?[listeningProfile,readingProfile]:[readingProfile,listeningProfile];
    const first=await winner.post('seal',winner.body);
    assert.ok(first.ok,first.text);
    const rejected=await loser.post('seal',loser.body);
    assert.equal(rejected.status,409,rejected.text);
    assert.equal(rejected.body.error,'EXAM_FIRST_SUBMISSION_ACCEPTED');
    const receipt = first.body.receipt;
    assert.ok(receipt.receiptId);
    assert.equal(receipt.operationId,winner.body.operationId);
    assert.deepEqual((await winner.post('seal',winner.body)).body.receipt,receipt);
    const [official] = await submitted(db,legacyStudent);
    assert.equal(official.id,receipt.attemptToken);
    assert.deepEqual(await submitted(db,legacyStudent),[official]);
    assert.deepEqual(official.listening_answers,winner.body.section==='listening'?winner.body.answers:null);
    assert.deepEqual(official.reading_answers,winner.body.section==='reading'?winner.body.answers:null);
    const progress = await openProfile(loser.body.section==='listening'?'lis_first':'read_first',
      loser.scope.deviceProof,loser.api,{examSessionToken:loser.scope.examSessionToken});
    assert.equal(progress.prepared.nextSection,loser.body.section);
    assert.equal(progress.prepared.listeningSubmitted,winner.body.section==='listening');
    assert.equal(progress.prepared.readingSubmitted,winner.body.section==='reading');
    assert.notEqual(progress.prepared.attemptToken,official.id,'a new profile must not get the winning profile’s write token');
    assert.equal(progress.scope.examSessionToken,loser.scope.examSessionToken);
    assert.equal(progress.offer.continuationSection,loser.body.section);
    const remainingBody={...loser.body,operationId:randomUUID()};
    const remaining=await progress.post('seal',remainingBody);
    assert.ok(remaining.ok,remaining.text);
    assert.equal(remaining.body.receipt.nextSection,'writing');
    assert.deepEqual((await progress.post('seal',remainingBody)).body.receipt,remaining.body.receipt);
    const bothSkills=await submitted(db,legacyStudent);
    assert.deepEqual(bothSkills.map(row=>row.id),[official.id]);
    assert.deepEqual(bothSkills[0].listening_answers,firstListening.answers);
    assert.deepEqual(bothSkills[0].reading_answers,firstReading.answers);

    const writing = await openProfile('lis_first','c'.repeat(64),winner.api,{examSessionToken:winner.scope.examSessionToken});
    assert.equal(writing.offer.continuationSection,'writing');
    assert.notEqual(writing.scope.examSessionToken,winner.scope.examSessionToken);
    const writingStart=Date.now()-12_000;
    await db.query('UPDATE assessment.term_k67_cbt_journey SET activated_at=$2 WHERE session_id=$1',
      [writing.scope.examSessionToken,new Date(writingStart).toISOString()]);
    const essay={section:'writing',operationId:randomUUID(),previousOperationId:null,startedAt:writingStart,
      capturedAt:writingStart+2000,revision:1,automatic:false,eofAt:null,heardSeconds:0,
      answers:{task1:'Synthetic report',task2:'Synthetic essay'}};
    const wrote=await writing.post('seal',essay);
    assert.ok(wrote.ok,wrote.text);
    assert.equal(wrote.body.receipt.completed,true);
    assert.deepEqual((await writing.post('seal',essay)).body.receipt,wrote.body.receipt);
    const stored=(await db.query(`SELECT writing_submitted_at,writing_task_1,writing_task_2
      FROM assessment.term_test_attempt WHERE id=$1`,[official.id])).rows[0];
    assert.ok(stored.writing_submitted_at);
    assert.deepEqual([stored.writing_task_1,stored.writing_task_2],Object.values(essay.answers));
    const jobs=(await db.query(`SELECT run.task_number,run.essay_text,job.job_type FROM assessment.term_test_writing_grading_run AS run
      JOIN assessment.term_test_writing_grading_job AS job ON job.run_id=run.id
      WHERE run.attempt_id=$1 ORDER BY run.task_number`,[official.id])).rows;
    assert.deepEqual(jobs,[{task_number:1,essay_text:essay.answers.task1,job_type:'dispatch'},
      {task_number:2,essay_text:essay.answers.task2,job_type:'dispatch'}]);
    const resultIdentity={classCode:identity.classCode,studentRef:identity.studentRef};
    const readResult=payload=>loser.api.post('/api/term-tests/result').send(payload);
    const officialResult=await readResult({officialTerm2:resultIdentity,includeContent:true});
    assert.ok(officialResult.ok,officialResult.text);
    assert.equal(officialResult.body.officialTerm2,true);
    assert.equal(officialResult.body.testSlug,'term-test-2');
    assert.equal(officialResult.body.attemptToken,undefined);
    assert.equal(officialResult.body.writing.task1,essay.answers.task1);
    assert.equal(officialResult.body.writing.task2,essay.answers.task2);
    assert.equal(officialResult.body.writing.grading.ready,false);
    assert.equal((await readResult({officialTerm2:{...resultIdentity,classCode:'BADCLASS'}})).status,404);
    assert.equal((await readResult({officialTerm1:resultIdentity,officialTerm2:resultIdentity})).status,400);
    assert.equal((await db.query(`SELECT count(*)::int AS total FROM assessment.term_test_writing_grading_job`)).rows[0].total,2);
    assert.deepEqual(deliveries,[]);

    const workerId='term2-fixture-grader';
    const dispatch=await grading.claimJobs({workerId});
    assert.equal(dispatch.length,2);
    for (const job of dispatch) await grading.completeDispatch({workerId,jobId:job.jobId});
    await db.query("UPDATE assessment.term_test_writing_grading_job SET next_attempt_at=now() WHERE job_type='collect'");
    const collect=await grading.claimJobs({workerId});
    assert.equal(collect.length,2);
    for (const job of collect) {
      const bandScore=job.taskNumber===1?5:7;
      const criteria=[job.taskNumber===1?'TA':'TR','CC','LR','GRA']
        .map(code=>({code,bandScore,feedback:'Synthetic feedback'}));
      await grading.completeResult({workerId,jobId:job.jobId,runKey:job.runKey,result:{taskScore:bandScore,criteria}});
    }
    const graded=await readResult({officialTerm2:resultIdentity});
    assert.equal(graded.body.writing.grading.writingScore,6.5);
    assert.deepEqual(deliveries.map(({attemptToken,grades})=>[attemptToken,grades.writing]),[[official.id,6.5]]);
    assert.deepEqual((await writing.post('seal',essay)).body.receipt,wrote.body.receipt);
  } finally { await db.close(); }
});
