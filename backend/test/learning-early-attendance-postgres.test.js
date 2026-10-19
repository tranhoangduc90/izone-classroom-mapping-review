// Kiểm hành vi thật qua service và PostgreSQL nhiều connection bằng quyền ứng dụng.
// Chỉ fixture loopback được phép; không gọi Portal hoặc tạo bài của lớp thật.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { postgresFixture, publishedFixture } from './learning-postgres-fixture.js';
import { claimLearningJobs, processLearningJob } from '../src/learning-outbox.js';
import { createLearningAttendanceSync } from '../src/learning-attendance-sync.js';

async function checkpoint(fixture, input, block, key = crypto.randomUUID()) {
  return fixture.service.submitCheckpoint({
    attemptToken: input.attemptToken, checkpointSubmissionId: crypto.randomUUID(),
    blockId: block.blockId, checkpoint: block.checkpoint, draftRevision: 0,
    definitionHash: input.definitionHash, responses: {}, idempotencyKey: key
  });
}

test('E01: nộp phần trống ghi điểm danh trước final bằng quyền ứng dụng; replay và final không nhân tác vụ', async () => {
  const fixture = await postgresFixture({ asApplication: true });
  try {
    const { assignment, inputs } = await publishedFixture(fixture);
    const block = assignment.definition.blocks[0], input = inputs[0], key = crypto.randomUUID();
    const first = await checkpoint(fixture, input, block, key);
    assert.equal(first.attendance?.status, 'self_confirmed');
    assert.equal(first.attendance.portalSyncQueued, true);
    assert.equal(first.completeness, 'incomplete');
    const before = await fixture.pool.query(`SELECT
      (SELECT count(*)::int FROM learning.submission) AS finals,
      (SELECT count(*)::int FROM learning.attendance_record) AS attendance,
      (SELECT count(*)::int FROM learning.attendance_event) AS events,
      (SELECT count(*)::int FROM learning.outbox_job WHERE job_type='sync_portal_attendance') AS jobs`);
    assert.deepEqual(before.rows[0], { finals: 0, attendance: 1, events: 1, jobs: 1 });
    const source = (await fixture.pool.query('SELECT source_checkpoint_submission_id::text AS source FROM learning.attendance_record')).rows[0];
    assert.equal(source.source, first.checkpointSubmissionId);
    const replay = await checkpoint(fixture, input, block, key);
    assert.equal(replay.replayed, true);
    assert.equal(replay.checkpointSubmissionId, first.checkpointSubmissionId);
    assert.equal(replay.attendance.status, 'self_confirmed');
    const reopened = await fixture.service.startAttempt({ publicToken: assignment.publicToken,
      studentRef: assignment.roster[0].studentRef, identityConfirmed: true, clientIdempotencyKey: crypto.randomUUID() });
    assert.equal(reopened.attendance.status, 'self_confirmed');
    const final = await fixture.service.submit({ ...input, responses: {} });
    assert.equal(final.receipt.attendanceStatus, 'self_confirmed');
    assert.equal(final.receipt.completeness, 'incomplete');
    const after = (await fixture.pool.query(`SELECT
      (SELECT count(*)::int FROM learning.attendance_event) AS events,
      (SELECT count(*)::int FROM learning.outbox_job WHERE job_type='sync_portal_attendance') AS jobs`)).rows[0];
    assert.deepEqual(after, { events: 1, jobs: 1 });
  } finally { await fixture.close(); }
});

test('E02: client nộp cuối trực tiếp còn trống vẫn ghi nhận; quyết định giảng viên được giữ', async () => {
  const fixture = await postgresFixture({ asApplication: true });
  try {
    const { assignment, inputs } = await publishedFixture(fixture);
    const final = await fixture.service.submit({ ...inputs[0], responses: {} });
    assert.equal(final.receipt.attendanceStatus, 'self_confirmed');
    await fixture.service.overrideAttendance({ assignmentId: assignment.assignmentId,
      studentRef: assignment.roster[1].studentRef, status: 'not_eligible', reason: 'Điều chỉnh của giảng viên.',
      operationKey: crypto.randomUUID(), reviewer: { email: 'teacher@example.test', canAccessAllClasses: false } });
    const block = assignment.definition.blocks[0];
    const first = await checkpoint(fixture, inputs[1], block);
    assert.equal(first.attendance.status, 'not_eligible');
    const after = await fixture.service.submit({ ...inputs[1], responses: {} });
    assert.equal(after.receipt.attendanceStatus, 'not_eligible');
    const records = (await fixture.pool.query('SELECT status FROM learning.attendance_record ORDER BY student_ref')).rows;
    assert.equal(records.filter(row => row.status === 'not_eligible').length, 1);
    assert.equal((await fixture.pool.query("SELECT count(*)::int AS n FROM learning.outbox_job WHERE job_type='sync_portal_attendance'")).rows[0].n, 1);
  } finally { await fixture.close(); }
});

