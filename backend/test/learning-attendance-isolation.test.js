import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {readFile} from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { initializeLearningDemoDatabase, createPGlitePool } from '../src/learning-demo.js';
import { createLearningService } from '../src/learning-service.js';
import { createLearningAttendanceSync } from '../src/learning-attendance-sync.js';
import { claimLearningJobs, processLearningJob } from '../src/learning-outbox.js';

test('một lần ghi Portal chưa rõ kết quả không khóa xác nhận tên, nộp bài hoặc điểm danh của người khác', async () => {
  const db=new PGlite();
  try {
    await initializeLearningDemoDatabase(db);
    await db.exec(await readFile(new URL('../ops/learning-migrations/202610090001_journey_schedule_changes.sql',import.meta.url),'utf8'));
    // PGlite báo số dòng UPDATE qua affectedRows; giữ cùng hợp đồng rowCount của pg.
    const adapter=createPGlitePool(db),result=r=>({...r,rowCount:r.rows?.length||r.affectedRows||r.rowCount||0});
    const pool={query:async(...args)=>result(await adapter.query(...args)),async connect(){const c=await adapter.connect();return {query:async(...args)=>result(await c.query(...args)),release:()=>c.release()};}};
    await db.exec(`INSERT INTO mapping.classroom_course_mapping(erp_course_class_id,erp_class_name_snapshot) VALUES(2139,'Lớp giả');
      INSERT INTO mapping.reviewer_account VALUES('teacher@example.test','active');
      INSERT INTO mapping.reviewer_class_access VALUES('teacher@example.test',2139);`);
    for(let n=1;n<=3;n++){
      await db.query('INSERT INTO mapping.student_mapping_review(erp_course_class_id,erp_student_contact_id,erp_student_name_snapshot) VALUES(2139,$1,$2)',[9000+n,'Học viên giả '+n]);
      await db.query('INSERT INTO mapping.erp_class_membership_snapshot VALUES(2139,$1)',[9000+n]);
    }
    const schedule={sessions:[{erpSessionId:'35817',date:'2026-10-05',startsAt:'2026-10-05 18:30:00',endsAt:'2026-10-05 21:00:00',statusCode:0}]};
    const service=createLearningService({pool,erpScheduleReader:async()=>schedule});
    const published=await service.publishReflectionForm({reviewer:{email:'teacher@example.test',canAccessAllClasses:false},title:'Phiếu giả',courseCode:'course-67',classId:'2139',sessionNumber:3,opensAt:null,closesAt:null,items:[{libraryItemId:'10000000-0000-4000-8000-000000000001',checkpoint:1,required:true}]});
    await db.query(`INSERT INTO learning.class_journey_plan(erp_course_class_id,total_sessions,revision,confirmed_by_email,session_dates) VALUES(2139,3,1,'teacher@example.test',$1::jsonb)`,[JSON.stringify([{sessionNumber:3,date:'2026-10-05',erpSessionId:'35817'}])]);
    const assignment=await service.getPublicAssignment(published.publicToken);
    const start=student=>service.startAttempt({publicToken:published.publicToken,studentRef:student.studentRef,identityConfirmed:true,clientIdempotencyKey:crypto.randomUUID()});
    const submit=attempt=>service.submit({attemptToken:attempt.attemptToken,submissionId:crypto.randomUUID(),definitionHash:published.definitionHash,draftRevision:0,responses:{}});
    const first=await start(assignment.roster[0]);await submit(first);
    const state={commits:0,present:new Set(),timeout:true};
    const fingerprint=JSON.stringify(['2139',[['35817','2026-10-05 18:30:00','2026-10-05 21:00:00',0]]]);
    const fetchImpl=async(_url,options)=>{
      const r=JSON.parse(options.body);let status=state.present.has(r.studentId)?'already_present':'resolved';
      if(r.commit){state.commits++;if(state.timeout){const e=new Error('Kết quả chưa rõ');e.name='TimeoutError';throw e;}state.present.add(r.studentId);status='synced';}
      return {ok:true,json:async()=>({ok:true,status,entityKey:r.entityKey,unitKey:r.unitKey,operationKey:r.operationKey,idempotencyKey:r.idempotencyKey,classId:r.classId,studentId:r.studentId,sessionNumber:r.sessionNumber,targetSessionId:'35817',resolvedSessionId:'35817',bindingRevision:r.bindingRevision??null,scheduleFingerprint:fingerprint,sessionDate:'2026-10-05'})};
    };
    const handler=createLearningAttendanceSync({config:{learningAttendanceSyncUrl:'https://fixture.test/portal',learningAttendanceSyncSecret:'test-only',learningAttendanceSyncTimeoutMs:1000},pool,fetchImpl});
    const run=async workerId=>{
      const [job]=await claimLearningJobs({pool,workerId,limit:1,leaseSeconds:90,jobTypes:['sync_portal_attendance']});assert.ok(job);
      return {job,result:await processLearningJob({pool,workerId,job,handler})};
    };
    const failed=await run('first');assert.equal(failed.result.errorCode,'PORTAL_ATTENDANCE_TIMEOUT');
    await pool.query("UPDATE learning.outbox_job SET next_attempt_at=now()-interval '1 second' WHERE id=$1",[failed.job.id]);
    const retry=await run('retry');
    assert.equal(retry.result.status,'review_required',JSON.stringify(retry.result));assert.equal(state.commits,1);
    const pending=(await pool.query('SELECT status,result_json FROM learning.outbox_job WHERE id=$1',[failed.job.id])).rows[0];
    assert.equal(pending.result_json.reviewReason,'write_outcome_unknown');
    assert.equal((await pool.query('SELECT review_required FROM learning.portal_attendance_binding')).rows[0].review_required,false);
    // Người tiếp theo vẫn xác nhận tên và gửi bài; yêu cầu cũ không bị gửi lặp.
    const second=await start(assignment.roster[1]);await submit(second);state.timeout=false;
    assert.equal((await run('other-student')).result.status,'complete');assert.equal(state.commits,2);
    assert.equal((await pool.query('SELECT status FROM learning.outbox_job WHERE id=$1',[failed.job.id])).rows[0].status,'review_required');
    assert.equal((await pool.query('SELECT count(*)::int n FROM learning.submission')).rows[0].n,2);
    // Cờ đối chiếu lịch/đích thật vẫn chặn, không bỏ toàn bộ cơ chế bảo vệ.
    await pool.query('UPDATE learning.portal_attendance_binding SET review_required=true');
    await assert.rejects(()=>start(assignment.roster[2]),{code:'ERP_SESSION_REVIEW_REQUIRED'});
  } finally {await db.close();}
});
