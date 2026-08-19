import assert from 'node:assert/strict';
import test from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { buildCombinedResult, buildListeningResult, gradeSection } from '../src/term-tests.js';

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

function makeMiniSection(numbers) {
  return {
    questions: numbers.map(number => ({
      number,
      type: number % 2 ? 'Matching' : 'Multiple choice',
      accepted: [`mini-${number}`]
    })),
    pairGroups: {}
  };
}

function miniAnswers(numbers) {
  return Object.fromEntries(numbers.map(number => [String(number), `mini-${number}`]));
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

test('kết quả Listening độc lập có đủ phân tích và chưa tính điểm trung bình hai kỹ năng', () => {
  const listening = gradeSection(makeSection(), perfectAnswers(), 0);
  const result = buildListeningResult(storedTestRow(), listening);
  assert.equal(result.listening.band, 9);
  assert.equal(result.reading, null);
  assert.equal(result.summary.totalCorrect, 40);
  assert.equal(result.summary.totalQuestions, 40);
  assert.equal(result.summary.averageBand, null);
  assert.ok(result.typeStats.length >= 2);
  assert.ok(result.performance.best.length >= 1);
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

test('chấm đúng phần Mini Test có số câu và số thứ tự không bắt đầu từ 1', () => {
  const listeningNumbers = Array.from({ length: 20 }, (_, index) => index + 11);
  const readingNumbers = Array.from({ length: 13 }, (_, index) => index + 14);
  const listening = gradeSection(makeMiniSection(listeningNumbers), miniAnswers(listeningNumbers), 0);
  const reading = gradeSection(makeMiniSection(readingNumbers), miniAnswers(readingNumbers), 0);
  const combined = buildCombinedResult(storedTestRow({
    test_slug: 'mini-test-lesson-5',
    test_title: 'Mini Test Buổi 5',
    listening_definition: makeMiniSection(listeningNumbers),
    reading_definition: makeMiniSection(readingNumbers)
  }), listening, reading);
  assert.equal(listening.total, 20);
  assert.equal(reading.total, 13);
  assert.equal(listening.converted, 40);
  assert.equal(reading.converted, 40);
  assert.equal(combined.summary.totalQuestions, 33);
  assert.equal(combined.summary.averageBand, 9);
});

test('dashboard giảng viên bắt buộc xác thực và truyền đúng phạm vi quyền lớp', async () => {
  const pool = makePool(async () => ({
    rowCount: 1,
    rows: [{
      test_slug: 'term-test-2',
      test_title: 'Term Test 2',
      definition_version: 1,
      class_count: 1,
      authorized_class_count: 1,
      class_id: '2139',
      class_name: 'IC2139',
      students: [{
        ref: '00000000-0000-4000-8000-000000000001',
        name: 'Học viên A',
        status: 'completed',
        completedAt: '2026-08-07T00:00:00.000Z',
        result: { listening: { band: 6.5 }, reading: { band: 6.5 }, summary: { averageBand: 6.5 } }
      }]
    }]
  }));
  const app = createApp({ config: makeConfig(), pool });

  const unauthorized = await request(app)
    .get('/api/term-tests/teacher/results?class=IC2139&test=term-test-2');
  assert.equal(unauthorized.status, 401);
  assert.equal(pool.calls.length, 0);

  const response = await request(app)
    .get('/api/term-tests/teacher/results?class=ic2139&test=term-test-2')
    .set('x-review-token', 'a-valid-test-token');
  assert.equal(response.status, 200);
  assert.equal(response.body.students[0].result.summary.averageBand, 6.5);
  assert.deepEqual(pool.calls[0].params, ['IC2139', 'term-test-2', 'legacy@mapping.local', true]);
  assert.equal(JSON.stringify(response.body).includes('attemptToken'), false);
});

test('nộp Listening trả ngay điểm, phân tích và chỉ đồng bộ Band Listening', async () => {
  const attemptToken = '00000000-0000-4000-8000-000000000099';
  const syncPayloads = [];
  const pool = makePool(async (_sql, params, callNumber) => {
    if (callNumber === 1) return { rowCount: 1, rows: [storedTestRow()] };
    return {
      rowCount: 1,
      rows: [{
        attempt_token: attemptToken,
        test_slug: 'term-test-1',
        class_id: '2139',
        student_id: '9001',
        student_name: 'Học viên thử nghiệm',
        listening_result: JSON.parse(params[8]),
        completed_at: null,
        combined_result: null
      }]
    };
  });
  const app = createApp({
    config: makeConfig(),
    pool,
    syncErpGrades: async payload => {
      syncPayloads.push(payload);
      return { status: 'synced' };
    }
  });
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
  assert.equal(response.body.completed, false);
  assert.equal(response.body.resultAvailable, true);
  assert.equal(response.body.portalSyncStatus, 'synced');
  assert.equal(response.body.result.listening.band, 9);
  assert.equal(response.body.result.reading, null);
  assert.equal(response.body.result.typeStats.length >= 2, true);
  assert.deepEqual(syncPayloads[0].grades, { listening: 9 });
  assert.equal(pool.calls.length, 2);
});

test('gửi lại cùng mã chỉ dùng kết quả Listening đã lưu, không dùng gói đáp án mới', async () => {
  const storedListening = gradeSection(makeSection(), perfectAnswers(), 0);
  const syncPayloads = [];
  const pool = makePool(async (_sql, _params, callNumber) => {
    if (callNumber === 1) return { rowCount: 1, rows: [storedTestRow()] };
    return {
      rowCount: 1,
      rows: [{
        attempt_token: '00000000-0000-4000-8000-000000000099',
        test_slug: 'term-test-1',
        class_id: '2139',
        student_id: '9001',
        student_name: 'Học viên thử nghiệm',
        listening_result: storedListening,
        completed_at: null,
        combined_result: null
      }]
    };
  });
  const app = createApp({
    config: makeConfig(),
    pool,
    syncErpGrades: async payload => {
      syncPayloads.push(payload);
      return { status: 'synced' };
    }
  });
  const response = await request(app)
    .post('/api/term-tests/term-test-1/listening')
    .set('Origin', 'https://tranhoangduc90.github.io')
    .send({
      classCode: 'IC2139',
      studentRef: '00000000-0000-4000-8000-000000000001',
      clientSubmissionId: '00000000-0000-4000-8000-000000000002',
      answers: {}
    });
  assert.equal(response.status, 201);
  assert.equal(response.body.result.listening.band, 9);
  assert.deepEqual(syncPayloads[0].grades, { listening: 9 });
});

test('lỗi Portal không làm mất kết quả Listening và lần mở kết quả sẽ thử đồng bộ lại', async () => {
  const listening = gradeSection(makeSection(), perfectAnswers(), 0);
  let syncCalls = 0;
  const pool = makePool(async (_sql, params, callNumber) => {
    if (callNumber === 1) return { rowCount: 1, rows: [storedTestRow()] };
    if (callNumber === 2) {
      return { rowCount: 1, rows: [{
        attempt_token: '00000000-0000-4000-8000-000000000099',
        test_slug: 'term-test-1',
        class_id: '2139',
        student_id: '9001',
        student_name: 'Học viên thử nghiệm',
        listening_result: JSON.parse(params[8]),
        completed_at: null,
        combined_result: null
      }] };
    }
    return { rowCount: 1, rows: [{
      attempt_token: '00000000-0000-4000-8000-000000000099',
      test_slug: 'term-test-1',
      test_title: 'Term Test 1',
      definition_version: 1,
      class_id: '2139',
      student_id: '9001',
      class_name: 'IC2139',
      student_name: 'Học viên thử nghiệm',
      listening_result: listening,
      completed_at: null,
      combined_result: null
    }] };
  });
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    const app = createApp({
      config: makeConfig(),
      pool,
      syncErpGrades: async () => {
        syncCalls += 1;
        if (syncCalls === 1) throw new Error('temporary');
        return { status: 'synced' };
      }
    });
    const listeningResponse = await request(app)
      .post('/api/term-tests/term-test-1/listening')
      .set('Origin', 'https://tranhoangduc90.github.io')
      .send({
        classCode: 'IC2139',
        studentRef: '00000000-0000-4000-8000-000000000001',
        clientSubmissionId: '00000000-0000-4000-8000-000000000002',
        answers: perfectAnswers()
      });
    assert.equal(listeningResponse.status, 201);
    assert.equal(listeningResponse.body.portalSyncStatus, 'pending');
    assert.equal(listeningResponse.body.result.listening.band, 9);

    const resultResponse = await request(app)
      .post('/api/term-tests/result')
      .set('Origin', 'https://tranhoangduc90.github.io')
      .send({ attemptToken: '00000000-0000-4000-8000-000000000099' });
    assert.equal(resultResponse.status, 200);
    assert.equal(resultResponse.body.completed, false);
    assert.equal(resultResponse.body.portalSyncStatus, 'synced');
    assert.equal(resultResponse.body.result.reading, null);
    assert.equal(syncCalls, 2);
  } finally {
    console.error = originalConsoleError;
  }
});

test('nộp Reading chấm cả hai phần và result chỉ mở bằng attempt token', async () => {
  const attemptToken = '00000000-0000-4000-8000-000000000099';
  const listening = gradeSection(makeSection(), perfectAnswers(), 0);
  let combinedResult;
  const syncPayloads = [];
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
        class_id: '2139',
        student_id: '9001',
        class_name: 'IC2139',
        student_name: 'Học viên thử nghiệm',
        completed_at: new Date().toISOString(),
        combined_result: combinedResult
      }]
    };
  });
  const app = createApp({
    config: makeConfig(),
    pool,
    syncErpGrades: async payload => {
      syncPayloads.push(payload);
      return { status: 'synced' };
    }
  });
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
  assert.equal(syncPayloads.length, 2);
  assert.deepEqual(syncPayloads[0].grades, { listening: 9, reading: 9 });
  assert.equal(syncPayloads[0].studentId, '9001');
});

