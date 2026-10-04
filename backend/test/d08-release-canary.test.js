// Dữ liệu giả vào: API/SQL thật trong app, UUID riêng và năm bảng child trống.
// Chạy cùng contract dùng sau phát hành; chấm/Portal chỉ là bộ đếm, không có mạng ngoài.
// Kết quả assertion gồm hai Task, revision, thời gian và child0; không thay cleanup production.
import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { PGlite } from '@electric-sql/pglite';
import { createApp } from '../src/app.js';
import { exerciseCanary } from '../ops/releases/writing-d08-20261003/canary_contract.mjs';

test('D08 release canary exercises actual HTTP + SQL and keeps all writers idle', async () => {
  const database = new PGlite();
  const id = '80808080-8080-4080-8080-808080808080';
  const tables = ['term_test_exam_session', 'term_test_writing_grading_run', 'term_test_writing_grading_final', 'term_test_writing_planning', 'term_test_portal_sync_job'];
  let gradingCalls = 0;
  let portalCalls = 0;
  try {
    await database.exec(`CREATE SCHEMA assessment;
      CREATE TABLE assessment.test_definition(slug text PRIMARY KEY,title text,version int);
      INSERT INTO assessment.test_definition VALUES('term-test-1','D08 giả',1);
      CREATE TABLE assessment.term_test_attempt(
        id uuid PRIMARY KEY,test_slug text,definition_version int,erp_course_class_id bigint,
        erp_student_contact_id bigint,class_name_snapshot text,student_name_snapshot text,
        exam_session_id uuid,listening_submitted_at timestamptz,listening_result jsonb,
        reading_started_at timestamptz,reading_deadline_at timestamptz,
        reading_draft_updated_at timestamptz,reading_submitted_at timestamptz,
        completed_at timestamptz,combined_result jsonb,
        writing_task_1 text NOT NULL DEFAULT '',writing_task_2 text NOT NULL DEFAULT '',
        writing_draft_revision bigint NOT NULL DEFAULT 0,
        writing_started_at timestamptz,writing_deadline_at timestamptz,
        writing_updated_at timestamptz,writing_submitted_at timestamptz,updated_at timestamptz DEFAULT now());
      INSERT INTO assessment.term_test_attempt(id,test_slug,definition_version,erp_course_class_id,
        erp_student_contact_id,class_name_snapshot,student_name_snapshot,
        listening_submitted_at,listening_result,completed_at,combined_result)
      VALUES('${id}','term-test-1',1,-808,-808,'D08 giả','D08 giả',now(),'{}',now(),'{}');`);
    for (const table of tables) await database.exec(`CREATE TABLE assessment.${table}(attempt_id uuid);`);
    const pool = { async query(sql, params) { const value = await database.query(sql, params); return { rows: value.rows, rowCount: value.rows.length }; } };
    const app = createApp({ config: { nodeEnv: 'test', authMode: 'legacy', legacyReviewToken: 'fixture-only', allowedOrigins: new Set(['https://tranhoangduc90.github.io']), trustProxyHops: 0 }, pool,
      termTestAssetService: { getTiming: () => ({ writingDurationMinutes: 60 }) },
      syncErpGrades: async () => { portalCalls++; },
      termTestWritingGradingService: { ensureSubmission: async () => { gradingCalls++; return { ready: false }; } } });
    const value = await exerciseCanary({ id,
      post: async payload => { const response = await request(app).post('/api/term-tests/writing').set('Origin','https://tranhoangduc90.github.io').send(payload); return { status: response.status, body: response.body }; },
      read: async () => {
        const row = (await database.query('SELECT * FROM assessment.term_test_attempt WHERE id=$1',[id])).rows[0];
        const children = {};
        for (const table of tables) children[table] = (await database.query(`SELECT count(*)::int n FROM assessment.${table} WHERE attempt_id=$1`,[id])).rows[0].n;
        return { task1: row.writing_task_1, task2: row.writing_task_2, revision: Number(row.writing_draft_revision), updatedAt: row.writing_updated_at?.toISOString(), submitted: row.writing_submitted_at !== null, children };
      } });
    assert.equal(value.status, 'passed');
    assert.equal(gradingCalls, 0);
    assert.equal(portalCalls, 0);
  } finally { await database.close(); }
});
