/*
 * Dữ liệu nhận vào: kết nối database của container API đang chạy.
 * Việc chính: đọc đúng phiếu IC2304 Buổi 2, roster và trạng thái các phần.
 * Kết quả: chỉ in mã đạt cùng số phần, không in tên hay bài học viên.
 * Khi lỗi: trả mã thoát khác 0 để lệnh triển khai khôi phục API cũ.
 */
import pg from 'pg';
import { IC2304_SESSION2_TEMPLATE } from '../src/learning-templates/ic2304-session2-listening-writing.js';
import { IC2304_SESSION2_SCORED } from '../src/learning-templates/ic2304-session2-scored.js';
import { IC2304_SESSION2_SPEAKING } from '../src/learning-templates/ic2304-session2-speaking.js';

if (!process.env.LEARNING_DATABASE_URL) throw new Error('LEARNING_DATABASE_URL_REQUIRED');
const pool = new pg.Pool({ connectionString: process.env.LEARNING_DATABASE_URL,
  max: 1, application_name: 'izone_ic2304_release_canary' });
try {
  const result = await pool.query(`SELECT assignment.course_code, assignment.form_version_id,
      (SELECT count(*)::int FROM learning.form_assignment_roster
        WHERE assignment_id = assignment.id) AS roster_count,
      (SELECT jsonb_agg(jsonb_build_object('checkpoint', checkpoint, 'status', status)
        ORDER BY checkpoint) FROM learning.assignment_block_release
        WHERE assignment_id = assignment.id) AS releases,
      EXISTS (SELECT 1 FROM mapping.reviewer_class_access AS access
        JOIN mapping.reviewer_account AS reviewer ON reviewer.email = access.reviewer_email
        WHERE access.erp_course_class_id = assignment.erp_course_class_id
          AND reviewer.status = 'active') AS has_reviewer
    FROM learning.form_assignment AS assignment
    WHERE upper(trim(assignment.class_name_snapshot)) = 'IC2304'
      AND assignment.session_number = 2 AND assignment.status = 'published';`);
  if (result.rowCount !== 1) throw new Error('ASSIGNMENT_NOT_UNIQUE');
  const row = result.rows[0];
  const versions = [IC2304_SESSION2_TEMPLATE.formVersionId,
    IC2304_SESSION2_SCORED.formVersionId, IC2304_SESSION2_SPEAKING.formVersionId];
  const expectedBlocks = row.form_version_id === IC2304_SESSION2_SPEAKING.formVersionId ? 3 : 2;
  if (row.course_code !== '67' || !versions.includes(row.form_version_id)
    || Number(row.roster_count) < 1 || !row.has_reviewer
    || row.releases?.length !== expectedBlocks
    || row.releases.some((release, index) => Number(release.checkpoint) !== index + 1
      || release.status !== (index === 0 ? 'open' : 'locked'))) {
    throw new Error('IC2304_RELEASE_STATE_MISMATCH');
  }
  process.stdout.write(`IC2304_CANARY_OK blocks=${expectedBlocks}\n`);
} catch (error) {
  process.stderr.write(`IC2304_CANARY_FAILED:${error.code || error.message || 'UNKNOWN'}\n`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
