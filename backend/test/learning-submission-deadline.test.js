import test from 'node:test';
import assert from 'node:assert/strict';
import { submissionWindowFromRow } from '../src/learning-submission-deadline.js';

const row = { status: 'published', opens_at: null, closes_at: null, complete_students: 3,
  auto_submission_threshold_at: '2026-10-06T12:30:00Z', auto_submission_closes_at: '2026-10-06T15:00:00Z' };

test('22:00 Việt Nam là ranh giới đóng chính xác, không dùng đồng hồ trình duyệt', () => {
  assert.equal(submissionWindowFromRow({ ...row, server_now: '2026-10-06T14:59:59.999Z' }).canSubmit, true);
  const exact = submissionWindowFromRow({ ...row, server_now: '2026-10-06T15:00:00.000Z' });
  assert.equal(exact.canSubmit, false);
  assert.equal(exact.reason, 'three_students_cutoff');
  assert.equal(exact.effectiveClosesAt, '2026-10-06T15:00:00.000Z');
});

test('chưa có người thứ ba vẫn nhận sau 22:00; hạn hình thành muộn đóng ngay', () => {
  const late = { ...row, server_now: '2026-10-06T16:00:00Z' };
  assert.equal(submissionWindowFromRow({ ...late, complete_students: 2,
    auto_submission_threshold_at: null, auto_submission_closes_at: null }).canSubmit, true);
  assert.equal(submissionWindowFromRow({ ...late, auto_submission_threshold_at: late.server_now }).canSubmit, false);
});

test('đóng thủ công sớm hơn thắng; gia hạn thủ công không vượt hạn tự khóa', () => {
  assert.equal(submissionWindowFromRow({ ...row, server_now: '2026-10-06T14:00:00Z', closes_at: '2026-10-06T13:00:00Z' }).reason, 'manual_cutoff');
  assert.equal(submissionWindowFromRow({ ...row, server_now: '2026-10-06T15:00:00Z', closes_at: '2026-10-07T15:00:00Z' }).reason, 'three_students_cutoff');
  assert.equal(submissionWindowFromRow({ ...row, status: 'closed', server_now: '2026-10-06T12:00:00Z' }).canSubmit, false);
});

test('thời gian hoặc cặp mốc hỏng đóng an toàn', () => {
  for (const mutation of [{ server_now: 'broken' }, { auto_submission_closes_at: null },
    { auto_submission_threshold_at: 'broken' }]) {
    assert.equal(submissionWindowFromRow({ ...row, server_now: '2026-10-06T12:00:00Z', ...mutation }).canSubmit, false);
  }
});
