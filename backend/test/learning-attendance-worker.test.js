import assert from 'node:assert/strict';
import test from 'node:test';
import * as attendanceWorker from '../src/learning-attendance-worker.js';

test('lease điểm danh dài hơn thời gian tối đa của cả batch cộng biên an toàn', () => {
  const maxPortalTimeoutMs = 15_000;
  const safetyMarginMs = 30_000;
  assert.ok(Number.isInteger(attendanceWorker.ATTENDANCE_JOB_BATCH_LIMIT));
  assert.ok(Number.isInteger(attendanceWorker.ATTENDANCE_JOB_LEASE_SECONDS));
  assert.ok(attendanceWorker.ATTENDANCE_JOB_LEASE_SECONDS * 1000
    >= attendanceWorker.ATTENDANCE_JOB_BATCH_LIMIT * maxPortalTimeoutMs + safetyMarginMs);
});
