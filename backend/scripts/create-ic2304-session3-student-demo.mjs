/*
 * Dữ liệu nhận vào: LEARNING_DATABASE_URL, người thực hiện và cờ --apply.
 * Việc chính: tạo một phiếu buổi 3 riêng với sáu hồ sơ học viên giả của lớp demo có sẵn.
 * Kết quả: link học viên dùng thử, sáu lượt riêng và ba phần mở sẵn; không thêm người giả vào lớp IC2304 thật.
 * Khi lỗi: transaction rollback; không in dữ liệu học viên thật hoặc connection string.
 */

import pg from 'pg';

const demoAssignmentId = '67000000-0000-4000-8d00-000000000003';
const demoClassId = 990000567;
const demoStudentRefs = Array.from({ length: 6 }, (_, index) =>
  `21000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`);
const apply = process.argv.includes('--apply');
const actor = process.argv.find(value => value.startsWith('--actor='))?.slice(8).trim() || '';
if (!apply) {
  process.stdout.write(`${JSON.stringify({ mode: 'plan', session: 3, class: 'IC2304 · Bản dùng thử',
    students: 6, assignmentId: demoAssignmentId, blocks: 'all open',
    portalAttendance: 'disabled for DEMO-67 / 990000567' }, null, 2)}\n`);
  process.exit(0);
}
if (!process.env.LEARNING_DATABASE_URL) throw new Error('LEARNING_DATABASE_URL_REQUIRED');
if (!/^[\w.@+-]{2,100}$/.test(actor)) throw new Error('ACTOR_REQUIRED');

const pool = new pg.Pool({ connectionString: process.env.LEARNING_DATABASE_URL, max: 1 });
const client = await pool.connect();
try {
  await client.query('BEGIN');
  const real = await client.query(`SELECT assignment.form_version_id::text, version.public_definition
    FROM learning.form_assignment AS assignment
    JOIN learning.form_version AS version ON version.id = assignment.form_version_id
    WHERE assignment.course_code = '67'
      AND assignment.class_name_snapshot = 'IC2304' AND assignment.session_number = 3
      AND assignment.status = 'published'`);
  if (real.rowCount !== 1) throw new Error('SOURCE_ASSIGNMENT_MISSING_OR_DUPLICATE');
  const blocks = real.rows[0].public_definition.blocks;
  if (blocks.length !== 3 || blocks.some(block => !block.blockId || !block.checkpoint)) {
    throw new Error('SOURCE_FORM_CHANGED');
  }
  const demoIdentity = await client.query(`SELECT student.public_id::text AS student_ref,
      student.erp_student_contact_id::text AS student_id
    FROM mapping.student_mapping_review AS student
    JOIN mapping.classroom_course_mapping AS demo_class
      ON demo_class.erp_course_class_id = student.erp_course_class_id
    WHERE student.erp_course_class_id = $1 AND student.status = 'approved'
      AND demo_class.erp_class_name_snapshot LIKE '[DEMO]%'
    ORDER BY student.public_id`, [demoClassId]);
  if (JSON.stringify(demoIdentity.rows.map(row => row.student_ref))
    !== JSON.stringify(demoStudentRefs)) throw new Error('DEMO_IDENTITIES_CHANGED');
  const inserted = await client.query(`INSERT INTO learning.form_assignment
    (id, form_version_id, course_code, erp_course_class_id, class_name_snapshot,
     session_number, title, status, created_by_email, answer_release_override,
     answer_release_updated_at, answer_release_updated_by)
    VALUES ($1::uuid, $2::uuid, 'DEMO-67', $3, 'IC2304 · Bản dùng thử', 3,
      'Buổi 3 - Reading, Writing và Speaking · Bản dùng thử', 'published', $4,
      'immediate', now(), $4)
    ON CONFLICT (id) DO NOTHING
    RETURNING public_token::text`,
  [demoAssignmentId, real.rows[0].form_version_id, demoClassId, actor]);
  if (inserted.rowCount === 1) {
    for (const [index, student] of demoIdentity.rows.entries()) {
      await client.query(`INSERT INTO learning.form_assignment_roster
        (assignment_id, student_ref, erp_student_contact_id, student_name_snapshot, display_discriminator)
        VALUES ($1::uuid, $2::uuid, $3, $4, 'Lượt thử riêng')`,
      [demoAssignmentId, student.student_ref, student.student_id,
        index === 0 ? 'HỌC VIÊN DEMO' : `HỌC VIÊN DEMO ${index + 1}`]);
    }
    for (const block of blocks) {
      await client.query(`INSERT INTO learning.assignment_block_release
        (assignment_id, block_id, checkpoint, status, release_version, updated_by_email, released_at)
        VALUES ($1::uuid, $2::uuid, $3, 'open', 1, $4, now())`,
      [demoAssignmentId, block.blockId, block.checkpoint, actor]);
    }
  }
  const readback = await client.query(`SELECT assignment.public_token::text,
      assignment.form_version_id::text, assignment.course_code,
      assignment.erp_course_class_id::text AS class_id, assignment.session_number,
      assignment.answer_release_override,
      (SELECT array_agg(student_ref::text ORDER BY student_ref::text)
        FROM learning.form_assignment_roster WHERE assignment_id = assignment.id) AS roster_refs,
      (SELECT array_agg(block_id::text ORDER BY block_id::text)
        FROM learning.assignment_block_release
        WHERE assignment_id = assignment.id AND status = 'open') AS open_block_ids
    FROM learning.form_assignment AS assignment WHERE assignment.id = $1::uuid`, [demoAssignmentId]);
  const row = readback.rows[0];
  if (readback.rowCount !== 1 || row.form_version_id !== real.rows[0].form_version_id
    || row.course_code !== 'DEMO-67' || row.answer_release_override !== 'immediate'
    || row.class_id !== String(demoClassId) || row.session_number !== 3
    || JSON.stringify(row.roster_refs) !== JSON.stringify(demoStudentRefs)
    || JSON.stringify(row.open_block_ids) !== JSON.stringify(blocks.map(block => block.blockId).sort())) {
    throw new Error('DEMO_READBACK_FAILED');
  }
  await client.query('COMMIT');
  process.stdout.write(`${JSON.stringify({ mode: inserted.rowCount ? 'created' : 'existing',
    students: 6, session: 3,
    studentUrl: `https://tranhoangduc90.github.io/izone-ai-team-pages/progress-log/#assignment=${row.public_token}` }, null, 2)}\n`);
} catch (error) {
  await client.query('ROLLBACK');
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
