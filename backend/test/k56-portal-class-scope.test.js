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

test('Phát hành Term K56 không tự chuyển Mini K56 sang Portal writer', () => {
  const payload = buildErpGradePayload({
    attempt_token: attemptToken,
    test_slug: 'mini-test-k56',
    class_id: '2002',
    student_id: '3002'
  }, {
    listening: { total: 10, correct: 8 },
    reading: { total: 13, correct: 10 }
  });
  assert.deepEqual(payload.grades, {});
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
