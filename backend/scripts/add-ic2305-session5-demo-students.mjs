/*
 * Dữ liệu nhận vào: phiếu buổi 5 demo và sáu hồ sơ giả của lớp demo có sẵn.
 * Việc chính: bổ sung năm tên dùng thử để nhiều giảng viên có thể thao tác độc lập.
 * Kết quả: một link demo có sáu hồ sơ giả, mỗi hồ sơ dùng được một lượt.
 * Khi lỗi: rollback; không thay roster hay bài nộp của lớp IC2305 thật.
 */
import pg from '/app/node_modules/pg/lib/index.js';

const assignmentId = '56000000-0000-4000-8d00-000000000005';
const baseRef = '21000000-0000-4000-8000-00000000000';
const expectedRefs = Array.from({ length: 6 }, (_, index) => `${baseRef}${index + 1}`);
const apply = process.argv.includes('--apply');
if (!apply) {
  process.stdout.write(`${JSON.stringify({ mode: 'plan', assignmentId,
    totalDemoStudents: 6, additionalStudents: 5, portalAttendance: 'disabled' })}\n`);
  process.exit(0);
}
if (!process.env.LEARNING_DATABASE_URL) throw new Error('LEARNING_DATABASE_URL_REQUIRED');

const pool = new pg.Pool({ connectionString: process.env.LEARNING_DATABASE_URL, max: 1 });
const client = await pool.connect();
try {
  await client.query('BEGIN');
  const assignment = await client.query(`SELECT id::text, course_code, erp_course_class_id::text AS class_id,
      class_name_snapshot, session_number, status
    FROM learning.form_assignment WHERE id = $1::uuid FOR UPDATE`, [assignmentId]);
  const row = assignment.rows[0];
  if (assignment.rowCount !== 1 || row.course_code !== 'DEMO-56'
    || row.class_id !== '990000567' || row.class_name_snapshot !== 'IC2305 · Bản dùng thử'
    || row.session_number !== 5 || row.status !== 'published') {
    throw new Error('DEMO_ASSIGNMENT_GUARD_FAILED');
  }
  const mapping = await client.query(`SELECT public_id::text AS student_ref,
      erp_student_contact_id::text AS student_id
    FROM mapping.student_mapping_review
    WHERE erp_course_class_id = 990000567 AND status = 'approved'
    ORDER BY public_id`);
  if (JSON.stringify(mapping.rows.map(item => item.student_ref)) !== JSON.stringify(expectedRefs)) {
    throw new Error('DEMO_CLASS_MAPPING_CHANGED');
  }
  const before = await client.query(`SELECT student_ref::text FROM learning.form_assignment_roster
    WHERE assignment_id = $1::uuid ORDER BY student_ref`, [assignmentId]);
  if (!before.rows.some(item => item.student_ref === expectedRefs[0])
    || before.rows.some(item => !expectedRefs.includes(item.student_ref))) {
    throw new Error('DEMO_ROSTER_GUARD_FAILED');
  }
  for (let index = 1; index < mapping.rows.length; index += 1) {
    await client.query(`INSERT INTO learning.form_assignment_roster
      (assignment_id, student_ref, erp_student_contact_id, student_name_snapshot, display_discriminator)
      VALUES ($1::uuid, $2::uuid, $3, $4, 'Lượt thử riêng')
      ON CONFLICT (assignment_id, student_ref) DO NOTHING`, [assignmentId,
      mapping.rows[index].student_ref, mapping.rows[index].student_id,
      `HỌC VIÊN DEMO ${index + 1}`]);
  }
  const after = await client.query(`SELECT student_ref::text FROM learning.form_assignment_roster
    WHERE assignment_id = $1::uuid ORDER BY student_ref`, [assignmentId]);
  if (JSON.stringify(after.rows.map(item => item.student_ref)) !== JSON.stringify(expectedRefs)) {
    throw new Error('DEMO_ROSTER_READBACK_FAILED');
  }
  await client.query('COMMIT');
  process.stdout.write(`${JSON.stringify({ mode: 'applied', before: before.rowCount,
    after: after.rowCount, realClassChanged: false })}\n`);
} catch (error) {
  await client.query('ROLLBACK');
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
