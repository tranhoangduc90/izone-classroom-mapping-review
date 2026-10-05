import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import request from 'supertest';
import { createApp } from '../src/app.js';

const token = '00000000-0000-4000-8000-000000000808';
const origin = 'https://tranhoangduc90.github.io';
let database;
let pool;
let app;
let gradingCalls;

// Dữ liệu giả dùng SQL thật của API; adapter chỉ chuyển kết quả PGlite sang giao diện pg.
// PGlite nối tiếp các query, không thay bằng chứng race giữa nhiều kết nối PostgreSQL thật.
before(async () => {
  database = new PGlite();
  await database.exec(`
    CREATE SCHEMA assessment;
    CREATE TABLE assessment.test_definition (slug text PRIMARY KEY, title text, version int);
    INSERT INTO assessment.test_definition VALUES ('term-test-1', 'D08 giả', 1);
    CREATE TABLE assessment.term_test_attempt (
      id uuid PRIMARY KEY, test_slug text, definition_version int DEFAULT 1, erp_course_class_id bigint,
      erp_student_contact_id bigint, class_name_snapshot text, student_name_snapshot text,
      exam_session_id uuid, listening_submitted_at timestamptz, listening_result jsonb,
      reading_started_at timestamptz, reading_deadline_at timestamptz,
      reading_draft_updated_at timestamptz, reading_submitted_at timestamptz,
      completed_at timestamptz, combined_result jsonb,
      writing_task_1 text NOT NULL DEFAULT '', writing_task_2 text NOT NULL DEFAULT '',
      writing_draft_revision bigint NOT NULL DEFAULT 0 CHECK (writing_draft_revision >= 0),
      writing_started_at timestamptz, writing_deadline_at timestamptz,
      writing_updated_at timestamptz, writing_submitted_at timestamptz,
      updated_at timestamptz DEFAULT now()
    );
  `);
  pool = {
    async query(sql, params) {
      const result = await database.query(sql, params);
      return { rows: result.rows, rowCount: result.rows.length };
    }
  };
});
after(async () => database?.close());
beforeEach(async () => {
  await database.exec(`TRUNCATE assessment.term_test_attempt;
    INSERT INTO assessment.term_test_attempt (
      id, test_slug, erp_course_class_id, erp_student_contact_id,
      class_name_snapshot, student_name_snapshot, completed_at,
      listening_submitted_at, listening_result, combined_result
    ) VALUES ('${token}', 'term-test-1', -808, -808, 'D08 giả', 'D08 giả',
      now(), now(), '{}'::jsonb, '{}'::jsonb);`);
  gradingCalls = [];
  app = createApp({
    config: {
      nodeEnv: 'test', authMode: 'legacy', legacyReviewToken: 'test-only',
      allowedOrigins: new Set([origin]), trustProxyHops: 0
    },
    pool,
    termTestAssetService: {
      getTiming: () => ({ writingDurationMinutes: 60 }),
      getContent: async () => ({ writing: { tasks: [] } })
    },
    termTestWritingGradingService: {
      // Chỉ ghi nhận lời gọi chấm; quyết định lưu/xung đột hoàn toàn do SQL thật.
      async ensureSubmission(input) {
        gradingCalls.push(input);
        return { ready: false };
      }
    }
  });
});

function post({ action = 'draft', task1 = 'Bản mới Task 1', task2 = 'Bản mới Task 2', ...rest } = {}) {
  return request(app).post('/api/term-tests/writing').set('Origin', origin)
    .send({ attemptToken: token, action, task1, task2, ...rest });
}
async function stored() {
  return (await database.query('SELECT * FROM assessment.term_test_attempt WHERE id=$1', [token])).rows[0];
}
async function canonical({ expired = false, submitted = false, started = true } = {}) {
  await database.query(`UPDATE assessment.term_test_attempt
    SET writing_task_1='Bản mới Task 1', writing_task_2='Bản mới Task 2',
        writing_draft_revision=5,
        writing_started_at=CASE WHEN $1 THEN now()-interval '1 hour' ELSE NULL END,
        writing_updated_at=CASE WHEN $1 THEN now() ELSE NULL END,
        writing_deadline_at=CASE WHEN $1 THEN now() + $2::interval ELSE NULL END,
        writing_submitted_at=CASE WHEN $3 THEN now() ELSE NULL END
    WHERE id=$4`, [started, expired ? '-1 minute' : '1 hour', submitted, token]);
}

