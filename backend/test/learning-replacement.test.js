import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { withTransaction } from '../src/db.js';
import { retireReplacedIc2305Session4 } from '../src/learning-replacement.js';

const oldId = '0607693f-8af9-4c1c-9f3e-09f894761381';
const newId = '56000000-0000-4000-8000-000000000099';

function poolFrom(database) {
  const query = async (sql, params) => {
    const result = await database.query(sql, params);
    return { ...result, rowCount: result.rowCount ?? result.rows.length };
  };
  return { query, async connect() { return { query, release() {} }; } };
}

async function databaseWithAssignments() {
  const database = new PGlite();
  await database.exec(`
    CREATE SCHEMA learning;
    CREATE TABLE learning.form_assignment (
      id UUID PRIMARY KEY, form_version_id UUID NOT NULL, erp_course_class_id BIGINT NOT NULL,
      session_number INTEGER NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE learning.submission (id UUID PRIMARY KEY, assignment_id UUID NOT NULL);
    INSERT INTO learning.form_assignment
      (id, form_version_id, erp_course_class_id, session_number, title, status)
    VALUES
      ('0607693f-8af9-4c1c-9f3e-09f894761381',
       '56000000-0000-4000-8000-000000000002', 1294, 4,
       'ENTRANCE TICKET • READING 1 & LISTENING 1', 'published'),
      ('56000000-0000-4000-8000-000000000099',
       '56000000-0000-4000-8000-000000000008', 1294, 4,
       'Buổi 4 - Listening 1 + Speaking 2', 'published');
    INSERT INTO learning.submission VALUES
      ('70000000-0000-4000-8000-000000000001', '0607693f-8af9-4c1c-9f3e-09f894761381');
  `);
  return database;
}

test('thay phiếu Buổi 4 giữ bài cũ, vô hiệu link cũ và gửi lặp an toàn', async () => {
  const database = await databaseWithAssignments();
  const pool = poolFrom(database);
  const first = await withTransaction(pool, client => retireReplacedIc2305Session4({
    client, replacementAssignmentId: oldId, newAssignmentId: newId, classId: '1294'
  }));
  assert.equal(first.previousSubmissionCount, 1);
  assert.equal(first.replayed, false);
  const replay = await withTransaction(pool, client => retireReplacedIc2305Session4({
    client, replacementAssignmentId: oldId, newAssignmentId: newId, classId: '1294'
  }));
  assert.equal(replay.replayed, true);
  const readback = await database.query(`SELECT old.status, new.status AS new_status,
      (SELECT count(*)::int FROM learning.submission WHERE assignment_id = $1::uuid) AS submissions
    FROM learning.form_assignment AS old, learning.form_assignment AS new
    WHERE old.id = $1::uuid AND new.id = $2::uuid;`, [oldId, newId]);
  assert.deepEqual(readback.rows[0], { status: 'retired', new_status: 'published', submissions: 1 });
  await database.close();
});

test('sai lớp hoặc nội dung phiếu cũ hủy transaction và giữ phiếu cũ mở', async () => {
  const database = await databaseWithAssignments();
  const pool = poolFrom(database);
  await assert.rejects(() => withTransaction(pool, client => retireReplacedIc2305Session4({
    client, replacementAssignmentId: oldId, newAssignmentId: newId, classId: '9999'
  })), /REPLACED_ASSIGNMENT_IDENTITY_MISMATCH/);
  const readback = await database.query(`SELECT status FROM learning.form_assignment WHERE id = $1::uuid;`, [oldId]);
  assert.equal(readback.rows[0].status, 'published');
  await database.close();
});
