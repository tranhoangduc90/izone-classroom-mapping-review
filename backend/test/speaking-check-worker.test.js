import assert from 'node:assert/strict';
import test from 'node:test';
import { runSpeakingCheckJob } from '../src/speaking-check-worker.js';

const job = { job_id: '11111111-1111-4111-8111-111111111111', part: 'clarify_1',
  share_url: 'https://chatgpt.com/share/11111111-1111-4111-8111-111111111111', min_questions: 3 };

test('kết quả AI cấp 1 đi vào đúng job cùng bằng chứng ba loại từ', async () => {
  const calls = [];
  const service = { async completeCheck(input) { calls.push(input); return { status: 'accepted' }; } };
  const check = async () => ({ kind: 'pass', count: 3, fingerprint: 'a'.repeat(64),
    coveredCategories: ['noun', 'verb', 'adjective'], completedTurns: [[1, 2], [3, 4], [5, 6]] });
  assert.equal(await runSpeakingCheckJob(service, job, check), 'accepted');
  assert.equal(calls[0].checkJobId, job.job_id);
  assert.equal(calls[0].qualityPassed, true);
  assert.deepEqual(calls[0].evidence.coveredCategories, ['noun', 'verb', 'adjective']);
});

test('Share không mở được chốt từ chối; lỗi AI giữ việc để thử lại', async () => {
  const calls = [];
  const service = {
    async rejectCheckJob(input) { calls.push(['reject', input]); },
    async failCheckJob(input) { calls.push(['fail', input]); }
  };
  assert.equal(await runSpeakingCheckJob(service, job, async () =>
    ({ kind: 'blocked', title: 'Chưa mở được hội thoại' })), 'rejected');
  assert.equal(calls[0][1].checkCode, 'SHARE_UNAVAILABLE');
  assert.equal(await runSpeakingCheckJob(service, job, async () =>
    ({ kind: 'error', title: 'AI tạm lỗi' })), 'retry');
  assert.equal(calls[1][0], 'fail');
});

test('đủ số câu nhưng thiếu loại từ không được nhận', async () => {
  let submitted;
  const service = { async completeCheck(input) {
    submitted = input;
    return { status: input.qualityPassed ? 'accepted' : 'rejected' };
  } };
  const check = async () => ({ kind: 'blocked', count: 3, fingerprint: 'b'.repeat(64),
    coveredCategories: ['noun', 'verb'], completedTurns: [[1, 2], [3, 4], [5, 6]] });
  assert.equal(await runSpeakingCheckJob(service, job, check), 'rejected');
  assert.equal(submitted.qualityPassed, false);
});
