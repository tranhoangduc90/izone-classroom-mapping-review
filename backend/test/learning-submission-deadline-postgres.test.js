import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { postgresFixture, publishedFixture } from './learning-postgres-fixture.js';

test('B08/B20: 18 kết nối nộp đồng thời sau 22:00 chỉ nhận ba người đầu, retry không tăng đếm', async () => {
  const fixture = await postgresFixture({ clock: { value: '2026-10-06T16:00:00Z' } });
  try {
    const { published, inputs } = await publishedFixture(fixture);
    const results = await Promise.allSettled(inputs.map(input => fixture.service.submit(input)));
    const accepted = results.filter(r => r.status === 'fulfilled');
    const rejected = results.filter(r => r.status === 'rejected');
    assert.equal(accepted.length, 3);
    assert.equal(rejected.length, 15);
    assert.ok(rejected.every(r => r.reason.code === 'ASSIGNMENT_CLOSED'));
    for (const result of accepted) {
      const input = inputs.find(i => i.submissionId === result.value.receipt.submissionId);
      assert.equal((await fixture.service.submit(input)).replayed, true);
    }
    assert.equal((await fixture.service.getPublicAssignment(published.publicToken)).submissionWindow.autoClosesAt, '2026-10-06T15:00:00.000Z');
    const counts = await fixture.pool.query(`SELECT
      (SELECT count(*)::int FROM learning.submission) AS submissions,
      (SELECT count(*)::int FROM learning.outbox_job WHERE job_type = 'sync_portal_attendance') AS jobs`);
    assert.deepEqual(counts.rows[0], { submissions: 3, jobs: 3 });
  } finally { await fixture.close(); }
});

test('B01/B03/B06/B12: chưa đủ không tính; 22:00 chặn final/checkpoint/start nhưng giữ draft', async () => {
  const clock = { value: '2026-10-06T14:00:00Z' };
  const fixture = await postgresFixture({ clock });
  try {
    const { published, assignment, inputs } = await publishedFixture(fixture);
    await fixture.service.submit({ ...inputs[0], responses: {} });
    assert.equal((await fixture.service.getPublicAssignment(published.publicToken)).submissionWindow.completeStudents, 0);
    await Promise.all(inputs.slice(1, 4).map(input => fixture.service.submit(input)));
    assert.equal((await fixture.service.getPublicAssignment(published.publicToken)).submissionWindow.autoClosesAt, '2026-10-06T15:00:00.000Z');
    clock.value = '2026-10-06T15:00:00Z';
    await assert.rejects(() => fixture.service.submit(inputs[4]), { code: 'ASSIGNMENT_CLOSED' });
    await assert.rejects(() => fixture.service.startAttempt({ publicToken: published.publicToken,
      studentRef: assignment.roster[4].studentRef, identityConfirmed: true,
      clientIdempotencyKey: inputs[4].submissionId }), { code: 'ASSIGNMENT_CLOSED' });
    const block = assignment.definition.blocks[0];
    await assert.rejects(() => fixture.service.submitCheckpoint({ ...inputs[4], blockId: block.blockId,
      checkpoint: block.checkpoint, checkpointSubmissionId: inputs[4].submissionId,
      idempotencyKey: 'after-cutoff' }), { code: 'ASSIGNMENT_CLOSED' });
    assert.equal((await fixture.service.saveDraft({ ...inputs[4], revision: 1 })).revision, 1);
    assert.equal((await fixture.service.submit(inputs[1])).replayed, true);
    assert.equal((await fixture.service.getPublicAssignment(published.publicToken)).submissionWindow.canSubmit, false);
  } finally { await fixture.close(); }
});

