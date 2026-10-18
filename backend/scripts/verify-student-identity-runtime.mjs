// Gọi HTTP qua toàn bộ app ráp từ source live, chỉ thay database bằng pool giả.
// Cấm fetch và từ chối mọi SQL ngoài hai SELECT nhận diện/ngữ cảnh; không chạy server.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import request from 'supertest';
if (!process.env.IDENTITY_RUNTIME_CANDIDATES) throw new Error('Cần IDENTITY_RUNTIME_CANDIDATES trỏ tới bản thử riêng.');
globalThis.fetch = () => Promise.reject(new Error('LIVE_NETWORK_FORBIDDEN'));
const root = path.resolve(process.env.IDENTITY_RUNTIME_CANDIDATES);
const origin = 'https://tranhoangduc90.github.io';
const identity = { authority: 'erp-contact', id: '12345' };
const row = { person_id: '12345', student_ref: '11111111-1111-4111-8111-111111111111',
  class_id: '111', class_code: 'IC2264', student_name: 'Học viên thử' };
const digest = value => createHash('sha256').update(value).digest('hex');
for (const [runtime, family, route] of [
  ['mapping-review-api', 'mapping', '/api/student-identity/resolve'],
  ['izone-k56-ic2264-api', 'k56', '/api/term-tests/term-test-1-k56/student-identity'],
  ['term-mini-k67-api', 'k67', '/api/term-tests/term-test-1/student-identity']
]) {
  const directory = path.join(root, runtime);
  const proof = JSON.parse(await readFile(path.join(directory, 'identity-runtime-proof.json'), 'utf8'));
  assert.equal(proof.family, family);
  assert.equal(digest(await readFile(path.join(directory, 'src/app.js'))), proof.afterAppSha);
  const ownModule = await readFile(path.join(directory, 'src/student-identity.js'));
  assert.equal(digest(ownModule), proof.moduleSha);
  assert.deepEqual(ownModule, await readFile(new URL('../src/student-identity.js', import.meta.url)));
  const { createApp } = await import(pathToFileURL(path.join(directory, 'src/app.js')).href);
  async function fixture({ stale = false, offline = false } = {}) {
    const calls = [];
    let pool = { query: async (sql, params) => {
      calls.push({ sql, params });
      assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|ALTER|TRUNCATE)\b/i);
      if (sql.includes('k67_context_state')) return { rows: [{ captured_at: new Date(Date.now() - (stale ? 300000 : 0)) }] };
      assert.match(sql, /AS person_id/);
      if (offline) throw new Error('FIXTURE_SOURCE_OFFLINE');
      return { rows: [row] };
    } };
    if (family === 'k56') {
      const { createAssessmentSchemaPool } = await import(pathToFileURL(path.join(directory, 'src/assessment-schema-pool.js')).href);
      pool = createAssessmentSchemaPool(pool, { family: 'k56' });
    }
    const app = createApp({ pool, config: { nodeEnv: 'test', authMode: 'legacy', legacyReviewToken: 'fixture-only',
      allowedOrigins: new Set([origin]), trustProxyHops: 0,
      ...(family === 'k56' ? { deploymentProfileName: 'k56-ic2264' } : {}) },
    logger: { info() {}, error() {}, warn() {} } });
    return { app, calls };
  }
  test(`Runtime ${family}: source live giữ nguyên, HTTP trả người đúng qua middleware thật`, async () => {
    const f = await fixture();
    const response = await request(f.app).post(route).set('Origin', origin).send({ identity, classCode: 'IC2264' });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual(response.body.identity, identity);
    assert.equal(response.body.aliases[0].studentRef, row.student_ref);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['access-control-allow-origin'], origin);
    assert.equal(f.calls.length, family === 'k67' ? 2 : 1);
    const sql = f.calls.at(-1).sql;
    if (family === 'k56') { assert.match(sql, /assessment_k56\.term_test_roster/); assert.doesNotMatch(sql, /\bassessment\./); }
    assert.equal(Object.keys(response.body).some(key => /session|attempt|token/i.test(key)), false);
  });
  test(`Runtime ${family}: origin ngoài phạm vi và input sai không được truy vấn người`, async () => {
    const f = await fixture();
    assert.equal((await request(f.app).post(route).set('Origin', 'https://outside.invalid').send({ identity })).status, 403);
    assert.equal(f.calls.length, 0);
    assert.equal((await request(f.app).post(route).send({ identity: { ...identity, id: '-1' } })).status, 400);
    assert.equal(f.calls.filter(call => /AS person_id/.test(call.sql)).length, 0);
  });
  test(`Runtime ${family}: lỗi nguồn giữ HTTP lỗi, không giả missing`, async () => {
    const f = await fixture({ offline: true });
    const response = await request(f.app).post(route).send({ identity });
    assert.equal(response.status, 500); assert.equal(response.body.status, undefined);
  });
  if (family === 'k67') test('Runtime K67 thật giữ guard dữ liệu quá cũ trước bước nhận diện', async () => {
    const f = await fixture({ stale: true });
    const response = await request(f.app).post(route).send({ identity });
    assert.equal(response.status, 503); assert.equal(response.body.error, 'CONTEXT_UNAVAILABLE');
    assert.equal(f.calls.length, 1);
  });
}
