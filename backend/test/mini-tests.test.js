import assert from 'node:assert/strict';
import test from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { buildMiniTestResult } from '../src/mini-tests.js';

const payload = {
  version: 1,
  sourceSubmissionKey: 'a'.repeat(64),
  testSlug: 'mini-test-lesson-5',
  classCode: 'IC2200',
  studentName: 'Học viên thử nghiệm',
  sourceSubmittedAt: '01/01/2026 09:00:00',
  scores: { listeningCorrect: 15, readingCorrect: 9 },
  typeStats: [
    { type: 'Listening - Multiple choice', correct: 15, total: 20 },
    { type: 'Reading - Matching headings', correct: 9, total: 13 }
  ]
};

function makeConfig() {
  return {
    allowedOrigins: new Set(['https://tranhoangduc90.github.io']),
    trustProxyHops: 0,
    authMode: 'legacy',
    legacyReviewToken: 'a-valid-test-token',
    miniTestSyncSecret: 'm'.repeat(32)
  };
}

test('Mini Test quy đổi đúng thang điểm và Band IELTS', () => {
  const result = buildMiniTestResult({
    testSlug: payload.testSlug,
    listeningCorrect: 15,
    readingCorrect: 9,
    typeStats: payload.typeStats
  });
  assert.equal(result.listening.score10, 7.5);
  assert.equal(result.listening.converted, 30);
  assert.equal(result.listening.band, 7);
  assert.equal(result.reading.converted, 27);
  assert.equal(result.reading.band, 6.5);
  assert.equal(result.summary.averageBand, 6.75);
});

test('endpoint Mini Test từ chối khóa sai trước khi đọc database', async () => {
  let queryCount = 0;
  const pool = { query: async () => { queryCount += 1; return { rowCount: 0, rows: [] }; } };
  const response = await request(createApp({ config: makeConfig(), pool }))
    .post('/api/mini-tests/results')
    .set('x-mini-test-sync', 'wrong')
    .send(payload);
  assert.equal(response.status, 401);
  assert.equal(queryCount, 0);
});

test('endpoint Mini Test lưu kết quả bằng ID lấy từ database mapping', async () => {
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (calls.length === 1) {
        return {
          rowCount: 1,
          rows: [{ class_id: '1187', class_name: 'IC2200', student_id: '9001', student_name: 'Học viên thử nghiệm' }]
        };
      }
      return { rowCount: 1, rows: [{ result_id: '00000000-0000-4000-8000-000000000301' }] };
    }
  };
  const response = await request(createApp({ config: makeConfig(), pool }))
    .post('/api/mini-tests/results')
    .set('x-mini-test-sync', 'm'.repeat(32))
    .send(payload);
  assert.equal(response.status, 201);
  assert.equal(response.body.status, 'stored');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].params[2], '1187');
  assert.equal(calls[1].params[4], '9001');
  assert.equal(JSON.parse(calls[1].params[9]).summary.averageBand, 6.75);
});
