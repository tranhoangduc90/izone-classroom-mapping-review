// Dữ liệu nhận vào: ID phiếu cũ, phiếu mới và lớp đã xác thực.
// Việc chính: khóa phiếu cũ, kiểm đúng định danh rồi chuyển sang lưu trữ trong cùng transaction.
// Kết quả: link cũ ngừng mở, số bài nộp cũ giữ nguyên và trạng thái được đọc lại.
// Khi lỗi: ném lỗi để caller rollback toàn bộ, kể cả phiếu mới vừa tạo.

const OLD_FORM_VERSION_ID = '56000000-0000-4000-8000-000000000002';
const OLD_TITLE = 'ENTRANCE TICKET • READING 1 & LISTENING 1';

export async function retireReplacedIc2305Session4({ client, replacementAssignmentId,
  newAssignmentId, classId }) {
  const prior = await client.query(`SELECT old.id::text AS assignment_id,
      old.form_version_id::text AS form_version_id, old.erp_course_class_id::text AS class_id,
      old.session_number, old.title, old.status,
      (SELECT count(*)::int FROM learning.submission AS submission
        WHERE submission.assignment_id = old.id) AS submission_count
    FROM learning.form_assignment AS old
    WHERE old.id = $1::uuid FOR UPDATE;`, [replacementAssignmentId]);
  const previous = prior.rows[0];
  if (prior.rowCount !== 1 || previous.form_version_id !== OLD_FORM_VERSION_ID
    || previous.class_id !== String(classId) || Number(previous.session_number) !== 4
    || previous.title !== OLD_TITLE
    || !['published', 'retired'].includes(previous.status)
    || previous.assignment_id === newAssignmentId) {
    throw new Error('REPLACED_ASSIGNMENT_IDENTITY_MISMATCH');
  }
  if (previous.status === 'published') {
    const retired = await client.query(`UPDATE learning.form_assignment
      SET status = 'retired', updated_at = now()
      WHERE id = $1::uuid AND status = 'published' RETURNING id;`, [replacementAssignmentId]);
    if (retired.rowCount !== 1) throw new Error('REPLACEMENT_STATUS_CONFLICT');
  }
  const oldReadback = await client.query(`SELECT old.status,
      (SELECT count(*)::int FROM learning.submission AS submission
        WHERE submission.assignment_id = old.id) AS submission_count
    FROM learning.form_assignment AS old WHERE old.id = $1::uuid;`, [replacementAssignmentId]);
  if (oldReadback.rowCount !== 1 || oldReadback.rows[0].status !== 'retired'
    || Number(oldReadback.rows[0].submission_count) !== Number(previous.submission_count)) {
    throw new Error('REPLACEMENT_READBACK_MISMATCH');
  }
  return { previousAssignmentId: replacementAssignmentId,
    previousSubmissionCount: Number(previous.submission_count),
    previousStatus: 'retired', replayed: previous.status === 'retired' };
}
