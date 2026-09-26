import assert from 'node:assert/strict';
import test from 'node:test';
import { buildErpGradePayload, createErpGradeSync } from '../src/erp-sync.js';

const attemptToken = '00000000-0000-4000-8000-000000000226';

function payloadForSecondClass() {
  return buildErpGradePayload({
    attempt_token: attemptToken,
    test_slug: 'term-test-1-k56',
    class_id: '2002',
    student_id: '3002'
  }, {
    listening: { total: 40, correct: 31 },
    reading: { total: 26, correct: 20 }
  }, { writing: 6.5 });
}

function config() {
  return {
    k56PortalPilotEnabled: true,
    erpSyncUrl: 'https://example.invalid/k56-portal',
    erpSyncSecret: 'synthetic-secret',
    erpSyncTimeoutMs: 5_000
  };
}

test('K56 tạo điểm Portal cho lớp thứ hai nhưng giữ nguyên thang điểm từng Term', () => {
  assert.deepEqual(payloadForSecondClass().grades, {
    listening: 31,
    reading: 20,
    writing: 6.5
  });
  const invalid = buildErpGradePayload({
    attempt_token: attemptToken,
    test_slug: 'term-test-1-k56',
    class_id: '2002-other',
    student_id: '3002'
  }, { listening: { total: 40, correct: 31 } });
  assert.deepEqual(invalid.grades, {});
});

test('Term 2 K56 gửi số câu đúng trên thang 40/40, không đổi sang Band', () => {
  const payload = buildErpGradePayload({
    attempt_token: attemptToken,
    test_slug: 'term-test-2-k56',
    class_id: '2002',
    student_id: '3002'
  }, {
    listening: { total: 40, correct: 31, band: 7 },
    reading: { total: 40, correct: 28, band: 6.5 }
  }, { writing: 6.5 });
  assert.deepEqual(payload.grades, { listening: 31, reading: 28, writing: 6.5 });
});

test('Mini K56 giữ điểm thô và dùng cùng writer hiện hành với Term', async () => {
  const payload = buildErpGradePayload({
    attempt_token: attemptToken,
    test_slug: 'mini-test-k56',
    class_id: '2002',
    student_id: '3002'
  }, {
    listening: { total: 10, correct: 8 },
    reading: { total: 13, correct: 10 }
  });
  assert.deepEqual(payload.grades, { listening: 8, reading: 10 });
  const routes = [];
  const pool = {
    async query(sql) {
      if (sql.includes('term_test_class_access')) return { rows: [{ allowed: true }] };
      if (sql.includes('INSERT INTO assessment.term_test_portal_sync_state')) return { rowCount: 1 };
      return { rowCount: 1, rows: [] };
    }
  };
  const sync = createErpGradeSync({
    config: config(),
    pool,
    fetchImpl: async (url, options) => {
      routes.push({ url, testSlug: JSON.parse(options.body).testSlug });
      return { ok: true, status: 200, json: async () => ({
        ok: true, status: 'synced', attemptToken
      }) };
    },
    logger: { info() {}, error() {} }
  });
  assert.equal((await sync(payload)).status, 'synced');
  assert.equal((await sync(payloadForSecondClass())).status, 'synced');
  assert.deepEqual(routes, [
    { url: 'https://example.invalid/k56-portal', testSlug: 'mini-test-k56' },
    { url: 'https://example.invalid/k56-portal', testSlug: 'term-test-1-k56' }
  ]);
});

test('K56 không gọi Portal nếu cặp lớp–đề chưa được cấp quyền', async () => {
  let fetchCount = 0;
  const pool = {
    async query(sql) {
      assert.match(sql, /term_test_class_access/);
      return { rows: [{ allowed: false }] };
    }
  };
  const sync = createErpGradeSync({
    config: config(), pool,
    fetchImpl: async () => { fetchCount += 1; throw new Error('Không được gọi Portal'); }
  });
  assert.deepEqual(await sync(payloadForSecondClass()), { status: 'disabled' });
  assert.equal(fetchCount, 0);
});

