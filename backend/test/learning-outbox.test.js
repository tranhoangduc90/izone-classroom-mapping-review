import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LearningJobIdentityError,
  assertLearningJobOutputIdentity,
  retryDelayMs
} from '../src/learning-outbox.js';

const job = {
  id: '11111111-1111-4111-8111-111111111111',
  entityKey: 'student:60000000-0000-4000-8000-000000000001',
  unitKey: 'class:2139:session:8',
  operationKey: 'analyze:submission-fake:v1',
  idempotencyKey: 'analyze:submission-fake:enqueue:v1'
};

test('output queue chỉ được nhận khi đủ bốn lớp identity khớp chính xác', () => {
  const output = assertLearningJobOutputIdentity(job, {
    ...job,
    status: 'complete',
    extraResult: { safe: true }
  });
  assert.equal(output.status, 'complete');
  assert.throws(() => assertLearningJobOutputIdentity(job, {
    ...job,
    entityKey: 'student:60000000-0000-4000-8000-000000000002',
    status: 'complete'
  }), LearningJobIdentityError);
});

test('backoff tăng dần và bị chặn ở 15 phút', () => {
  assert.equal(retryDelayMs(1), 5_000);
  assert.equal(retryDelayMs(2), 10_000);
  assert.equal(retryDelayMs(20), 900_000);
});
