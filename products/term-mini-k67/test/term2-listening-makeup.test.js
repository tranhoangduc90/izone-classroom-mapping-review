import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import request from 'supertest';
import { createMiniFixture } from './helpers/mini-answer-sheet-fixture.js';
import { startTerm1TimerSweep } from '../src/term1-listening-timer.js';
import { gradeSection } from '../src/term-tests.js';

const base = '/api/term-tests/term-test-2';
const studentRef = '11111111-1111-4111-8111-111111111111';
const identity = { classCode: 'IC2262', studentRef, deviceProof: 'b'.repeat(64) };
const questions = Array.from({ length: 40 }, (_, i) => ({ number: i + 1, type: 'Fixture', accepted: ['A'] }));
const section = { questions };
const answers = Object.fromEntries(questions.slice(0, 30).map(q => [q.number, 'A']));
const assets = {
  supports: () => true,
  getSessionAudioKey: () => Buffer.alloc(32),
  getContent: () => ({ title: 'Fixture', variant: 'semantic-html', listening: { sections: [] }, reading: { sections: [] } }),
  getTiming: () => ({ listeningTotalSeconds: 2 })
};

for (const automatic of [false, true]) {
  test('Term 2 makeup uses original attempt and only records Listening (' + (automatic ? 'closed tab' : 'manual') + ')',
    { skip: !process.env.K67_ORDER_NATIVE_URL }, async t => {
    const attempt = randomUUID();
    const { app, db, pool } = await createMiniFixture({ assets, examOrder: true, term2CbtJourneyMode: 'on',
      term2ListeningMakeupAttempt: attempt });
    t.after(() => db.close());
    await db.exec("UPDATE mapping.classroom_course_mapping SET erp_class_name_snapshot='IC2262' WHERE erp_course_class_id=1293");
    await db.query("INSERT INTO assessment.test_definition(slug,title,version,listening_definition,reading_definition,is_active) VALUES('term-test-2','Fixture',1,$1,$1,true)",[JSON.stringify(section)]);
    const session = (await db.query("INSERT INTO assessment.term_test_exam_session(test_slug,definition_version,erp_course_class_id,class_name_snapshot,erp_student_contact_id,student_name_snapshot) VALUES('term-test-2',1,1293,'IC2262',900001,'Fixture') RETURNING id")).rows[0].id;
    await db.query(`INSERT INTO assessment.term_test_attempt(id,client_submission_id,test_slug,definition_version,erp_course_class_id,
      class_name_snapshot,erp_student_contact_id,student_name_snapshot,exam_session_id,exam_delivery,
      reading_answers,reading_result,reading_submitted_at,combined_result,completed_at,listening_interrupted_at)
      VALUES($1,$1,'term-test-2',1,1293,'IC2262',900001,'Fixture',$2,'cbt',$3,$4,now(),
      '{"listening":null,"listeningStatus":"interrupted"}',now(),now())`, [attempt,session,JSON.stringify(answers), JSON.stringify(gradeSection(section,answers))]);
    await db.query('UPDATE assessment.term_test_exam_session SET attempt_id=$2 WHERE id=$1',[session,attempt]);
    const api = request(app);
    const post = (action, body) => api.post(base + '/listening-timer/' + action).send(body);
    assert.equal((await post('prepare',identity)).body.error,'MAKEUP_WAITING_WRITING');
    await db.query(`UPDATE assessment.term_test_attempt SET writing_started_at=now(),writing_updated_at=now(),
      writing_submitted_at=now(),writing_task_1='Fixture Writing' WHERE id=$1`,[attempt]);
    await db.query(`INSERT INTO assessment.term_k67_cbt_journey(session_id,generation,student_ref,device_hash,activated_at,audio_hash,sections)
      VALUES($1,0,$2,$3,now(),$3,'{"listening":{"status":"interrupted"},"reading":{},"writing":{}}')`,[session,studentRef,'a'.repeat(64)]);
    const preservedSql = `SELECT a.reading_answers,a.reading_result,a.reading_submitted_at,a.writing_task_1,a.writing_submitted_at,
      to_jsonb(s) AS session,j.sections
      FROM assessment.term_test_attempt a JOIN assessment.term_test_exam_session s ON s.id=a.exam_session_id
      JOIN assessment.term_k67_cbt_journey j ON j.session_id=s.id WHERE a.id=$1`;
    const original = (await db.query(preservedSql,[attempt])).rows[0];
    const portal = process.env.TERM1_TIMER_PORTAL_SOURCE;
    const cutoverAt = new Date(Date.now()-60_000).toISOString();
    if (portal) {
      const sql = file => readFile(join(portal,'client',file),'utf8');
      await db.exec(await sql('exam-source.sql'));
      await db.exec(await sql('k67-attempt-roster.sql'));
      await db.exec((await sql('exam-capture.sql')).replaceAll('__NATIVE_SCHEMA__','assessment').replace('__WRITING_SCOPE_GUARD__',''));
      await db.query('UPDATE portal_exam.capture_control SET enabled=true,writes_enabled=true,cutover_at=$1 WHERE id=1',[cutoverAt]);
      await db.query('UPDATE portal_exam.k67_class_roster_control SET enrolled_from=$1 WHERE id=1',[cutoverAt]);
      await db.exec('GRANT USAGE ON SCHEMA portal_exam TO k67_app; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA portal_exam TO k67_app');
    }
    const ok = async (action, body) => {
      const response = await post(action,body);
      assert.ok(response.ok,response.text);
      return response.body;
    };
    const rejected = await post('prepare',{...identity,studentRef:'44444444-4444-4444-8444-444444444444'});
    assert.equal(rejected.body.error,'MAKEUP_NOT_ALLOWED');
    const prepared = await ok('prepare',identity);
    assert.equal(prepared.listeningDeadlineAt,null);
    assert.equal(prepared.attemptToken,null);
    const scope = {...identity,examSessionToken:prepared.examSessionToken,generation:prepared.generation};
    const started = await ok('start',scope);
    assert.equal(started.content.reading,undefined);
    assert.equal(started.audioKey,undefined);
    assert.equal(Date.parse(started.listeningDeadlineAt)-Date.parse(started.listeningStartedAt),2000);
    assert.equal((await ok('start',scope)).listeningDeadlineAt,started.listeningDeadlineAt);
    assert.equal((await ok('draft',{...scope,answers,revision:1})).accepted,true);
    if (automatic) {
      const errors = [];
      const stop = startTerm1TimerSweep(app.locals.closeExpiredTerm2Makeups,error=>errors.push(error));
      try {
        await sleep(Math.max(0,Date.parse(started.listeningDeadlineAt)-Date.now())+750);
      } finally { await stop(); }
      assert.deepEqual(errors,[]);
      assert.equal((await ok('status',scope)).attemptToken,attempt);
    } else {
      assert.equal((await ok('submit',{...scope,answers,revision:2})).attemptToken,attempt);
    }
    assert.equal((await ok('submit',{...scope,answers:{},revision:3})).attemptToken,attempt);
    const result = (await db.query("SELECT id,listening_answers,listening_result->>'band' AS band FROM assessment.term_test_attempt")).rows;
    assert.deepEqual(result,[{id:attempt,listening_answers:answers,band:'7'}]);
    assert.deepEqual((await db.query(preservedSql,[attempt])).rows[0],original);
    if (portal) {
      const { drainExamNative } = await import(pathToFileURL(join(portal,'client/exam-source.mjs')));
      assert.equal(await drainExamNative(pool,{family:'k67',cutoverAt}),1);
      const {hub_payload:payload} = (await db.query('SELECT hub_payload FROM portal_exam.source_event')).rows[0];
      assert.deepEqual([payload.classId,payload.studentId,payload.targetName,payload.value],['1293','900001','Phase 2 Listening',7]);
      const { inspectPortal, verifyPortal } = await import(pathToFileURL(join(portal,'src/legacy.mjs')));
      const snapshot = { course_class_id:1293, class_registrations:[{contact:{id:900001},class_registration:{id:900101,course_class_id:1293}}],
        class_tests:['Phase 1 Listening','Phase 2 Listening','Phase 2 Reading','Phase 2 Writing'].map((name,i)=>({id:i+40,name,max_grade:9})),
        student_test_grades:[] };
      const before = inspectPortal(payload,snapshot);
      assert.equal(before.body.class_test_id,41);
      const stored = {...before.body,meta:{records:[{id:52,grade:before.body.grade}]}};
      assert.equal(verifyPortal(payload,{...snapshot,student_test_grades:[stored]},before.snapshot).confirmed,true);
    }
  });
}