test('Writing được lưu theo attempt token và trả lại nguyên văn khi mở kết quả', async () => {
  const attemptToken = '00000000-0000-4000-8000-000000000099';
  const submittedAt = '2026-08-19T04:00:00.000Z';
  const task1 = 'Nguyên văn bài Task 1 của học viên.';
  const task2 = 'Nguyên văn bài Task 2 của học viên.';
  const combinedResult = buildCombinedResult(
    storedTestRow(),
    gradeSection(makeSection(), perfectAnswers(), 0),
    gradeSection(makeSection(), perfectAnswers(), 0)
  );
  const pool = makePool(async (_sql, params, callNumber) => {
    if (callNumber === 1) {
      return {
        rowCount: 1,
        rows: [{
          attempt_token: attemptToken,
          writing_task_1: params[1],
          writing_task_2: params[2],
          writing_started_at: submittedAt,
          writing_updated_at: submittedAt,
          writing_submitted_at: params[3] === 'submit' ? submittedAt : null
        }]
      };
    }
    return {
      rowCount: 1,
      rows: [{
        attempt_token: attemptToken,
        test_slug: 'term-test-2',
        class_id: '2139',
        student_id: '9001',
        class_name: 'IC2139',
        student_name: 'Học viên thử nghiệm',
        completed_at: submittedAt,
        writing_task_1: task1,
        writing_task_2: task2,
        writing_started_at: submittedAt,
        writing_updated_at: submittedAt,
        writing_submitted_at: submittedAt,
        combined_result: combinedResult
      }]
    };
  });
  const app = createApp({ config: makeConfig(), pool });

  const saved = await request(app)
    .post('/api/term-tests/writing')
    .set('Origin', 'https://tranhoangduc90.github.io')
    .send({ attemptToken, action: 'submit', task1, task2 });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.writing, {
    task1,
    task2,
    started: true,
    submitted: true,
    deadlineAt: null,
    serverNow: null,
    timedOut: false,
    updatedAt: submittedAt,
    submittedAt
  });
  assert.deepEqual(pool.calls[0].params, [attemptToken, task1, task2, 'submit']);

  const result = await request(app)
    .post('/api/term-tests/result')
    .set('Origin', 'https://tranhoangduc90.github.io')
    .send({ attemptToken });
  assert.equal(result.status, 200);
  assert.equal(result.body.writing.task1, task1);
  assert.equal(result.body.writing.task2, task2);
  assert.equal(result.body.writing.submitted, true);
});

