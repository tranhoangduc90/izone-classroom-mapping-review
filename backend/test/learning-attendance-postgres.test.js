import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { postgresFixture, publishedFixture } from './learning-postgres-fixture.js';
import { claimLearningJobs, processLearningJob } from '../src/learning-outbox.js';
import { createLearningAttendanceSync } from '../src/learning-attendance-sync.js';
import { createLearningService } from '../src/learning-service.js';
import { createAttendanceBindingStore } from '../src/learning-attendance-binding.js';

const config = { learningAttendanceSyncUrl: 'https://fixture.test/portal',
  learningAttendanceSyncSecret: 'fixture-only-secret', learningAttendanceSyncTimeoutMs: 1000 };

function portalFixture() {
  const state = { resolvedId: '35817', fingerprint: 'schedule-a', puts: 0, present: new Set(), timeoutOnce: false };
  return { state, async fetch(_url, options) {
    const request = JSON.parse(options.body);
    const target = request.targetSessionId || state.resolvedId;
    const key = `${request.studentId}:${target}`;
    let status = state.present.has(key) ? 'already_present'
      : target !== state.resolvedId ? 'target_changed' : 'resolved';
    if (request.commit && status === 'resolved') {
      assert.equal(request.expectedScheduleFingerprint, state.fingerprint);
      state.puts++;
      state.present.add(key);
      if (state.timeoutOnce) { state.timeoutOnce = false; const e = new Error('fixture timeout'); e.name = 'TimeoutError'; throw e; }
      status = 'synced';
    }
    return { ok: true, status: 200, async json() { return { ok: true, status,
      entityKey: request.entityKey, unitKey: request.unitKey, operationKey: request.operationKey,
      idempotencyKey: request.idempotencyKey, classId: request.classId, studentId: request.studentId,
      sessionNumber: request.sessionNumber, targetSessionId: target, resolvedSessionId: state.resolvedId,
      bindingRevision: request.bindingRevision ?? null, scheduleFingerprint: state.fingerprint, sessionDate: '2026-10-05' }; } };
  } };
}

async function claim(pool, workerId) {
  const jobs = await claimLearningJobs({ pool, workerId, limit: 1, leaseSeconds: 90, jobTypes: ['sync_portal_attendance'] });
  assert.equal(jobs.length, 1);
  return jobs[0];
}

test('A09/A10: hai worker cùng phiếu dùng một đích; lịch đổi sau một phần ghi dừng người còn lại', async () => {
  const fixture = await postgresFixture({ clock: { value: '2026-10-06T14:00:00Z' } });
  try {
    const { inputs } = await publishedFixture(fixture);
    await Promise.all(inputs.slice(0, 3).map(input => fixture.service.submit(input)));
    const portal = portalFixture();
    const handler = createLearningAttendanceSync({ config, pool: fixture.pool, fetchImpl: portal.fetch });
    const [first, second] = await Promise.all([claim(fixture.pool, 'a'), claim(fixture.pool, 'b')]);
    const results = await Promise.all([processLearningJob({ pool: fixture.pool, workerId: 'a', job: first, handler }),
      processLearningJob({ pool: fixture.pool, workerId: 'b', job: second, handler })]);
    assert.ok(results.every(r => r.status === 'complete'));
    assert.equal(portal.state.puts, 2);
    assert.equal((await fixture.pool.query('SELECT count(*)::int AS count FROM learning.portal_attendance_binding')).rows[0].count, 1);
    portal.state.resolvedId = '99999'; portal.state.fingerprint = 'schedule-b';
    const third = await claim(fixture.pool, 'c');
    assert.equal((await processLearningJob({ pool: fixture.pool, workerId: 'c', job: third, handler })).status, 'review_required');
    assert.equal(portal.state.puts, 2);
    const binding = (await fixture.pool.query('SELECT * FROM learning.portal_attendance_binding')).rows[0];
    assert.equal(String(binding.target_session_id), '35817');
    assert.equal(binding.review_required, true);
    assert.equal((await fixture.pool.query("SELECT count(*)::int AS count FROM learning.portal_attendance_operation WHERE status='synced' AND target_session_id=35817 AND readback_at IS NOT NULL")).rows[0].count, 2);
  } finally { await fixture.close(); }
});