test('E03: lỗi quyền hàng chờ rollback cả checkpoint và điểm danh; thử lại chỉ ghi một lần', async () => {
  const fixture = await postgresFixture({ asApplication: true });
  try {
    const { assignment, inputs } = await publishedFixture(fixture);
    const block = assignment.definition.blocks[0];
    await fixture.pool.query('REVOKE INSERT ON learning.outbox_job FROM learning_api');
    await assert.rejects(() => checkpoint(fixture, inputs[0], block), error => error.code === '42501');
    const counts = (await fixture.pool.query(`SELECT
      (SELECT count(*)::int FROM learning.checkpoint_submission) AS checkpoints,
      (SELECT count(*)::int FROM learning.attendance_record) AS attendance,
      (SELECT count(*)::int FROM learning.attendance_event) AS events`)).rows[0];
    assert.deepEqual(counts, { checkpoints: 0, attendance: 0, events: 0 });
    await fixture.pool.query('GRANT INSERT ON learning.outbox_job TO learning_api');
    assert.equal((await checkpoint(fixture, inputs[0], block)).attendance.status, 'self_confirmed');
  } finally { await fixture.close(); }
});

test('E04: 20 học viên nộp phần đầu đồng thời, không tạo final hoặc khởi động mốc tự khóa', async () => {
  const fixture = await postgresFixture({ asApplication: true, studentCount: 20 });
  try {
    const { assignment, inputs } = await publishedFixture(fixture);
    const block = assignment.definition.blocks[0];
    const results = await Promise.all(inputs.map(input => checkpoint(fixture, input, block)));
    assert.equal(results.filter(result => result.attendance?.status === 'self_confirmed').length, 20);
    const counts = (await fixture.pool.query(`SELECT
      (SELECT count(*)::int FROM learning.checkpoint_submission) AS checkpoints,
      (SELECT count(*)::int FROM learning.attendance_record) AS attendance,
      (SELECT count(*)::int FROM learning.outbox_job WHERE job_type='sync_portal_attendance') AS jobs,
      (SELECT count(*)::int FROM learning.submission) AS finals`)).rows[0];
    assert.deepEqual(counts, { checkpoints: 20, attendance: 20, jobs: 20, finals: 0 });
    assert.equal((await fixture.pool.query('SELECT auto_submission_threshold_at FROM learning.form_assignment')).rows[0].auto_submission_threshold_at, null);
  } finally { await fixture.close(); }
});

test('E06: giảng viên đổi quyết định sau checkpoint dừng yêu cầu Portal đã xếp hàng', async () => {
  const fixture = await postgresFixture({ asApplication:true });
  try {
    const {assignment,inputs}=await publishedFixture(fixture);
    await checkpoint(fixture,inputs[0],assignment.definition.blocks[0]);
    await fixture.service.overrideAttendance({assignmentId:assignment.assignmentId,studentRef:assignment.roster[0].studentRef,
      status:'not_eligible',reason:'Giảng viên điều chỉnh sau khi nộp phần.',operationKey:crypto.randomUUID(),
      reviewer:{email:'teacher@example.test',canAccessAllClasses:false}});
    const job=(await fixture.pool.query("SELECT status,result_json FROM learning.outbox_job WHERE job_type='sync_portal_attendance'")).rows[0];
    assert.equal(job.status,'review_required');
    assert.equal(job.result_json.portalStatus,'cancelled_by_teacher');
    assert.equal((await claimLearningJobs({pool:fixture.pool,workerId:'cancel-check',limit:1,leaseSeconds:90,jobTypes:['sync_portal_attendance']})).length,0);
  } finally {await fixture.close();}
});

test('E07: quyết định đổi trong lúc đọc Portal chặn pha ghi; giữ trạng thái cần đối chiếu', async () => {
  const fixture = await postgresFixture({ asApplication:true });
  try {
    const {assignment,inputs}=await publishedFixture(fixture);
    await checkpoint(fixture,inputs[0],assignment.definition.blocks[0]);
    const [job]=await claimLearningJobs({pool:fixture.pool,workerId:'inflight-check',limit:1,leaseSeconds:90,jobTypes:['sync_portal_attendance']});
    let writes=0;
    const handler=createLearningAttendanceSync({pool:fixture.pool,config:{learningAttendanceSyncUrl:'https://fixture.test/portal',
      learningAttendanceSyncSecret:'fixture-only',learningAttendanceSyncTimeoutMs:1000},fetchImpl:async(_url,options)=>{
      const body=JSON.parse(options.body);
      if(body.commit) writes++;
      else await fixture.service.overrideAttendance({assignmentId:assignment.assignmentId,studentRef:assignment.roster[0].studentRef,
        status:'pending_teacher',reason:'Đối chiếu lại thông tin tham gia.',operationKey:crypto.randomUUID(),
        reviewer:{email:'teacher@example.test',canAccessAllClasses:false}});
      return {ok:true,async json(){return {ok:true,status:body.commit?'synced':'resolved',entityKey:job.entityKey,unitKey:job.unitKey,
        operationKey:job.operationKey,idempotencyKey:job.idempotencyKey,classId:body.classId,studentId:body.studentId,
        sessionNumber:body.sessionNumber,targetSessionId:'35817',resolvedSessionId:'35817',bindingRevision:body.bindingRevision??null,
        scheduleFingerprint:'fixture-schedule',sessionDate:'2026-10-19'};}};
    }});
    await processLearningJob({pool:fixture.pool,workerId:'inflight-check',job,handler});
    assert.equal(writes,0,'Quyết định GV đổi trước pha ghi phải chặn PUT');
    const saved=(await fixture.pool.query('SELECT status,result_json FROM learning.outbox_job WHERE id=$1::uuid',[job.id])).rows[0];
    assert.equal(saved.status,'review_required');
    assert.equal(saved.result_json.reviewReason,'teacher_decision_during_processing');
  } finally {await fixture.close();}
});
