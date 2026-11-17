import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import { setTimeout as wait } from 'node:timers/promises';

const require = createRequire(process.env.TERM2_DEPS_PACKAGE);
const { Pool } = require('pg');
const local = 'postgresql://k67_fixture_admin@127.0.0.1:55468/postgres';
assert.equal(process.env.K67_ORDER_NATIVE_URL, local, 'Use the local synthetic PostgreSQL server.');
assert.equal(process.env.K67_ORDER_NATIVE_CONFIRM, 'local-synthetic-20261014');
const migration = await readFile(new URL('./parallel-attempts.sql', import.meta.url), 'utf8');
const slug = 'term-test-2-k56';

test('Term 2 K56 PostgreSQL keeps official answers and serializes two competing drafts', async () => {
  const pool = new Pool({ connectionString: local, max: 3 });
  const schema = 'term2_k56_fixture_' + randomUUID().replaceAll('-', '');
  const q = (executor, sql, values) => executor.query(sql.replaceAll('assessment.', schema + '.'), values);
  const session = async (testSlug, contact, parallel) => {
    const id = randomUUID();
    await q(pool, `INSERT INTO assessment.term_test_exam_session
      (id,test_slug,erp_student_contact_id,term2_parallel_entry) VALUES ($1,$2,$3,$4)`,
    [id, testSlug, contact, parallel]);
    return id;
  };
  const attempt = async (sessionId, contact) => {
    const id = randomUUID();
    await q(pool, `INSERT INTO assessment.term_test_attempt
      (id,test_slug,exam_session_id,erp_student_contact_id) VALUES ($1,$2,$3,$4)`,
    [id, slug, sessionId, contact]);
    return id;
  };
  let first, second;
  try {
    await pool.query('CREATE SCHEMA ' + schema);
    await q(pool, `
      CREATE TABLE assessment.term_test_exam_session (
        id uuid PRIMARY KEY, test_slug text NOT NULL, definition_version int DEFAULT 1,
        erp_course_class_id bigint DEFAULT 5601, erp_student_contact_id bigint NOT NULL,
        attempt_mode text DEFAULT 'cbt', generation bigint DEFAULT 0, listening_submitted_at timestamptz, superseded_at timestamptz
      );
      CREATE TABLE assessment.term_test_attempt (
        id uuid PRIMARY KEY, test_slug text NOT NULL, definition_version int DEFAULT 1,
        erp_course_class_id bigint DEFAULT 5601, erp_student_contact_id bigint NOT NULL, exam_session_id uuid,
        attempt_mode text DEFAULT 'cbt', generation bigint DEFAULT 0, completed_at timestamptz,
        superseded_at timestamptz, listening_interrupted_at timestamptz,
        listening_submitted_at timestamptz, listening_answers jsonb, reading_submitted_at timestamptz,
        reading_answers jsonb, writing_submitted_at timestamptz, writing_task_1 text
      );
      CREATE UNIQUE INDEX uq_term_test_exam_session_one_active_student ON assessment.term_test_exam_session
        (test_slug,definition_version,erp_course_class_id,erp_student_contact_id)
        WHERE listening_submitted_at IS NULL AND superseded_at IS NULL;
      CREATE UNIQUE INDEX uq_term_test_attempt_one_active_student ON assessment.term_test_attempt
        (test_slug,definition_version,erp_course_class_id,erp_student_contact_id)
        WHERE completed_at IS NULL AND superseded_at IS NULL;
    `);
    const previous = randomUUID();
    await q(pool, `INSERT INTO assessment.term_test_attempt
      (id,test_slug,erp_student_contact_id,reading_submitted_at,reading_answers) VALUES ($1,$2,5603,now(),'{"1":"old"}')`,
    [previous, slug]);
    await q(pool, migration);
    await assert.rejects(q(pool, `UPDATE assessment.term_test_attempt SET reading_answers='{"1":"new"}' WHERE id=$1`, [previous]),
      { code: 'P5652' });
    await session('term-test-1-k56', 5604, false);
    await assert.rejects(session('term-test-1-k56', 5604, false), { code: '23505' });
    const a = await attempt(await session(slug, 5602, true), 5602);
    const b = await attempt(await session(slug, 5602, true), 5602);
    first = await pool.connect();
    second = await pool.connect();
    await first.query('BEGIN');
    await second.query('BEGIN');
    await q(first, `UPDATE assessment.term_test_attempt SET reading_submitted_at=now(), reading_answers='{"1":"A"}' WHERE id=$1`, [a]);
    const rejected = assert.rejects(q(second,
      `UPDATE assessment.term_test_attempt SET listening_submitted_at=now(), listening_answers='{"1":"B"}' WHERE id=$1`, [b]),
    error => error.code === '23505' && error.constraint === 'uq_term2_k56_official_submission');
    let competing = false;
    for (let i = 0; i < 40 && !competing; i++) {
      const { rows: [activity] } = await pool.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [second.processID]);
      competing = activity?.wait_event_type === 'Lock';
      if (!competing) await wait(25);
    }
    assert.equal(competing, true);
    await first.query('COMMIT');
    await rejected;
    await second.query('ROLLBACK');
    const { rows } = await q(pool, `SELECT id, reading_answers FROM assessment.term_test_attempt
      WHERE term2_official_submission`);
    assert.deepEqual(rows, [{ id: a, reading_answers: { 1: 'A' } }]);
    const newDefinition = randomUUID();
    await q(pool, `INSERT INTO assessment.term_test_exam_session
      (id,test_slug,erp_student_contact_id,definition_version,term2_parallel_entry) VALUES ($1,$2,5602,2,true)`,
    [newDefinition, slug]);
    await assert.rejects(q(pool, `INSERT INTO assessment.term_test_attempt
      (id,test_slug,erp_student_contact_id,definition_version,exam_session_id,reading_submitted_at)
      VALUES ($1,$2,5602,2,$3,now())`, [randomUUID(), slug, newDefinition]),
    {code:'P5651'});
  } finally {
    if (first) { await first.query('ROLLBACK'); first.release(); }
    if (second) { await second.query('ROLLBACK'); second.release(); }
    await pool.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
    await pool.end();
  }
});
