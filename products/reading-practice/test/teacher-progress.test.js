import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { fixture } from './helpers.js';
import { createApp } from '../src/app.js';

const schema = 'reading_practice';
const identity = { email: 'teacher@example.test', google_subject: 'google-fixture' };

// Dữ liệu giả với SQL thật: bài chưa nộp phải xem được mà không sửa lease, giờ hay công việc Docs.
async function setup(t) {
  const f = await fixture();t.after(f.close);
  f.context.classes = async () => [{ id: '1124', classCode: 'FIXTURE 67' }];
  const app = createApp({ pool: f.pool, service: f.service, origins: ['https://page.test'],
    googleClientId: 'fixture', adminKey: 'fixture-admin-key',
    verifyGoogle: async () => ({ email: identity.email, sub: identity.google_subject, email_verified: true }) });
  const login = await request(app).post('/api/teacher/login').send({ credential: 'valid-google-fixture', remember: true });
  assert.equal(login.status, 200);
  const cookie = login.headers['set-cookie'].map(value => value.split(';')[0]).join('; ');
  return { ...f, app, cookie, reader: f.service.teacherProgress };
}

test('HTTP: GV xem lần đầu chưa nộp, giữ nguyên toàn bộ tiến trình và job Docs', async t => {
  const f = await setup(t), start = await f.begin(), attempt = start.attempts.at(-1);
  const draft = f.draft();draft.sequence = 1;draft.notes = 'Ghi chú bản đã lưu';
  draft.answers = { [Object.keys(f.content.key)[0]]: f.content.key[Object.keys(f.content.key)[0]][0] };
  await f.service.pulse({ token: f.token, attemptId: attempt.id, lease: start.lease, snapshot: draft });
  const before = (await f.pool.query(`SELECT state,updated_at FROM ${schema}.work`)).rows;
  const jobs = (await f.pool.query(`SELECT * FROM ${schema}.doc_job ORDER BY id`)).rows;
  const response = await request(f.app).get(`/api/teacher/progress/units/${start.identity.bindingId}`).set('Cookie', f.cookie);
  assert.equal(response.status, 200);assert.match(response.headers['cache-control'], /no-store/);
  assert.equal(response.body.attempts[0].status, 'running');
  assert.deepEqual(response.body.attempts[0].answers, draft.answers);
  assert.equal(response.body.attempts[0].notes, draft.notes);
  assert.equal(response.body.attempts[0].finalScore, undefined);
  assert.equal(response.body.key, undefined);
  assert.equal(response.body.definition.audio, undefined);
  assert.equal(response.body.attempts[0].lease, undefined);
  assert.equal(JSON.stringify(response.body).includes(start.lease.token), false);
  assert.deepEqual((await f.pool.query(`SELECT state,updated_at FROM ${schema}.work`)).rows, before);
  assert.deepEqual((await f.pool.query(`SELECT * FROM ${schema}.doc_job ORDER BY id`)).rows, jobs);
});

test('Danh sách có học viên chưa bắt đầu, không trả toàn bộ nội dung nháp', async t => {
  const f = await setup(t);
  const list = await f.reader.students({ classId: '1124', code: f.content.code }, identity);
  assert.equal(list.students.length, 1);
  assert.equal(list.students[0].units[0].status, 'not_started');
  assert.equal(list.students[0].units[0].answered, 0);
  assert.equal(list.students[0].answers, undefined);
  assert.equal((await f.pool.query(`SELECT count(*)::int AS n FROM ${schema}.work`)).rows[0].n, 0);
});

test('Link cá nhân chỉ xác định bài sau kiểm quyền, không dùng để cấp quyền', async t => {
  const f = await setup(t);
  const selected = await f.reader.entry({ entryToken: f.entryToken }, identity);
  assert.equal(selected.studentRef, f.studentRef);
  assert.equal(selected.id, f.registered.bindingId);
  f.setTeacher(false);
  await assert.rejects(f.reader.entry({ entryToken: f.entryToken }, identity), { code: 'ACCESS_DENIED' });
  await assert.rejects(f.reader.detail({ id: selected.id }, identity), { code: 'ACCESS_DENIED' });
});

test('HTTP: cookie riêng, query sai bị từ chối và quyền bị rút không được gia hạn', async t => {
  const f = await setup(t), base = '/api/teacher/progress';
  assert.equal((await request(f.app).get(base + '/classes').set('Cookie', f.cookie)).status, 200);
  assert.equal((await request(f.app).get(base + '/classes')).status, 401);
  assert.equal((await request(f.app).get(base + '/students').query({ classId: '1124', admin: 'true' }).set('Cookie', f.cookie)).status, 400);
  f.setTeacher(false);
  const denied = await request(f.app).get(base + '/students').query({ classId: '1124' }).set('Cookie', f.cookie);
  assert.equal(denied.status, 403);assert.equal(denied.headers['set-cookie'], undefined);
});
