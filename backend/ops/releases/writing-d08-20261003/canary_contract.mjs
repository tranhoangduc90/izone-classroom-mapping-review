// Nhận đúng UUID giả, hàm gửi API và hàm đọc database của lượt đó.
// Kiểm bản mới, bản đến trễ, gửi lại và client cũ; chỉ start/draft, không submit/result.
// Trả bằng chứng có nội dung hai Task, revision và child count; assertion lỗi giữ ca mở.
import assert from 'node:assert/strict';

export async function exerciseCanary({ id, post, read }) {
  const receipts = [];
  const send = async (caseName, body, expectedStatus = 200) => {
    const payload = { attemptToken: id, action: 'draft', ...body };
    assert.ok(['start', 'draft'].includes(payload.action));
    const result = await post(payload);
    assert.equal(result.status, expectedStatus, caseName);
    receipts.push({ case: caseName, payload, response: result });
    return result.body;
  };
  const stored = async (task1, task2, revision) => {
    const value = await read();
    assert.equal(value.task1, task1);
    assert.equal(value.task2, task2);
    assert.equal(Number(value.revision), revision);
    assert.equal(value.submitted, false);
    assert.ok(Object.values(value.children).length === 5);
    assert.ok(Object.values(value.children).every(count => count === 0), 'UNEXPECTED_CHILD_SIDE_EFFECT');
    receipts.push({ case: 'database_readback', value });
    return value;
  };
  await stored('', '', 0);
  const started = await send('start_does_not_change_draft', { action: 'start', task1: '', task2: '' });
  assert.equal(started.ok, true);
  assert.equal(started.attemptToken, id);
  assert.equal(started.writing.revision, 0);
  await stored('', '', 0);
  const newest = { task1: 'D08 giả: Task 1 mới ' + id, task2: 'D08 giả: Task 2 mới ' + id, baseRevision: 0, revision: 900 };
  const accepted = await send('save_newest_two_tasks', newest);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.attemptToken, id);
  assert.equal(accepted.writing.accepted, true);
  assert.equal(accepted.writing.reason, 'saved');
  assert.equal(accepted.writing.revision, 1);
  assert.equal(accepted.writing.task1, newest.task1);
  assert.equal(accepted.writing.task2, newest.task2);
  const first = await stored(newest.task1, newest.task2, 1);
  const stale = await send('stale_base_cannot_overwrite', { baseRevision: 0, revision: 999999, task1: 'D08 cũ 1', task2: 'D08 cũ 2' });
  assert.equal(stale.writing.accepted, false);
  assert.equal(stale.writing.reason, 'revision_conflict');
  assert.equal(stale.writing.revision, 1);
  assert.equal(stale.writing.task1, newest.task1);
  assert.equal(stale.writing.task2, newest.task2);
  await stored(newest.task1, newest.task2, 1);
  const retry = await send('same_snapshot_retry', newest);
  assert.equal(retry.writing.accepted, true);
  assert.equal(retry.writing.reason, 'already_saved');
  assert.equal(retry.writing.revision, 1);
  const afterRetry = await stored(newest.task1, newest.task2, 1);
  assert.equal(afterRetry.updatedAt, first.updatedAt, 'RETRY_CHANGED_TIMESTAMP');
  const missing = await send('old_client_missing_base_blocked', { task1: 'Không ghi 1', task2: 'Không ghi 2' }, 409);
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'WRITING_CLIENT_UPDATE_REQUIRED');
  const invalid = await send('negative_base_blocked', { baseRevision: -1, task1: 'Không ghi 1', task2: 'Không ghi 2' }, 400);
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error, 'INVALID_WRITING');
  const final = await stored(newest.task1, newest.task2, 1);
  assert.equal(final.updatedAt, first.updatedAt);
  return { status: 'passed', attempt_id: id, receipts, final, scope: 'API + database; browser outcome and cleanup are separate required receipts' };
}
