import assert from 'node:assert/strict';
import test from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { getTestScoringMetadata, gradeSection, buildCombinedResult } from '../src/term-tests.js';

function section(questions) {
  return { questions, pairGroups: {} };
}

test('K56 giữ đúng số Task Writing và điểm thô, K67 giữ band IELTS', () => {
  assert.deepEqual(getTestScoringMetadata('term-test-1-k56').writingTasks, [2]);
  assert.deepEqual(getTestScoringMetadata('term-test-2-k56').writingTasks, [1]);
  assert.deepEqual(getTestScoringMetadata('mini-test-k56').writingTasks, [2]);
  assert.equal(getTestScoringMetadata('term-test-2-k56').scoreMode, 'raw');
  assert.equal(getTestScoringMetadata('term-test-2').scoreMode, 'band');
  assert.deepEqual(getTestScoringMetadata('term-test-2').writingTasks, [1, 2]);
});

test('K56 trả điểm số câu, không tự chuyển sang IELTS band', () => {
  const input = section([{ number: 1, type: 'Completion', accepted: ['A'] }]);
  const raw = gradeSection(input, { 1: 'A' }, 0, 'raw');
  assert.equal(raw.correct, 1);
  assert.equal('band' in raw, false);
  const combined = buildCombinedResult({ test_slug: 'term-test-2-k56', test_title: 'K56', definition_version: 1 }, raw, raw);
  assert.equal(combined.summary.averageBand, null);
  assert.equal(combined.scoreMode, 'raw');
  const k67 = gradeSection(input, { 1: 'A' }, 0, 'band');
  assert.equal(k67.band, 9);
});

test('câu ghép K56 chỉ được điểm khi đủ mọi ô; ô trống không tính là đã trả lời', () => {
  const input = section([{
    number: 1,
    type: 'Compound',
    accepted: [],
    compound: { keys: ['1a', '1b'], accepted: { '1a': ['A'], '1b': ['B'] } }
  }]);
  assert.equal(gradeSection(input, { '1a': 'A', '1b': 'B' }, 0, 'raw').correct, 1);
  const partial = gradeSection(input, { '1a': 'A', '1b': '' }, 0, 'raw');
  assert.equal(partial.correct, 0);
  assert.equal(partial.answered, 0);
  assert.equal(partial.details[0].result, 'blank');
  assert.throws(() => gradeSection(section([{
    number: 1, type: 'Compound', accepted: [],
    compound: { keys: ['1a', '1a'], accepted: { '1a': ['A'] } }
  }]), {}, 0, 'raw'));
});

test('API nhận đúng slug Term Test K56 và trả metadata cho lớp được database mở bài', async () => {
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [{
        test_slug: 'term-test-2-k56', test_title: 'Term Test 2 K56', definition_version: 1,
        class_count: 1, class_id: '1252', class_name: 'IC2264', students: []
      }] };
    }
  };
  const app = createApp({
    pool,
    config: {
      nodeEnv: 'test', port: 8788, databaseUrl: 'postgresql://unused-in-tests', dbPoolMax: 2,
      authMode: 'legacy', googleClientId: '', legacyReviewToken: 'a-valid-test-token',
      allowedOrigins: new Set(['https://tranhoangduc90.github.io']), trustProxyHops: 0
    }
  });
  const response = await request(app).get('/api/term-tests/roster?class=IC2264&test=term-test-2-k56');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.test.writingTasks, [1]);
  assert.equal(response.body.test.scoreMode, 'raw');
  assert.deepEqual(calls[0].params, ['IC2264', 'term-test-2-k56']);
});