test('D08: stale base không ghi đè cả hai Task dù client gửi local revision lớn', async () => {
  await post({ baseRevision: 0, revision: 2 }).expect(200);
  const response = await post({ baseRevision: 0, revision: 999999, task1: 'Bản cũ 1', task2: 'Bản cũ 2' }).expect(200);
  const row = await stored();
  assert.equal(row.writing_task_1, 'Bản mới Task 1');
  assert.equal(row.writing_task_2, 'Bản mới Task 2');
  assert.equal(Number(row.writing_draft_revision), 1);
  assert.equal(response.body.writing.accepted, false);
  assert.equal(response.body.writing.reason, 'revision_conflict');
  assert.equal(response.body.writing.revision, 1);
  assert.equal(gradingCalls.length, 0);
});

test('retry đúng canonical với base cũ không tăng revision hoặc đổi timestamp', async () => {
  const first = await post({ baseRevision: 0 }).expect(200);
  const beforeRetry = await stored();
  const retry = await post({ baseRevision: 0 }).expect(200);
  const afterRetry = await stored();
  assert.equal(first.body.writing.revision, 1);
  assert.equal(retry.body.writing.revision, 1);
  assert.equal(retry.body.writing.accepted, true);
  assert.equal(retry.body.writing.reason, 'already_saved');
  assert.equal(String(afterRetry.writing_updated_at), String(beforeRetry.writing_updated_at));
});

test('hai tab cùng base chỉ nhận một nội dung; tab thua nhận canonical của tab thắng', async () => {
  const responses = await Promise.all([
    post({ baseRevision: 0, task1: 'Tab A1', task2: 'Tab A2' }),
    post({ baseRevision: 0, task1: 'Tab B1', task2: 'Tab B2' })
  ]);
  const accepted = responses.filter(response => response.body.writing?.accepted === true);
  const rejected = responses.filter(response => response.body.writing?.reason === 'revision_conflict');
  assert.equal(accepted.length, 1);
  assert.equal(rejected.length, 1);
  const row = await stored();
  assert.equal(Number(row.writing_draft_revision), 1);
  assert.equal(row.writing_task_1, accepted[0].body.writing.task1);
  assert.equal(row.writing_task_2, accepted[0].body.writing.task2);
  assert.equal(rejected[0].body.writing.task1, row.writing_task_1);
});

test('start chỉ khởi tạo giờ một lần và luôn giữ hai Task/version', async () => {
  await canonical({ started: false });
  const response = await post({ action: 'start', task1: 'Đè 1', task2: 'Đè 2' }).expect(200);
  const first = await stored();
  assert.equal(first.writing_task_1, 'Bản mới Task 1');
  assert.equal(first.writing_task_2, 'Bản mới Task 2');
  assert.equal(Number(first.writing_draft_revision), 5);
  assert.ok(first.writing_started_at);
  assert.ok(first.writing_deadline_at);
  assert.equal(response.body.writing.reason, 'started');
  await post({ action: 'start', task1: 'Đè lần hai 1', task2: 'Đè lần hai 2' }).expect(200);
  const second = await stored();
  assert.equal(String(second.writing_deadline_at), String(first.writing_deadline_at));
  assert.equal(String(second.writing_updated_at), String(first.writing_updated_at));
});

test('stale submit trước deadline không chốt sai bài và không gọi chấm', async () => {
  await canonical();
  const response = await post({ action: 'submit', baseRevision: 4, task1: 'Sai 1', task2: 'Sai 2' }).expect(200);
  const row = await stored();
  assert.equal(response.body.writing.accepted, false);
  assert.equal(response.body.writing.reason, 'revision_conflict');
  assert.equal(row.writing_submitted_at, null);
  assert.equal(row.writing_task_1, 'Bản mới Task 1');
  assert.equal(row.writing_task_2, 'Bản mới Task 2');
  assert.equal(gradingCalls.length, 0);
});

test('submit base đúng lưu và chốt hai Task cùng một revision, giao canonical để chấm', async () => {
  await canonical();
  const response = await post({ action: 'submit', baseRevision: 5, task1: 'Nộp 1', task2: 'Nộp 2' }).expect(200);
  const row = await stored();
  assert.equal(response.body.writing.accepted, true);
  assert.equal(response.body.writing.reason, 'saved');
  assert.equal(Number(row.writing_draft_revision), 6);
  assert.ok(row.writing_submitted_at);
  assert.equal(gradingCalls.length, 1);
  assert.equal(gradingCalls[0].task1, 'Nộp 1');
  assert.equal(gradingCalls[0].task2, 'Nộp 2');
});