test('không lưu Writing nếu attempt token chưa có Reading hoàn chỉnh', async () => {
  const pool = makePool(async () => ({ rowCount: 0, rows: [] }));
  const app = createApp({ config: makeConfig(), pool });
  const response = await request(app)
    .post('/api/term-tests/writing')
    .set('Origin', 'https://tranhoangduc90.github.io')
    .send({
      attemptToken: '00000000-0000-4000-8000-000000000099',
      action: 'draft',
      task1: 'Task 1',
      task2: 'Task 2'
    });
  assert.equal(response.status, 404);
  assert.equal(response.body.error, 'WRITING_ATTEMPT_NOT_FOUND');
});

test('phòng chờ chỉ nhận đề và khóa audio sau khi máy chủ ghi nhận bắt đầu Listening', async () => {
  const examSessionToken = '00000000-0000-4000-8000-000000000088';
  const startedAt = '2026-08-19T04:00:00.000Z';
  const deadlineAt = '2026-08-19T04:32:44.000Z';
  const pool = makePool(async (_sql, _params, callNumber) => {
    if (callNumber === 1) return { rowCount: 1, rows: [storedTestRow()] };
    if (callNumber === 2) {
      return { rowCount: 1, rows: [{ exam_session_token: examSessionToken }] };
    }
    return {
      rowCount: 1,
      rows: [{
        exam_session_token: examSessionToken,
        student_name: 'Học viên thử nghiệm',
        listening_started_at: startedAt,
        listening_deadline_at: deadlineAt,
        server_now: startedAt,
        listening_submitted_at: null,
        attempt_token: null
      }]
    };
  });
  const termTestAssetService = {
    getTiming: () => ({ listeningDurationSeconds: 1844, listeningReviewSeconds: 120, listeningTotalSeconds: 1964 }),
    getContent: async () => ({ baseTestSlug: 'term-test-2', protected: true }),
    getSessionAudioKey: () => Buffer.alloc(32, 7)
  };
  const app = createApp({ config: makeConfig(), pool, termTestAssetService });
  const prepared = await request(app)
    .post('/api/term-tests/term-test-2/session/prepare')
    .set('Origin', 'https://tranhoangduc90.github.io')
    .send({
      classCode: 'IC2139',
      studentRef: '00000000-0000-4000-8000-000000000001'
    });
  assert.equal(prepared.status, 201);
  assert.equal(prepared.body.examSessionToken, examSessionToken);
  assert.equal(prepared.body.content, undefined);
  assert.equal(prepared.body.audioKey, undefined);
  assert.match(prepared.body.encryptedAudioUrl, /\/audio$/);
  assert.equal(pool.calls[1].params[6], 0);

  const started = await request(app)
    .post('/api/term-tests/term-test-2/session/start')
    .set('Origin', 'https://tranhoangduc90.github.io')
    .send({ examSessionToken });
  assert.equal(started.status, 200);
  assert.equal(started.body.content.protected, true);
  assert.equal(typeof started.body.audioKey, 'string');
  assert.equal(started.body.listeningDeadlineAt, deadlineAt);
  assert.equal(pool.calls[2].params[2], 1964);
});