test('A11/A22: PUT đã lưu rồi timeout, retry đọc đúng đích cũ dù lịch đổi và không PUT lần hai', async () => {
  const fixture = await postgresFixture();
  try {
    const { inputs } = await publishedFixture(fixture);
    await fixture.service.submit(inputs[0]);
    const portal = portalFixture(); portal.state.timeoutOnce = true;
    const handler = createLearningAttendanceSync({ config, pool: fixture.pool, fetchImpl: portal.fetch });
    const job = await claim(fixture.pool, 'timeout-worker');
    assert.equal((await processLearningJob({ pool: fixture.pool, workerId: 'timeout-worker', job, handler })).errorCode, 'PORTAL_ATTENDANCE_TIMEOUT');
    assert.equal((await fixture.pool.query('SELECT status FROM learning.portal_attendance_operation')).rows[0].status, 'intent');
    portal.state.resolvedId = '99999'; portal.state.fingerprint = 'schedule-b';
    await fixture.pool.query("UPDATE learning.outbox_job SET next_attempt_at = now() - interval '1 second' WHERE id=$1::uuid", [job.id]);
    const retry = await claim(fixture.pool, 'recovery-worker');
    assert.equal((await processLearningJob({ pool: fixture.pool, workerId: 'recovery-worker', job: retry, handler })).status, 'review_required');
    assert.equal(portal.state.puts, 1);
    const operation = (await fixture.pool.query('SELECT * FROM learning.portal_attendance_operation')).rows[0];
    assert.equal(operation.status, 'already_present');
    assert.equal(String(operation.target_session_id), '35817');
    assert.ok(operation.readback_at);
  } finally { await fixture.close(); }
});

test('A15: worker cũ hết lease không ghi intent hoặc đánh dấu lỗi thay worker mới', async () => {
  const fixture = await postgresFixture();
  try {
    const { inputs } = await publishedFixture(fixture);
    await fixture.service.submit(inputs[0]);
    const stale = await claim(fixture.pool, 'stale-worker');
    await fixture.pool.query("UPDATE learning.outbox_job SET lease_until=now()-interval '1 second' WHERE id=$1::uuid", [stale.id]);
    const fresh = await claim(fixture.pool, 'fresh-worker');
    const portal = portalFixture();
    const handler = createLearningAttendanceSync({ config, pool: fixture.pool, fetchImpl: portal.fetch });
    await processLearningJob({ pool: fixture.pool, workerId: 'stale-worker', job: stale, handler });
    assert.equal(portal.state.puts, 0);
    const row = (await fixture.pool.query('SELECT worker_id, status FROM learning.outbox_job WHERE id=$1::uuid', [stale.id])).rows[0];
    assert.deepEqual(row, { worker_id: 'fresh-worker', status: 'processing' });
    assert.equal((await processLearningJob({ pool: fixture.pool, workerId: 'fresh-worker', job: fresh, handler })).status, 'complete');
  } finally { await fixture.close(); }
});

test('A15: worker mất lease sau reserve không ghi đè readback đã lưu bởi lượt mới', async () => {
  const fixture = await postgresFixture();
  try {
    const { inputs } = await publishedFixture(fixture);
    await fixture.service.submit(inputs[0]);
    const stale = await claim(fixture.pool,'old-outcome-worker');
    const store = createAttendanceBindingStore(fixture.pool);
    const binding = await store.reserve(stale,stale.payload,{status:'resolved',targetSessionId:'35817',
      resolvedSessionId:'35817',scheduleFingerprint:'a',sessionDate:'2026-10-05'});
    await fixture.pool.query("UPDATE learning.outbox_job SET lease_until=now()-interval '1 second' WHERE id=$1", [stale.id]);
    const fresh = await claim(fixture.pool,'new-outcome-worker');
    await store.record(fresh,fresh.payload,binding,{status:'synced',sessionDate:'2026-10-05'});
    await assert.rejects(() => store.record(stale,stale.payload,binding,{status:'conflict',sessionDate:null}), {code:'OUTPUT_IDENTITY_MISMATCH'});
    const row = (await fixture.pool.query('SELECT status, readback_at FROM learning.portal_attendance_operation')).rows[0];
    assert.equal(row.status,'synced');
    assert.ok(row.readback_at);
  } finally { await fixture.close(); }
});