test('K56 được cấp quyền chỉ gửi một lần cho cùng điểm/lượt thi', async () => {
  let fetchCount = 0;
  let claims = 0;
  const pool = {
    async query(sql, params) {
      if (sql.includes('term_test_class_access')) {
        assert.deepEqual(params, ['term-test-1-k56', '2002']);
        return { rows: [{ allowed: true }] };
      }
      if (sql.includes('INSERT INTO assessment.term_test_portal_sync_state')) {
        claims += 1;
        return { rowCount: claims === 1 ? 1 : 0 };
      }
      if (sql.includes('RETURNING status')) return { rows: [{ status: 'synced' }] };
      return { rows: [] };
    }
  };
  const sync = createErpGradeSync({
    config: config(), pool,
    fetchImpl: async (_url, options) => {
      fetchCount += 1;
      assert.equal(JSON.parse(options.body).classId, '2002');
      return { ok: true, status: 200, json: async () => ({
        ok: true, status: 'synced', attemptToken
      }) };
    },
    logger: { info() {}, error() {} }
  });
  const first = await sync(payloadForSecondClass());
  const replay = await sync(payloadForSecondClass());
  assert.equal(first.status, 'synced');
  assert.equal(replay.status, 'synced');
  assert.equal(replay.skipped, true);
  assert.equal(fetchCount, 1);
});

for (const scenario of [
  {
    name: 'timeout sau khi gửi',
    expectedStatus: 'unknown',
    expectedCode: 'ERP_SYNC_TIMEOUT',
    fetchImpl: async () => { throw new Error('Request timed out'); }
  },
  {
    name: 'Portal trả HTTP 503',
    expectedStatus: 'failed_response',
    expectedCode: 'ERP_SYNC_HTTP_ERROR',
    fetchImpl: async () => ({ ok: false, status: 503 })
  },
  {
    name: 'Portal trả sai mã lượt',
    expectedStatus: 'unknown',
    expectedCode: 'ERP_SYNC_INVALID_RESPONSE',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({
      ok: true, status: 'synced', attemptToken: '00000000-0000-4000-8000-000000000999'
    }) })
  }
]) {
  test(`K56 ${scenario.name}: giữ trạng thái cần đối soát và không gửi lại mù`, async () => {
    let fetchCount = 0;
    let claimCount = 0;
    let storedStatus = null;
    let storedCode = null;
    const pool = {
      async query(sql, params) {
        // Dữ liệu vào: truy vấn cấp quyền và trạng thái của một lượt thi giả.
        // Việc chính: mô phỏng claim duy nhất rồi lưu lỗi; lần gọi lại chỉ đọc trạng thái.
        // Kết quả: không có lần ghi Portal thứ hai; lỗi truy vấn làm test thất bại.
        if (sql.includes('term_test_class_access')) return { rows: [{ allowed: true }] };
        if (sql.includes('INSERT INTO assessment.term_test_portal_sync_state')) {
          claimCount += 1;
          return { rowCount: claimCount === 1 ? 1 : 0 };
        }
        if (sql.includes('UPDATE assessment.term_test_portal_sync_state') && sql.includes('RETURNING status')) {
          return { rows: [{ status: storedStatus }] };
        }
        if (sql.includes('UPDATE assessment.term_test_portal_sync_state')) {
          storedStatus = params[2];
          storedCode = params[4];
          return { rowCount: 1 };
        }
        throw new Error('Truy vấn ngoài hợp đồng thử nghiệm');
      }
    };
    const sync = createErpGradeSync({
      config: config(), pool,
      fetchImpl: async (...args) => {
        fetchCount += 1;
        return scenario.fetchImpl(...args);
      },
      logger: { info() {}, error() {} }
    });

    const first = await sync(payloadForSecondClass());
    const replay = await sync(payloadForSecondClass());
    assert.equal(first.status, scenario.expectedStatus);
    assert.equal(first.errorCode, scenario.expectedCode);
    assert.equal(storedStatus, scenario.expectedStatus);
    assert.equal(storedCode, scenario.expectedCode);
    assert.deepEqual(replay, { status: scenario.expectedStatus, skipped: true });
    assert.equal(fetchCount, 1);
  });
}