test('B09: đợi khóa vượt hạn kiểm đồng hồ sau khi lấy khóa, không dùng now đầu transaction', async () => {
  const fixture = await postgresFixture();
  const locker = await fixture.pool.connect();
  try {
    const { published, inputs } = await publishedFixture(fixture);
    await fixture.pool.query(`UPDATE learning.form_assignment SET closes_at = clock_timestamp() + interval '1 second' WHERE id = $1::uuid`, [published.assignmentId]);
    await locker.query('BEGIN');
    await locker.query('SELECT id FROM learning.form_assignment WHERE id = $1::uuid FOR UPDATE', [published.assignmentId]);
    const pending = fixture.service.submit(inputs[0]);
    await locker.query('SELECT pg_sleep(1.3)');
    await locker.query('COMMIT');
    await assert.rejects(() => pending, { code: 'ASSIGNMENT_CLOSED' });
    assert.equal((await fixture.pool.query('SELECT count(*)::int AS count FROM learning.submission')).rows[0].count, 0);
  } finally { locker.release(); await fixture.close(); }
});

test('B19: migration khóa phiếu cũ và giữ nguyên bài đã nhận sau hạn', async () => {
  const clock = { value: '2026-09-30T14:00:00Z' };
  const fixture = await postgresFixture({ clock });
  try {
    const { published, inputs } = await publishedFixture(fixture);
    await Promise.all(inputs.slice(0, 5).map(input => fixture.service.submit(input)));
    // Mô phỏng schema trước tính năng; kiểm chính migration sẽ dùng khi phát hành.
    await fixture.pool.query(`DROP TRIGGER preserve_submission_deadline ON learning.form_assignment;
      ALTER TABLE learning.form_assignment DROP COLUMN auto_submission_threshold_at,
        DROP COLUMN auto_submission_closes_at;`);
    await fixture.pool.query(`UPDATE learning.submission SET submitted_at = '2026-10-02T16:00:00Z' WHERE id = $1::uuid`, [inputs[4].submissionId]);
    await fixture.pool.query(await readFile(new URL('../ops/learning-migrations/202610060001_attendance_binding_and_submission_deadline.sql', import.meta.url), 'utf8'));
    clock.value = '2026-10-06T10:00:00Z';
    const status = await fixture.service.getPublicAssignment(published.publicToken);
    assert.equal(status.submissionWindow.autoClosesAt, '2026-09-30T15:00:00.000Z');
    assert.equal(status.submissionWindow.canSubmit, false);
    assert.equal(status.submissionWindow.completeStudents, 5);
    assert.equal((await fixture.pool.query('SELECT count(*)::int AS count FROM learning.submission')).rows[0].count, 5);
    await assert.rejects(() => fixture.pool.query("UPDATE learning.form_assignment SET auto_submission_closes_at = auto_submission_closes_at + interval '1 day'"), /không thể thay đổi/);
  } finally { await fixture.close(); }
});

test('B11: lỗi ghi phần liên quan rollback bài thứ ba và mốc khóa; retry nhận đúng một lần', async () => {
  const fixture = await postgresFixture({ clock: { value: '2026-10-06T14:00:00Z' } });
  try {
    const { published, inputs } = await publishedFixture(fixture);
    await fixture.service.submit(inputs[0]);
    await fixture.service.submit(inputs[1]);
    await fixture.pool.query(`CREATE FUNCTION learning.fixture_fail_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.job_type = 'sync_portal_attendance' THEN RAISE EXCEPTION 'fixture rollback'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fixture_fail_outbox BEFORE INSERT ON learning.outbox_job FOR EACH ROW EXECUTE FUNCTION learning.fixture_fail_outbox();`);
    await assert.rejects(() => fixture.service.submit(inputs[2]), /fixture rollback/);
    const window = (await fixture.service.getPublicAssignment(published.publicToken)).submissionWindow;
    assert.equal(window.completeStudents, 2);
    assert.equal(window.autoClosesAt, null);
    await fixture.pool.query('DROP TRIGGER fixture_fail_outbox ON learning.outbox_job');
    assert.equal((await fixture.service.submit(inputs[2])).submissionWindow.completeStudents, 3);
    assert.equal((await fixture.service.submit(inputs[2])).replayed, true);
  } finally { await fixture.close(); }
});