test('A11: timeout trước khi execution cũ ghi xong chỉ GET khi retry, không gửi PUT lần hai', async () => {
  const fixture = await postgresFixture();
  try {
    const { inputs } = await publishedFixture(fixture);
    await fixture.service.submit(inputs[0]);
    const portal = portalFixture();
    let commits = 0;
    const handler = createLearningAttendanceSync({ config, pool: fixture.pool, fetchImpl: async (url, options) => {
      if (JSON.parse(options.body).commit) {
        commits++;
        const error = new Error('Execution vẫn đang chờ Portal'); error.name = 'TimeoutError'; throw error;
      }
      return portal.fetch(url, options);
    } });
    const first = await claim(fixture.pool, 'slow-worker');
    await processLearningJob({ pool: fixture.pool, workerId: 'slow-worker', job: first, handler });
    await fixture.pool.query("UPDATE learning.outbox_job SET next_attempt_at=now()-interval '1 second' WHERE id=$1", [first.id]);
    const retry = await claim(fixture.pool, 'retry-worker');
    assert.equal((await processLearningJob({ pool: fixture.pool, workerId: 'retry-worker', job: retry, handler })).status, 'review_required');
    assert.equal(commits, 1);
    const output = (await fixture.pool.query('SELECT result_json FROM learning.outbox_job WHERE id=$1', [first.id])).rows[0].result_json;
    assert.equal(output.reviewReason, 'write_outcome_unknown');
  } finally { await fixture.close(); }
});

test('A21: job cũ đã từng xử lý phải đối soát đích trước chuyển đổi, không tự PUT đích mới', async () => {
  const fixture = await postgresFixture();
  try {
    const { inputs } = await publishedFixture(fixture);
    await fixture.service.submit(inputs[0]);
    await fixture.pool.query(`UPDATE learning.outbox_job SET attempt_count=1,
      created_at=(SELECT activated_at - interval '1 second' FROM learning.portal_attendance_transition)
      WHERE job_type='sync_portal_attendance'`);
    await fixture.pool.query('DELETE FROM learning.portal_attendance_transition');
    await fixture.pool.query(await readFile(new URL('../ops/learning-migrations/202610060001_attendance_binding_and_submission_deadline.sql', import.meta.url), 'utf8'));
    const job = await claim(fixture.pool, 'legacy-worker');
    const portal = portalFixture();
    const handler = createLearningAttendanceSync({ config, pool: fixture.pool, fetchImpl: portal.fetch });
    assert.equal((await processLearningJob({ pool: fixture.pool, workerId: 'legacy-worker', job, handler })).status, 'review_required');
    assert.equal(portal.state.puts, 0);
    assert.equal((await fixture.pool.query('SELECT count(*)::int AS count FROM learning.portal_attendance_operation')).rows[0].count, 0);
    const row = (await fixture.pool.query("SELECT result_json FROM learning.outbox_job WHERE id=$1", [job.id])).rows[0];
    assert.equal(row.result_json.reviewReason, 'legacy_target_unverified');
  } finally { await fixture.close(); }
});

test('A21: job còn chờ trước nâng cấp chưa từng thử vẫn ghi bình thường ở lần claim đầu', async () => {
  const fixture = await postgresFixture();
  try {
    const { inputs } = await publishedFixture(fixture);
    await fixture.service.submit(inputs[0]);
    await fixture.pool.query(`UPDATE learning.outbox_job SET
      created_at=(SELECT activated_at - interval '1 second' FROM learning.portal_attendance_transition)
      WHERE job_type='sync_portal_attendance'`);
    await fixture.pool.query('DELETE FROM learning.portal_attendance_transition');
    await fixture.pool.query(await readFile(new URL('../ops/learning-migrations/202610060001_attendance_binding_and_submission_deadline.sql', import.meta.url), 'utf8'));
    const job = await claim(fixture.pool, 'first-worker');
    const portal = portalFixture();
    const handler = createLearningAttendanceSync({ config, pool: fixture.pool, fetchImpl: portal.fetch });
    assert.equal((await processLearningJob({ pool: fixture.pool, workerId: 'first-worker', job, handler })).status, 'complete');
    assert.equal(portal.state.puts, 1);
  } finally { await fixture.close(); }
});

