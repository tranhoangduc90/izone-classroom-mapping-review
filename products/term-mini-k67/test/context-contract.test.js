import assert from 'node:assert/strict';
import test from 'node:test';
import request from 'supertest';
import { createContextSnapshot, parseContextSnapshot } from '../src/context-contract.js';
import { createContextSourceApp, readContextSnapshot } from '../src/context-source.js';
import { fetchContextSnapshot, applyContextSnapshot } from '../src/context-sync.js';
import { createApp } from '../src/app.js';
import { createContextGuard } from '../src/context-guard.js';
import { loadConfig } from '../src/config.js';

// Snapshot/HTTP giả kiểm hợp đồng và đường lỗi; quyền và transaction thật có suite PG riêng.
const now = Date.parse('2026-10-06T00:00:00.000Z');
function payload() {
  return { apiVersion: 1, productId: 'PRODUCT-TERM-MINI-K67',
    classes: [{ erp_course_class_id: '1124', erp_class_name_snapshot: 'K67SIM' }],
    students: [], memberships: [],
    accounts: [{ email: 'teacher@example.test', google_subject: null, display_name: 'Giáo viên mô phỏng',
      role: 'teacher', status: 'active', can_access_all_classes: false }],
    access: [{ reviewer_email: 'teacher@example.test', erp_course_class_id: '1124' }] };
}
test('Snapshot v1 đúng nguồn, phạm vi và UTC được nhận', () => {
  const snapshot = createContextSnapshot(payload(), now);
  assert.deepEqual(parseContextSnapshot(snapshot, now + 119999), snapshot);
});
test('Snapshot sai product/version, cột thừa hoặc lớp ngoài scope bị từ chối', () => {
  for (const change of [{ productId: 'PRODUCT-K56' }, { apiVersion: 2 }, { token_hash: 'không được nhận' },
    { classes: [{ erp_course_class_id: '9999', erp_class_name_snapshot: 'Lớp khác' }] }]) {
    assert.throws(() => createContextSnapshot({ ...payload(), ...change }, now));
  }
});
test('Snapshot trùng khóa hoặc grant không có account bị từ chối', () => {
  const p = payload();
  p.accounts.push(p.accounts[0]);
  assert.throws(() => createContextSnapshot(p, now), /CONTEXT_DUPLICATE/);
  const q = payload();
  q.access[0].reviewer_email = 'unlisted@example.test';
  assert.throws(() => createContextSnapshot(q, now), /CONTEXT_OUTSIDE_SCOPE/);
});
test('Snapshot thiếu offset, cũ, tương lai hoặc sửa nội dung mà không đổi hash bị từ chối', () => {
  const original = createContextSnapshot(payload(), now);
  for (const capturedAt of ['2026-10-06T00:00:00', '2026-10-05T23:57:59.999Z', '2026-10-06T00:00:05.001Z']) {
    assert.throws(() => parseContextSnapshot({ ...original, capturedAt }, now), /CONTEXT_INVALID_TIME/);
  }
  const changed = structuredClone(original);
  changed.accounts[0].can_access_all_classes = true;
  assert.throws(() => parseContextSnapshot(changed, now), /CONTEXT_REVISION_MISMATCH/);
});
test('Snapshot không hợp lệ không mở kết nối DB để ghi mirror', async () => {
  let connected = 0;
  const pool = { connect: async () => { connected++; throw new Error('Không được nối DB'); } };
  await assert.rejects(applyContextSnapshot(pool, { apiVersion: 2 }, now));
  assert.equal(connected, 0);
});
test('API nguồn kiểm khóa trước DB, không cache và không lộ lỗi SQL', async () => {
  let connected = 0;
  const app = createContextSourceApp({ secret: 'c'.repeat(32), pool: {
    connect: async () => { connected++; throw new Error('postgresql://private/password'); }
  } });
  await request(app).get('/v1/snapshot').set('x-k67-context-key', 'wrong').expect(401);
  assert.equal(connected, 0);
  const response = await request(app).get('/v1/snapshot').set('x-k67-context-key', 'c'.repeat(32)).expect(503);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(JSON.stringify(response.body).includes('password'), false);
  assert.equal(connected, 1);
});
test('Nguồn đọc đủ năm view trong cùng transaction chỉ đọc rồi commit', async () => {
  const calls = [];
  let released = false;
  const p = payload();
  const fields = ['classes', 'students', 'memberships', 'accounts', 'access'];
  const client = { query: async sql => {
    calls.push(sql);
    if (sql.includes('transaction_timestamp')) return { rows: [{ captured: new Date(now) }] };
    const field = fields.find(value => sql.includes(`k67_context_api_v1.${value} `));
    return { rows: field ? p[field] : [] };
  }, release: () => { released = true; } };
  const snapshot = await readContextSnapshot({ connect: async () => client });
  assert.equal(calls[0], 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.equal(calls.at(-1), 'COMMIT');
  assert.equal(calls.filter(sql => sql.includes('k67_context_api_v1.')).length, 5);
  assert.equal(released, true);
  assert.deepEqual(parseContextSnapshot(snapshot, now).classes, p.classes);
});
test('API mất nguồn, JSON sai hoặc response vượt 1 MiB không được nhận', async () => {
  for (const response of [new Response('{}', { status: 503 }), new Response('not-json'), new Response('x'.repeat(1048577))]) {
    await assert.rejects(fetchContextSnapshot({ url: 'https://example.test/snapshot', secret: 'c'.repeat(32),
      now, fetchImpl: async () => response }));
  }
});
test('API consumer dùng hạn 5 giây và không theo redirect mang theo khóa', async () => {
  const snapshot = createContextSnapshot(payload(), now);
  const actual = await fetchContextSnapshot({ url: 'https://example.test/snapshot', secret: 'c'.repeat(32), now,
    fetchImpl: async (_url, options) => {
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers['x-k67-context-key'], 'c'.repeat(32));
      assert.ok(options.signal instanceof AbortSignal);
      return new Response(JSON.stringify(snapshot));
    } });
  assert.deepEqual(actual, snapshot);
});
test('Guard chỉ mở khi snapshot có và còn hạn; nguồn lỗi không mở quyền', async () => {
  for (const captured of [null, new Date(now - 120001), new Date(now + 5001), 'invalid']) {
    let opened = false;
    let status;
    const guard = createContextGuard({ now: () => now, pool: { query: async () => ({ rows: captured ? [{ captured_at: captured }] : [] }) } });
    await guard({}, { status: value => { status = value; return { json: body => assert.equal(body.error, 'CONTEXT_UNAVAILABLE') }; } }, () => { opened = true; });
    assert.equal(status, 503);
    assert.equal(opened, false);
  }
  let opened = false;
  await createContextGuard({ now: () => now, pool: { query: async () => ({ rows: [{ captured_at: new Date(now) }] }) } })({}, {}, () => { opened = true; });
  assert.equal(opened, true);
});
test('HTTP nguồn quá cũ đóng roster/mở lượt/giáo viên nhưng không chặn route theo token', async () => {
  const config = loadConfig({ K67_ENV: 'test', K67_DATABASE_URL: 'postgresql://k67_app@localhost/term_mini_k67_test_boundary',
    K67_AUTH_MODE: 'legacy', K67_LEGACY_REVIEW_TOKEN: 'k67-fixture-token',
    K67_PUBLIC_API_BASE_URL: 'http://localhost/term-mini-k67-api', K67_ASSET_DIR: '/fixture',
    K67_SESSION_SECRET: 's'.repeat(32), K67_APP_VERSION: 'fixture', K67_BUILD_SHA: '1234567', K67_TRUST_PROXY_HOPS: 0 });
  const app = createApp({ config, pool: { query: async () => ({ rows: [] }) },
    termTestAssetService: { getTiming: () => ({}) } });
  await request(app).get('/api/term-tests/roster?class=K67SIM&test=term-test-1').expect(503);
  await request(app).post('/api/term-tests/term-test-1/session/prepare').send({}).expect(503);
  await request(app).get('/api/term-tests/teacher/options').set('x-review-token', 'k67-fixture-token').expect(503);
  // Body sai đi tới validation riêng (400), chứng minh không bị guard chặn (503).
  for (const path of ['listening/draft', 'listening', 'reading/draft', 'reading', 'session/resume-attempt']) {
    const response = await request(app).post(`/api/term-tests/term-test-1/${path}`).send({}).expect(400);
    assert.notEqual(response.body.error, 'CONTEXT_UNAVAILABLE');
  }
  await request(app).post('/api/term-tests/writing').send({}).expect(400);
  await request(app).post('/api/term-tests/result').send({}).expect(400);
});