test('submit hết deadline chốt canonical đã lưu, không nhận payload muộn dù thiếu base', async () => {
  await canonical({ expired: true });
  const response = await post({ action: 'submit', task1: 'Muộn 1', task2: 'Muộn 2' }).expect(200);
  const row = await stored();
  assert.equal(response.body.writing.reason, 'deadline_expired');
  assert.equal(response.body.writing.accepted, false);
  assert.equal(response.body.writing.task1, 'Bản mới Task 1');
  assert.equal(response.body.writing.task2, 'Bản mới Task 2');
  assert.equal(response.body.writing.submitted, true);
  assert.equal(row.writing_task_1, 'Bản mới Task 1');
  assert.equal(row.writing_task_2, 'Bản mới Task 2');
  assert.equal(Number(row.writing_draft_revision), 5);
  assert.ok(row.writing_submitted_at);
  assert.equal(gradingCalls.length, 1);
  assert.equal(gradingCalls[0].task1, 'Bản mới Task 1');
});

test('submit hết deadline đúng canonical được ACK mà không tăng revision', async () => {
  await canonical({ expired: true });
  const response = await post({ action: 'submit', baseRevision: 4 }).expect(200);
  const row = await stored();
  assert.equal(response.body.writing.accepted, true);
  assert.equal(response.body.writing.reason, 'deadline_expired');
  assert.equal(Number(row.writing_draft_revision), 5);
  assert.ok(row.writing_submitted_at);
  assert.equal(gradingCalls.length, 1);
  assert.equal(gradingCalls[0].task1, row.writing_task_1);
  assert.equal(gradingCalls[0].task2, row.writing_task_2);
});

test('draft muộn giữ canonical/version và không tự nộp bài', async () => {
  await canonical({ expired: true });
  const response = await post({ baseRevision: 5, task1: 'Muộn 1', task2: 'Muộn 2' }).expect(200);
  const row = await stored();
  assert.equal(response.body.writing.accepted, false);
  assert.equal(response.body.writing.reason, 'deadline_expired');
  assert.equal(row.writing_task_1, 'Bản mới Task 1');
  assert.equal(Number(row.writing_draft_revision), 5);
  assert.equal(row.writing_submitted_at, null);
  assert.equal(gradingCalls.length, 0);
});

test('bài đã nộp bất biến; khác payload bị từ chối, đúng canonical retry được', async () => {
  await canonical({ submitted: true });
  const original = await stored();
  const changed = await post({ action: 'submit', baseRevision: 5, task1: 'Khác 1', task2: 'Khác 2' }).expect(200);
  assert.equal(changed.body.writing.accepted, false);
  assert.equal(changed.body.writing.reason, 'already_submitted');
  assert.equal(gradingCalls.length, 0);
  const equal = await post({ action: 'submit', baseRevision: 5 }).expect(200);
  assert.equal(equal.body.writing.accepted, true);
  assert.equal(equal.body.writing.reason, 'already_submitted');
  assert.equal(gradingCalls.length, 1);
  assert.equal(gradingCalls[0].task1, original.writing_task_1);
  assert.equal(gradingCalls[0].task2, original.writing_task_2);
  assert.deepEqual(await stored(), original);
});

test('client thiếu base ở draft/submit trước deadline nhận 409 và không mutation', async () => {
  for (const action of ['draft', 'submit']) {
    const beforeRequest = await stored();
    const response = await post({ action }).expect(409);
    assert.equal(response.body.error, 'WRITING_CLIENT_UPDATE_REQUIRED');
    assert.deepEqual(await stored(), beforeRequest);
    assert.equal(gradingCalls.length, 0);
  }
});

test('baseRevision sai kiểu/phạm vi nhận 400 và không mutation', async () => {
  const beforeRequest = await stored();
  for (const baseRevision of [-1, 0.5, null, '0', Number.MAX_SAFE_INTEGER + 1]) {
    await post({ baseRevision }).expect(400);
    assert.deepEqual(await stored(), beforeRequest);
  }
  assert.equal(gradingCalls.length, 0);
});

test('result/khôi phục trả version đã lưu từ SQL chứ không mặc định bằng 0', async () => {
  await canonical();
  const response = await request(app).post('/api/term-tests/result').set('Origin', origin)
    .send({ attemptToken: token }).expect(200);
  assert.equal(response.body.writing.revision, 5);
  assert.equal(response.body.writing.task1, 'Bản mới Task 1');
  assert.equal(gradingCalls.length, 0);
});