test('lượt cũ đã nộp Listening mở lại nội dung mà không khởi động phiên Listening mới', async () => {
  const attemptToken = '00000000-0000-4000-8000-000000000099';
  const pool = makePool(async (_sql, _params, callNumber) => {
    if (callNumber === 1) return { rowCount: 1, rows: [storedTestRow()] };
    return {
      rowCount: 1,
      rows: [{
        attempt_token: attemptToken,
        exam_session_token: null,
        student_name: 'Học viên thử nghiệm',
        listening_submitted_at: '2026-08-19T04:00:00.000Z',
        reading_started_at: '2026-08-19T04:01:00.000Z',
        reading_deadline_at: '2026-08-19T05:01:00.000Z',
        completed_at: null,
        writing_started_at: null,
        writing_deadline_at: null,
        writing_submitted_at: null,
        listening_started_at: null,
        listening_deadline_at: null,
        server_now: '2026-08-19T04:05:00.000Z'
      }]
    };
  });
  const termTestAssetService = {
    getTiming: () => ({ listeningDurationSeconds: 1844, listeningReviewSeconds: 120, listeningTotalSeconds: 1964 }),
    getContent: async () => ({ baseTestSlug: 'term-test-2', protected: true })
  };
  const app = createApp({ config: makeConfig(), pool, termTestAssetService });
  const response = await request(app)
    .post('/api/term-tests/term-test-2/session/resume-attempt')
    .set('Origin', 'https://tranhoangduc90.github.io')
    .send({
      classCode: 'IC2139',
      studentRef: '00000000-0000-4000-8000-000000000001',
      attemptToken
    });
  assert.equal(response.status, 200);
  assert.equal(response.body.attemptToken, attemptToken);
  assert.equal(response.body.listeningSubmitted, true);
  assert.equal(response.body.readingDeadlineAt, '2026-08-19T05:01:00.000Z');
  assert.equal(response.body.content.protected, true);
  assert.equal(response.body.audioKey, undefined);
  assert.equal(pool.calls.length, 2);
});

test('Mini Test trả kết quả nhưng không ghi nhầm điểm vào Portal Term Test', async () => {
  const syncPayloads = [];
  const pool = makePool(async () => ({
    rowCount: 1,
    rows: [{
      attempt_token: '00000000-0000-4000-8000-000000000099',
      test_slug: 'mini-test-lesson-5',
      class_id: '2200',
      student_id: '9001',
      class_name: 'IC2200',
      student_name: 'Học viên thử nghiệm',
      completed_at: new Date().toISOString(),
      combined_result: { testSlug: 'mini-test-lesson-5', summary: { averageBand: 6.5 } }
    }]
  }));
  const app = createApp({
    config: makeConfig(),
    pool,
    syncErpGrades: async payload => {
      syncPayloads.push(payload);
      return { status: 'synced' };
    }
  });
  const response = await request(app)
    .post('/api/term-tests/result')
    .set('Origin', 'https://tranhoangduc90.github.io')
    .send({ attemptToken: '00000000-0000-4000-8000-000000000099' });
  assert.equal(response.status, 200);
  assert.equal(response.body.testSlug, 'mini-test-lesson-5');
  assert.equal(syncPayloads.length, 0);
});
