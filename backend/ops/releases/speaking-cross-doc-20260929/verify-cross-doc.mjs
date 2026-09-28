import assert from 'node:assert/strict';
import pg from 'pg';
import { createSpeakingHomeworkService } from '/app/src/speaking-homework.js';

// Đầu vào: database Speaking production và hai học viên đã duyệt cùng lớp.
// Việc chính: thử mở bản Docs của một người bằng hồ sơ người kia trong transaction.
// Kết quả: xác nhận quyền và đúng docID, rồi rollback để không lưu dữ liệu thử.
const pool = new pg.Pool({
  connectionString: process.env.SPEAKING_HOMEWORK_DATABASE_URL,
  max: 1,
  application_name: 'speaking_cross_doc_release_check',
});
const client = await pool.connect();
try {
  await client.query('BEGIN');
  const candidates = await client.query(`
    SELECT d.document_id, d.student_ref AS owner_ref, m.public_id AS alternate_ref
    FROM speaking_homework.assignment_document d
    JOIN speaking_homework.assignment a ON a.id = d.assignment_id
    JOIN mapping.student_mapping_review m
      ON m.erp_course_class_id = a.class_id AND m.status = 'approved'
    WHERE a.assignment_code = '67-speaking-lam_ro'
      AND a.status = 'open' AND d.cta_verified_at IS NOT NULL
      AND d.student_ref IS NOT NULL AND m.public_id <> d.student_ref
      AND m.classroom_user_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM mapping.erp_class_membership_snapshot e
        WHERE e.erp_course_class_id = m.erp_course_class_id
          AND e.erp_student_contact_id = m.erp_student_contact_id
          AND lower(trim(coalesce(e.registration_status, ''))) NOT IN ('dropped', 'on_hold')
      )
    LIMIT 1`);
  assert.equal(candidates.rowCount, 1, 'Không tìm thấy hai hồ sơ lớp đã duyệt và bản Docs có CTA.');
  const sample = candidates.rows[0];
  const service = createSpeakingHomeworkService({
    pool: { query: (...args) => client.query(...args) },
    accessSecret: process.env.SPEAKING_HOMEWORK_ACCESS_SECRET,
  });
  const session = await service.startSession({
    documentId: sample.document_id,
    assignmentCode: '67-speaking-lam_ro',
    studentRef: sample.alternate_ref,
  });
  const grant = await service.resolveGrant(session.accessToken, sample.alternate_ref, client);
  assert.equal(grant.document_id, sample.document_id);
  assert.equal(session.studentRef, sample.alternate_ref);
  await client.query('ROLLBACK');
  console.log('cross_doc_transaction_passed data_rolled_back=true');
} catch (error) {
  await client.query('ROLLBACK');
  console.error('cross_doc_transaction_failed', error.code || error.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
