import assert from 'node:assert/strict';
import test from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { buildCombinedResult, gradeSection } from '../src/term-tests.js';

function makeSection() {
  return {
    questions: Array.from({ length: 40 }, (_, index) => {
      const number = index + 1;
      if (number === 2 || number === 3) {
        return { number, type: 'Multiple choice (choose TWO)', accepted: [], pairGroup: 'PAIR_2_3' };
      }
      return {
        number,
        type: number <= 20 ? 'Completion' : 'Multiple choice',
        accepted: [number === 1 ? 'colour' : `answer-${number}`]
      };
    }),
    pairGroups: {
      PAIR_2_3: { numbers: [2, 3], expected: ['B', 'D'] }
    }
  };
}

function perfectAnswers() {
  const answers = Object.fromEntries(Array.from({ length: 40 }, (_, index) => {
    const number = index + 1;
    return [String(number), number === 1 ? 'color' : `answer-${number}`];
  }));
  answers['2'] = 'D';
  answers['3'] = 'B';
  return answers;
}

function makeConfig() {
  return {
    nodeEnv: 'test',
    port: 8788,
    databaseUrl: 'postgresql://unused-in-tests',
    dbPoolMax: 2,
    authMode: 'legacy',
    googleClientId: '',
    legacyReviewToken: 'a-valid-test-token',
    allowedOrigins: new Set(['https://tranhoangduc90.github.io']),
    trustProxyHops: 0
  };
}

function makePool(handler) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      return handler(sql, params, calls.length);
    }
  };
}

function storedTestRow(overrides = {}) {
  return {
    test_slug: 'term-test-1',
    test_title: 'Term Test 1',
    definition_version: 1,
    listening_band_adjustment: 0,
    listening_definition: makeSection(),
    reading_definition: makeSection(),
    class_id: '2139',
    class_name: 'IC2139',
    student_id: '9001',
    student_name: 'Học viên thử nghiệm',
    ...overrides
  };
}

test('chấm đủ 40/40, chấp nhận spelling variant và cặp đáp án đảo thứ tự', () => {
  const grade = gradeSection(makeSection(), perfectAnswers(), 0);
  assert.equal(grade.correct, 40);
  assert.equal(grade.answered, 40);
  assert.equal(grade.band, 9);
  assert.equal(grade.details[0].result, 'correct');
  assert.equal(grade.details[1].correctAnswer, 'B + D (không xét thứ tự)');
});

test('phân biệt sai và bỏ trống, đồng thời tạo performance', () => {
  const answers = perfectAnswers();
  answers['1'] = 'clour';
  answers['40'] = '';
  const listening = gradeSection(makeSection(), answers, 0);
  const reading = gradeSection(makeSection(), perfectAnswers(), 0);
  const combined = buildCombinedResult(storedTestRow(), listening, reading);
  assert.equal(listening.correct, 38);
  assert.equal(listening.details[0].result, 'incorrect');
  assert.equal(listening.details[39].result, 'blank');
  assert.equal(combined.summary.totalCorrect, 78);
  assert.equal(combined.summary.averageBand, 8.75);
  assert.ok(combined.performance.best.length >= 1);
  assert.ok(combined.performance.needsImprovement.length >= 1);
});

test('roster công khai không cần Google token và không trả ID ERP/email', async () => {
  const pool = makePool(async () => ({
    rowCount: 1,
    rows: [{
      test_slug: 'term-test-1',
      test_title: 'Term Test 1',
      definition_version: 1,
      class_count: 1,
      class_id: '2139',
      class_name: 'IC2139',
      students: [{ ref: '00000000-0000-4000-8000-000000000001', name: 'Học viên A' }]
    }]
  }));
  const app = createApp({ config: makeConfig(), pool });
  const response = await request(app)
    .get('/api/term-tests/roster?class=ic2139&test=term-test-1')
    .set('Origin', 'https://tranhoangduc90.github.io');
  assert.equal(response.status, 200);
  assert.equal(response.body.class.name, 'IC2139');
  assert.deepEqual(response.body.students[0], {
    ref: '00000000-0000-4000-8000-000000000001',
    name: 'Học viên A'
  });
  assert.equal(JSON.stringify(response.body).includes('erpStudentId'), false);
});

test('nộp Listening tạo attempt token nhưng chưa trả điểm', async () => {
  const attemptToken = '00000000-0000-4000-8000-000000000099';
  const pool = makePool(async (_sql, _params, callNumber) => {
    if (callNumber === 1) return { rowCount: 1, rows: [storedTestRow()] };
    return {
      rowCount: 1,
      rows: [{
        attempt_token: attemptToken,
        class_id: '2139',
        student_id: '9001',
        student_name: 'Học viên thử nghiệm'
      }]
    };
  });
  const app = createApp({ config: makeConfig(), pool });
  const response = await request(app)
    .post('/api/term-tests/term-test-1/listening')
    .set('Origin', 'https://tranhoangduc90.github.io')
    .send({
      classCode: 'IC2139',
      studentRef: '00000000-0000-4000-8000-000000000001',
      clientSubmissionId: '00000000-0000-4000-8000-000000000002',
      answers: perfectAnswers()
    });
  assert.equal(response.status, 201);
  assert.equal(response.body.attemptToken, attemptToken);
  assert.equal(response.body.next, 'reading');
  assert.equal('result' in response.body, false);
  assert.equal(pool.calls.length, 2);
});

test('nộp Reading chấm cả hai phần và result chỉ mở bằng attempt token', async () => {
  const attemptToken = '00000000-0000-4000-8000-000000000099';
  const listening = gradeSection(makeSection(), perfectAnswers(), 0);
  let combinedResult;
  const pool = makePool(async (_sql, params, callNumber) => {
    if (callNumber === 1) {
      return {
        rowCount: 1,
        rows: [storedTestRow({
          attempt_token: attemptToken,
          slug: 'term-test-1',
          title: 'Term Test 1',
          version: 1,
          listening_result: listening,
          completed_at: null,
          combined_result: null
        })]
      };
    }
    if (callNumber === 2) {
      combinedResult = JSON.parse(params[3]);
      return { rowCount: 1, rows: [{ attempt_token: attemptToken, combined_result: combinedResult }] };
    }
    return {
      rowCount: 1,
      rows: [{
        attempt_token: attemptToken,
        test_slug: 'term-test-1',
        class_name: 'IC2139',
        student_name: 'Học viên thử nghiệm',
        completed_at: new Date().toISOString(),
        combined_result: combinedResult
      }]
    };
  });
  const app = createApp({ config: makeConfig(), pool });
  const readingResponse = await request(app)
    .post('/api/term-tests/term-test-1/reading')
    .set('Origin', 'https://tranhoangduc90.github.io')
    .send({ attemptToken, answers: perfectAnswers() });
  assert.equal(readingResponse.status, 200);
  assert.equal(readingResponse.body.next, 'result');

  const resultResponse = await request(app)
    .post('/api/term-tests/result')
    .set('Origin', 'https://tranhoangduc90.github.io')
    .send({ attemptToken });
  assert.equal(resultResponse.status, 200);
  assert.equal(resultResponse.body.result.summary.totalCorrect, 80);
  assert.equal(resultResponse.body.studentName, 'Học viên thử nghiệm');
});
