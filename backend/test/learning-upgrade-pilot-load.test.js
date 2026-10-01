// Lớp và học viên giả trong PGlite: đo API nộp của 20 người, tổng hợp 20 × 31 ô.
// Đọc lại bài/điểm danh/hàng chờ để kiểm retry; không gọi Portal hoặc dịch vụ ngoài.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';
import {PGlite} from '@electric-sql/pglite';
import {readFile} from 'node:fs/promises';
import {initializeLearningDemoDatabase,createPGlitePool} from '../src/learning-demo.js';
import {createLearningService} from '../src/learning-service.js';
import {createLearningRouter} from '../src/learning-routes.js';
import {fetchCourseOverviewSql} from '../src/learning-course-overview.js';
import {fetchQuestionAnalyticsSql} from '../src/learning-question-analytics.js';
import {percentile} from '../scripts/learning-load-benchmark.mjs';

test('Pilot: 20 người nộp/retry dưới 60 giây, 620 ô overview và aggregate p95 dưới 2 giây',{timeout:60000},async()=>{
  const database=new PGlite();
  try {
    await initializeLearningDemoDatabase(database);
    await database.exec(await readFile(new URL('../ops/learning-migrations/202610010001_progress_log_form_drafts.sql',import.meta.url),'utf8'));
    await database.exec(`INSERT INTO mapping.classroom_course_mapping VALUES(1294,'Lớp tải giả','approved',NULL,NULL);
      INSERT INTO mapping.reviewer_account VALUES('teacher@example.test','active');
      INSERT INTO mapping.reviewer_class_access VALUES('teacher@example.test',1294);
      INSERT INTO mapping.student_mapping_review(erp_course_class_id,erp_student_contact_id,erp_student_name_snapshot)
        SELECT 1294,1000+i,'Học viên giả '||i FROM generate_series(1,20) AS i;
      INSERT INTO mapping.erp_class_membership_snapshot SELECT 1294,1000+i FROM generate_series(1,20) AS i;
      INSERT INTO learning.class_journey_plan(erp_course_class_id,total_sessions,revision,confirmed_by_email)
        VALUES(1294,31,1,'teacher@example.test');`);
    const rawPool=createPGlitePool(database),queries=[];
    const pool={...rawPool,async query(sql,params){queries.push(sql);return rawPool.query(sql,params);}};
    const service=createLearningService({pool}),reviewer={email:'teacher@example.test',canAccessAllClasses:false};
    const published=await service.publishReflectionForm({reviewer,title:'Phiếu tải giả',courseCode:'ic23',classId:'1294',sessionNumber:1,
      items:[{libraryItemId:'10000000-0000-4000-8000-000000000001',checkpoint:1,required:true}]});
    await database.query(`INSERT INTO learning.form_assignment(form_version_id,course_code,erp_course_class_id,class_name_snapshot,
      session_number,title,created_by_email) SELECT $1::uuid,'ic23',1294,'Lớp tải giả',i,'Phiếu giả '||i,'teacher@example.test'
      FROM generate_series(2,31) AS i;`,[published.formVersionId]);
    await database.query(`INSERT INTO learning.form_assignment_roster(assignment_id,student_ref,erp_student_contact_id,student_name_snapshot)
      SELECT assignment.id,roster.student_ref,roster.erp_student_contact_id,roster.student_name_snapshot
      FROM learning.form_assignment AS assignment CROSS JOIN learning.form_assignment_roster AS roster
      WHERE assignment.session_number>1 AND roster.assignment_id=$1::uuid;`,[published.assignmentId]);
    const assignment=await service.getPublicAssignment(published.publicToken);
    const app=express();app.use(express.json({limit:'768kb'}));app.use('/api/learning',createLearningRouter({pool,
      authenticate(req,_res,next){req.reviewer=reviewer;next();}}));
    const inputs=await Promise.all(assignment.roster.map(async student=>{
      const opened=await request(app).post('/api/learning/attempts/start').send({publicToken:published.publicToken,
        studentRef:student.studentRef,identityConfirmed:true,clientIdempotencyKey:crypto.randomUUID()}).expect(201);
      return {attemptToken:opened.body.attempt.attemptToken,submissionId:crypto.randomUUID(),definitionHash:published.definitionHash,
        draftRevision:0,responses:Object.fromEntries(assignment.definition.blocks.flatMap(block=>block.items).map(item=>[item.itemVersionId,'Nội dung học viên giả.']))};
    }));
    const started=performance.now();
    const results=await Promise.all(inputs.map(input=>request(app).post('/api/learning/attempts/submit').send(input).expect(200)));
    const submitBatchMs=performance.now()-started;assert.ok(submitBatchMs<60000);
    assert.ok(results.every(result=>result.body.receipt.completeness==='complete'));
    const retries=await Promise.all(inputs.map(input=>request(app).post('/api/learning/attempts/submit').send(input).expect(200)));
    assert.ok(retries.every(result=>result.body.replayed===true));
    const readback=(await database.query(`SELECT (SELECT count(*)::integer FROM learning.submission) AS submissions,
      (SELECT count(*)::integer FROM learning.attendance_record) AS attendance,
      (SELECT count(*)::integer FROM learning.outbox_job WHERE job_type='sync_portal_attendance') AS jobs;`)).rows[0];
    assert.deepEqual(readback,{submissions:20,attendance:20,jobs:20});
    const overviewMs=[],analyticsMs=[];
    for(let i=0;i<20;i++) {
      const before=queries.length,t0=performance.now(),overview=await service.getCourseOverview({classId:'1294',reviewer});
      overviewMs.push(performance.now()-t0);assert.equal(queries.length-before,4);
      assert.equal(overview.students.length,20);assert.equal(overview.sessions.length,31);assert.equal(overview.counts.complete,20);
      assert.equal(overview.students.flatMap(student=>student.cells).length,620);
      const t1=performance.now(),analytics=await service.getQuestionAnalytics({assignmentId:published.assignmentId,reviewer});
      analyticsMs.push(performance.now()-t1);assert.equal(queries.length-before,7);
      assert.equal(analytics.submittedCount,20);assert.equal(analytics.items[0].counts.answered,20);
    }
    assert.ok(percentile(overviewMs,.95)<2000);assert.ok(percentile(analyticsMs,.95)<2000);
    const overviewPlan=await database.query('EXPLAIN (ANALYZE,BUFFERS) '+fetchCourseOverviewSql,['1294']);
    const analyticsPlan=await database.query('EXPLAIN (ANALYZE,BUFFERS) '+fetchQuestionAnalyticsSql,[published.assignmentId]);
    assert.ok(overviewPlan.rows.some(row=>row['QUERY PLAN'].includes('Execution Time')));
    assert.ok(analyticsPlan.rows.some(row=>row['QUERY PLAN'].includes('Execution Time')));
    console.log(JSON.stringify({type:'progress_log_pilot_fixture',students:20,sessions:31,
      submitBatchMs:Math.round(submitBatchMs),overviewQueries:4,analyticsQueries:3,
      overviewP95Ms:Math.round(percentile(overviewMs,.95)),analyticsP95Ms:Math.round(percentile(analyticsMs,.95)),
      readback,environment:'PGlite/local HTTP; không thay SLA production'}));
  } finally {await database.close();}
});
