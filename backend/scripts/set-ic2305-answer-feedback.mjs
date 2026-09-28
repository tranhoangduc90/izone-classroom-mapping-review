/*
 * Dữ liệu nhận vào: LEARNING_DATABASE_URL, chính sách, người thực hiện và cờ --apply.
 * Việc chính: khóa và kiểm đúng bốn phiếu IC2305 khóa 56 trước khi đổi chính sách hiện đáp án.
 * Kết quả: chỉ cập nhật chính sách của bốn phiếu; giữ nguyên form, bài nộp và lượt làm.
 * Khi lỗi: transaction rollback, in mã lỗi an toàn; không in đáp án hoặc thông tin học viên.
 */

import pg from 'pg';

const assignments = new Map([
  [2, '5c37a820-00ee-489e-9e28-d38f2bacb80a'],
  [3, 'a4924d55-18ba-448c-9241-082297d93c60'],
  [4, 'eced2188-74e7-433f-bb58-21426976d46a'],
  [5, '7c4b9ee6-6850-42c0-bc64-5d20af9c4833']
]);
const apply = process.argv.includes('--apply');
const policy = process.argv.includes('--inherit') ? null : 'immediate';
const actor = process.argv.find(value => value.startsWith('--actor='))?.slice(8).trim() || '';

if (!apply) {
  process.stdout.write(`${JSON.stringify({ mode: 'plan', policy: policy ?? 'inherit',
    sessions: [...assignments.keys()], assignmentIds: [...assignments.values()] }, null, 2)}\n`);
  process.exit(0);
}
if (!process.env.LEARNING_DATABASE_URL) throw new Error('LEARNING_DATABASE_URL_REQUIRED');
if (!/^[\w.@+-]{2,100}$/.test(actor)) throw new Error('ACTOR_REQUIRED');

const pool = new pg.Pool({ connectionString: process.env.LEARNING_DATABASE_URL, max: 1 });
const client = await pool.connect();
try {
  await client.query('BEGIN');
  const result = await client.query(`SELECT assignment.id::text, assignment.course_code,
      assignment.class_name_snapshot, assignment.session_number, assignment.status,
      assignment.answer_release_override, version.public_definition,
      (SELECT count(*)::int FROM learning.attempt WHERE assignment_id = assignment.id) AS attempts,
      (SELECT count(*)::int FROM learning.submission WHERE assignment_id = assignment.id) AS submissions
    FROM learning.form_assignment AS assignment
    JOIN learning.form_version AS version ON version.id = assignment.form_version_id
    WHERE assignment.id = ANY($1::uuid[])
    ORDER BY assignment.session_number
    FOR UPDATE OF assignment`, [[...assignments.values()]]);
  if (result.rows.length !== assignments.size) throw new Error('ASSIGNMENT_SET_CHANGED');
  for (const row of result.rows) {
    const definition = row.public_definition;
    const scored = definition.blocks.flatMap(block => block.items).filter(item => item.maxScore > 0).length;
    if (row.id !== assignments.get(row.session_number) || row.course_code !== '56'
      || row.class_name_snapshot !== 'IC2305' || row.status !== 'published'
      || definition.answerReleasePolicy !== 'hidden' || scored < 1) {
      throw new Error('ASSIGNMENT_GUARD_FAILED');
    }
  }
  const before = result.rows.map(({ session_number, answer_release_override, attempts, submissions }) => ({
    session: session_number, policy: answer_release_override ?? 'inherit', attempts, submissions
  }));
  const updated = await client.query(`UPDATE learning.form_assignment
    SET answer_release_override = $1,
      answer_release_updated_at = now(), answer_release_updated_by = $2, updated_at = now()
    WHERE id = ANY($3::uuid[])
    RETURNING id::text, session_number, answer_release_override`, [policy, actor, [...assignments.values()]]);
  if (updated.rowCount !== assignments.size || updated.rows.some(row => row.id !== assignments.get(row.session_number)
    || row.answer_release_override !== policy)) throw new Error('POLICY_READBACK_FAILED');
  await client.query('COMMIT');
  process.stdout.write(`${JSON.stringify({ mode: 'applied', before,
    after: updated.rows.map(row => ({ session: row.session_number, policy: row.answer_release_override ?? 'inherit' })) }, null, 2)}\n`);
} catch (error) {
  await client.query('ROLLBACK');
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
