import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createMiniFixture } from './helpers/mini-answer-sheet-fixture.js';

const guard = new URL('../db/041-term1-first-submission.sql', import.meta.url);
const state = async (db, studentId) => (await db.query(`SELECT id, reading_result, listening_result,
    term1_first_submission_guard, superseded_at
  FROM assessment.term_test_attempt
  WHERE test_slug='term-test-1' AND erp_student_contact_id=$1 ORDER BY id`, [studentId])).rows;

async function insertSubmission(db, studentId, { complete = false, score = 0, firstSkill = 'reading' } = {}) {
  const result = JSON.stringify({ score });
  return (await db.query(`INSERT INTO assessment.term_test_attempt
    (client_submission_id, test_slug, definition_version, erp_course_class_id, class_name_snapshot,
     erp_student_contact_id, student_name_snapshot, exam_mode, exam_delivery,
     reading_submitted_at, reading_answers, reading_result, listening_submitted_at, listening_answers,
     listening_result, combined_result, completed_at)
    VALUES($1, 'term-test-1', 1, 1293, 'IC2304', $2, 'Fixture',
      CASE WHEN $5 THEN 'read_first' ELSE 'lis_first' END, 'cbt',
      CASE WHEN $4 OR $5 THEN now() END,
      CASE WHEN $4 OR $5 THEN '{"14":"B"}'::jsonb END, CASE WHEN $4 OR $5 THEN $3::jsonb END,
      CASE WHEN $4 OR NOT $5 THEN now() END,
      CASE WHEN $4 OR NOT $5 THEN '{"11":"A"}'::jsonb END, CASE WHEN $4 OR NOT $5 THEN $3::jsonb END,
      CASE WHEN $4 THEN $3::jsonb END, CASE WHEN $4 THEN now() END)
    RETURNING id`, [randomUUID(), studentId, result, complete, firstSkill === 'reading'])).rows[0].id;
}

async function seedTerm1(db) {
  await db.query(`INSERT INTO assessment.test_definition
    (slug, title, version, listening_definition, reading_definition, is_active)
    SELECT 'term-test-1', 'Fixture Term 1', 1, listening_definition, reading_definition, true
    FROM assessment.test_definition WHERE slug='mini-test-lesson-5'`);
}

test('Term 1 keeps historical official data and rejects an additional official submission', async () => {
  const { db, pool } = await createMiniFixture({ examOrder: true, completeSchema: true });
  try {
    await seedTerm1(db);
    const legacyIds = [await insertSubmission(db, 900001, { complete: true }),
      await insertSubmission(db, 900001, { complete: true, score: 1 })];

    await db.exec(await readFile(guard, 'utf8'));
    const historical = await state(db, 900001);
    assert.deepEqual(historical.map(row => row.id).sort(), legacyIds.sort());
    assert.deepEqual(historical.map(row => row.reading_result.score).sort(), [0, 1]);
    assert.ok(historical.every(row => row.term1_first_submission_guard === false));
    await assert.rejects(insertSubmission(pool, 900001, { complete: true }), { code: 'P6741' });
    assert.deepEqual(await state(db, 900001), historical);

    const transaction = await pool.connect();
    try {
      await transaction.query('BEGIN');
      await insertSubmission(transaction, 900002);
      await transaction.query('ROLLBACK');
    } finally {
      transaction.release();
    }
    assert.deepEqual(await state(db, 900002), [], 'a rolled-back submission does not reserve the result');

    const first = await insertSubmission(pool, 900002);
    await assert.rejects(insertSubmission(pool, 900002, { complete: true, score: 2 }), { code: 'P6741' });
    const [winner] = await state(db, 900002);
    assert.equal(winner.id, first);
    assert.equal(winner.term1_first_submission_guard, true);
    assert.equal(winner.reading_result.score, 0);
    assert.equal((await state(db, 900002)).length, 1);
    await assert.rejects(pool.query(`UPDATE assessment.term_test_attempt
      SET reading_answers='{"14":"A"}' WHERE id=$1`, [first]), { code: 'P6742' });
    await pool.query(`UPDATE assessment.term_test_attempt
      SET listening_submitted_at=now(), listening_answers='{"11":"A"}', listening_result='{"score":1}',
        combined_result='{"score":1}', completed_at=now() WHERE id=$1`, [first]);
    const [completed] = await state(db, 900002);
    assert.deepEqual(completed.reading_result, { score: 0 });
    assert.deepEqual(completed.listening_result, { score: 1 });
    assert.equal(completed.id, first);

    await db.query('UPDATE assessment.term_test_attempt SET superseded_at=now() WHERE id=$1', [first]);
    const reopened = await insertSubmission(pool, 900002);
    assert.notEqual(reopened, first);
    assert.deepEqual((await state(db, 900002)).filter(row => row.superseded_at === null).map(row => row.id), [reopened]);
  } finally {
    await db.close();
  }
});

test('Term 1 concurrent Listening and Reading commits leave one official result', {
  skip: !process.env.K67_ORDER_NATIVE_URL,
}, async () => {
  const { db, pool } = await createMiniFixture({ examOrder: true, completeSchema: true });
  let first;
  let second;
  let competing;
  try {
    await seedTerm1(db);
    await db.exec(await readFile(guard, 'utf8'));
    // Isolate the submission guard while the old draft-ownership index still exists in production.
    await db.exec('DROP INDEX assessment.uq_term_test_attempt_one_active_student');
    first = await pool.connect();
    second = await pool.connect();
    const { pid } = (await second.query('SELECT pg_backend_pid() AS pid')).rows[0];
    await first.query('BEGIN');
    await second.query('BEGIN');
    await second.query("SET LOCAL statement_timeout = '6s'");

    const winner = await insertSubmission(first, 900001, { firstSkill: 'listening' });
    competing = insertSubmission(second, 900001).then(id => ({ id }), error => ({ error }));
    let waiting = false;
    for (let i = 0; i < 40 && !waiting; i++) {
      waiting = (await db.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [pid])).rows[0]?.wait_event_type === 'Lock';
      if (!waiting) await delay(50);
    }
    assert.ok(waiting, 'both transactions must overlap before the first commit');
    await first.query('COMMIT');
    const { error } = await competing;
    assert.equal(error?.code, '23505');
    assert.equal(error.constraint, 'uq_term1_new_official_attempt');
    await second.query('ROLLBACK');

    const results = await state(db, 900001);
    assert.equal(results.length, 1);
    assert.equal(results[0].id, winner);
    assert.deepEqual(results[0].listening_result, { score: 0 });
    assert.equal(results[0].reading_result, null);
  } finally {
    if (first) {
      await first.query('ROLLBACK');
      first.release();
    }
    if (second) {
      await competing;
      await second.query('ROLLBACK');
      second.release();
    }
    await db.close();
  }
});
