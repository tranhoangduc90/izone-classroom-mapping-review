import test from 'node:test';
import assert from 'node:assert/strict';
import {postgresFixture,publishedFixture} from './learning-postgres-fixture.js';

// Lỗi 08/10: owner test đạt nhưng role ứng dụng rollback toàn bộ bài và điểm danh.
test('role ứng dụng nhận 20 bài đồng thời, retry giữ đúng bài/điểm danh và hạn 22:00',async()=>{
 const clock={value:'2026-10-08T14:00:00Z'};
 const fixture=await postgresFixture({clock,asApplication:true,studentCount:20});
 try {
  assert.equal((await fixture.clockPool.query('SELECT current_user')).rows[0].current_user,'learning_api');
  const {published,inputs}=await publishedFixture(fixture);
  const results=await Promise.all(inputs.map(input=>fixture.service.submit(input)));
  assert.equal(results.length,20);
  const retries=await Promise.all(inputs.map(input=>fixture.service.submit(input)));
  assert.ok(retries.every(result=>result.replayed));
  const counts=(await fixture.pool.query(`SELECT
   (SELECT count(*)::int FROM learning.submission) submissions,
   (SELECT count(*)::int FROM learning.attendance_event) attendance,
   (SELECT count(*)::int FROM learning.outbox_job WHERE job_type='sync_portal_attendance') jobs`)).rows[0];
  assert.deepEqual(counts,{submissions:20,attendance:20,jobs:20});
  assert.equal((await fixture.service.getPublicAssignment(published.publicToken)).submissionWindow.autoClosesAt,'2026-10-08T15:00:00.000Z');
  clock.value='2026-10-08T15:00:00Z';
  assert.equal((await fixture.service.getPublicAssignment(published.publicToken)).submissionWindow.canSubmit,false);
  assert.equal((await fixture.service.submit(inputs[0])).replayed,true);
  await assert.rejects(()=>fixture.clockPool.query(`UPDATE learning.form_assignment SET form_version_id=form_version_id`),{code:'42501'});
 } finally {await fixture.close();}
});

test('thiếu quyền mốc khóa rollback ngay bài đầu; cấp quyền rồi retry nhận đúng một bài',async()=>{
 const fixture=await postgresFixture({clock:{value:'2026-10-08T14:00:00Z'},asApplication:true,deadlineGrant:false});
 try {
  const {inputs}=await publishedFixture(fixture);
  await assert.rejects(()=>fixture.service.submit(inputs[0]),{code:'42501'});
  const counts=(await fixture.pool.query(`SELECT
   (SELECT count(*)::int FROM learning.submission) submissions,
   (SELECT count(*)::int FROM learning.attendance_event) attendance,
   (SELECT count(*)::int FROM learning.outbox_job) jobs`)).rows[0];
  assert.deepEqual(counts,{submissions:0,attendance:0,jobs:0});
  await fixture.pool.query(`GRANT UPDATE(auto_submission_threshold_at,auto_submission_closes_at) ON learning.form_assignment TO learning_api`);
  assert.equal((await fixture.service.submit(inputs[0])).replayed,false);
  assert.equal((await fixture.service.submit(inputs[0])).replayed,true);
  assert.equal((await fixture.pool.query('SELECT count(*)::int n FROM learning.submission')).rows[0].n,1);
 } finally {await fixture.close();}
});
