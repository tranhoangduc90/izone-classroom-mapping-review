import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { explanationDefinitionSql } from '../src/teacher-answer-explanations.js';
import { listTermTestTeacherResultsSql } from '../src/sql.js';

// HTTP qua middleware đăng nhập thật của ứng dụng, với DB và nguồn giả trên máy local.
// Kiểm việc truyền phạm vi quyền, chọn đúng học viên và chặn kết quả đã thay đổi.
const canonical = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const studentRef = '11111111-1111-4111-8111-111111111111';
const otherRef = '22222222-2222-4222-8222-222222222222';
const completedAt = '2026-08-25T14:22:10.284374+00:00';
for (const slug of ['mini-test-lesson-5', 'term-test-2']) test(`${slug}: giảng viên xem lời giải đúng lớp/học viên qua cùng nguồn kết quả, không lộ token hoặc ghi điểm`, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'k67-teacher-explanations-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const definitions = { listening: { questions: [{ number: 11, accepted: ['A'] }] }, reading: { questions: [{ number: 14, accepted: ['v'] }] } };
  const definition = { test_slug: slug, definition_version: 1,
    listening_definition: definitions.listening, reading_definition: definitions.reading };
  const grade = answer => ({ listening: { details: [{ number: 11, studentAnswer: answer, correctAnswer: 'A', result: 'incorrect' }] },
    reading: { details: [{ number: 14, studentAnswer: 'v', correctAnswer: 'v', result: 'correct' }] } });
  const original = { test_slug: definition.test_slug, definition_version: 1, class_count: 1, authorized_class_count: 1, class_name: 'IC2238',
    students: [{ ref: studentRef, name: 'Tên trùng giả', completedAt, status: 'completed', result: grade('B') },
      { ref: otherRef, name: 'Tên trùng giả', completedAt, status: 'completed', result: grade('C') }] };
  const content = JSON.stringify({ baseTestSlug: definition.test_slug,
    listening: { sections: [{ range: 'Questions 11–11' }] }, reading: { sections: [{ range: 'Questions 14–14' }] } });
  const entry = (number, answer) => ({ number, section: 0, answers: [answer], evidence: [[{ text: 'Dẫn chứng giả' }]], blocks: [{ analysis: [[{ text: 'Lời giải giả' }]] }] });
  const bundle = { schemaVersion: 1, testSlug: definition.test_slug, definitionVersion: 1, contentSha256: hash(content),
    definitionSha256: hash(canonical(definitions)), skills: { listening: { entries: { 11: entry(11, 'A') } }, reading: { entries: { 14: entry(14, 'v') } } } };
  await fs.mkdir(path.join(root, definition.test_slug));
  await fs.writeFile(path.join(root, definition.test_slug, 'content.json'), content);
  const source = path.join(root, definition.test_slug, 'explanations.json');
  await fs.writeFile(source, JSON.stringify(bundle));
  let row = structuredClone(original), calls = [], syncCalls = 0, missingDefinition = false;
  const pool = { async query(sql, params) {
    if (sql.includes('FROM mapping.k67_context_state')) return { rows: [{ captured_at: new Date() }] };
    calls.push({ sql, params });
    if (sql === listTermTestTeacherResultsSql) return { rows: row ? [row] : [] };
    if (sql === explanationDefinitionSql) return { rows: missingDefinition ? [] : [definition] };
    throw Error('UNEXPECTED_QUERY');
  } };
  const app = createApp({ pool, syncErpGrades: async () => { syncCalls++; throw Error('Không ghi điểm'); },
    config: { nodeEnv: 'test', authMode: 'legacy', legacyReviewToken: 'teacher-fixture-only',
      allowedOrigins: new Set(['https://tranhoangduc90.github.io']), trustProxyHops: 0, termTestAssetDir: root } });
  const url = (ref = studentRef, extra = '') => `/api/term-tests/teacher/explanations?class=ic2238&test=${slug}&student=${ref}${extra}`;
  const get = (link = url()) => request(app).get(link).set('x-review-token', 'teacher-fixture-only');
  assert.equal((await request(app).get(url())).status, 401); assert.equal(calls.length, 0);
  for (const link of [url('invalid'), url(studentRef, '&completedAt=bad'), url().replace('ic2238', '%3Cscript%3E')]) {
    assert.equal((await get(link)).status, 400); assert.equal(calls.length, 0);
  }
  row.authorized_class_count = 0;
  const denied = await get(); assert.equal(denied.status, 403); assert.equal(denied.body.review, undefined);
  assert.equal(calls.some(c => c.sql === explanationDefinitionSql), false);
  assert.deepEqual(calls[0].params, ['IC2238', definition.test_slug, 'legacy@mapping.local', { source: 'legacy' }]);
  row = structuredClone(original); row.class_count = 2;
  assert.equal((await get()).status, 404);
  row = structuredClone(original); row.students[0].status = 'incomplete';
  assert.equal((await get()).status, 404);
  row = structuredClone(original);
  assert.equal((await get(url('33333333-3333-4333-8333-333333333333'))).status, 404);
  assert.equal((await get(url(studentRef, '&completedAt=2026-08-24T00:00:00Z'))).status, 409);
  const response = await get(url(otherRef, '&completedAt=' + encodeURIComponent(completedAt)));
  assert.equal(response.status, 200); assert.equal(response.body.review.identity.studentRef, otherRef);
  assert.equal(response.body.review.answers.listening['11'], 'C');
  assert.equal(response.body.review.result.listening.details[0].studentAnswer, 'C');
  assert.equal(response.headers['cache-control'], 'no-store, private');
  assert.doesNotMatch(JSON.stringify(response.body), /attemptToken|teacher-fixture-only|legacy@mapping.local/);
  missingDefinition = true; assert.equal((await get()).status, 404); missingDefinition = false;
  await fs.writeFile(source, JSON.stringify({ ...bundle, definitionVersion: 2 }));
  assert.equal((await get()).status, 409);
  await fs.unlink(source); assert.equal((await get()).status, 404);
  assert.equal((await get(url().replace(slug, 'substitute-test-1'))).status, 400);
  row = null; assert.equal((await get()).status, 404);
  assert.equal(syncCalls, 0);
});