test('A13/A14: payload đúng cấu trúc nhưng tráo học viên ERP dừng ở kho liên kết trước PUT', async () => {
  const fixture = await postgresFixture();
  try {
    const { inputs } = await publishedFixture(fixture);
    await fixture.service.submit(inputs[0]);
    const job = await claim(fixture.pool, 'identity-worker');
    job.payload.studentId = '9999999';
    const portal = portalFixture();
    const handler = createLearningAttendanceSync({ config, pool: fixture.pool, fetchImpl: portal.fetch });
    const result = await processLearningJob({ pool: fixture.pool, workerId: 'identity-worker', job, handler });
    assert.equal(result.errorCode, 'OUTPUT_IDENTITY_MISMATCH');
    assert.equal(portal.state.puts, 0);
    assert.equal((await fixture.pool.query('SELECT count(*)::int AS count FROM learning.portal_attendance_binding')).rows[0].count, 0);
  } finally { await fixture.close(); }
});

test('A04/A10: Journey giữ mã ERP đã ghi khi thứ tự đổi; cùng mã ERP đổi ngày được cập nhật kế hoạch', async () => {
  const fixture = await postgresFixture();
  try {
    const { published, inputs } = await publishedFixture(fixture, 1);
    const schedule = { sessions: [{erpSessionId:'35817',date:'2026-10-05',
      startsAt:'2026-10-05 18:30:00',endsAt:'2026-10-05 21:00:00',statusCode:0}],
      fetchedAt: new Date().toISOString() };
    const service = createLearningService({pool:fixture.pool,erpScheduleReader:async()=>schedule});
    const reviewer = {email:'teacher@example.test',canAccessAllClasses:false};
    await service.saveTeacherJourneyPlan({assignmentId:published.assignmentId,totalSessions:2,
      testSessionNumbers:[],expectedRevision:0,reviewer,
      sessionDates:[{sessionNumber:1,date:'2026-10-05',erpSessionId:'35817'}]});
    schedule.sessions[0] = {...schedule.sessions[0],date:'2026-10-06',startsAt:'2026-10-06 18:30:00'};
    const changed = await service.saveTeacherJourneyPlan({assignmentId:published.assignmentId,totalSessions:2,
      testSessionNumbers:[],expectedRevision:1,reviewer,
      sessionDates:[{sessionNumber:1,date:'2026-10-06',erpSessionId:'35817'}]});
    assert.equal(changed.sessionDates[0].date, '2026-10-06');
    await fixture.service.submit(inputs[0]);
    const portal = portalFixture();
    const handler = createLearningAttendanceSync({config,pool:fixture.pool,fetchImpl:portal.fetch});
    const job = await claim(fixture.pool,'journey-worker');
    await processLearningJob({pool:fixture.pool,workerId:'journey-worker',job,handler});
    schedule.sessions.unshift({erpSessionId:'35816',date:'2026-10-04',startsAt:'2026-10-04 18:30:00',statusCode:0});
    const student = (await fixture.pool.query('SELECT student_ref FROM learning.attempt WHERE attempt_token=$1', [inputs[0].attemptToken])).rows[0];
    const journey = await service.getStudentCourseJourney({publicToken:published.publicToken,studentRef:student.student_ref});
    assert.equal(journey.sessions[0].erpSessionId, '35817');
    assert.equal(journey.sessions[0].sessionDate, '2026-10-06');
    assert.equal(journey.sessions[0].scheduleStatus, 'needs_review');
  } finally { await fixture.close(); }
});
