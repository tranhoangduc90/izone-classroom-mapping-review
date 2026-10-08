import { withTransaction } from './db.js';
import { LearningJobIdentityError } from './learning-outbox.js';

const normalize = row => row ? { targetSessionId: String(row.target_session_id),
  bindingRevision: Number(row.revision), scheduleFingerprint: row.schedule_fingerprint,
  writeStarted: row.write_started, reviewRequired: row.review_required } : null;

// Nhận job và lịch Portal đã đọc; khóa một phiếu, lưu đích chung và ý định trước lệnh ghi.
// Mọi lỗi định danh/lease dừng trước PUT. Transaction này không gọi mạng.
export function createAttendanceBindingStore(pool) {
  if (!pool) throw new Error('Điểm danh Portal cần kho liên kết PostgreSQL.');
  return {
    async read(assignmentId) {
      const result = await pool.query('SELECT * FROM learning.portal_attendance_binding WHERE assignment_id = $1::uuid', [assignmentId]);
      return normalize(result.rows[0]);
    },
    async reserve(job, payload, resolved) {
      return withTransaction(pool, async db => {
        const owned = await db.query(`SELECT id FROM learning.outbox_job WHERE id = $1::uuid
          AND worker_id = $2 AND attempt_count = $3 AND status = 'processing'
          AND lease_until > clock_timestamp() FOR UPDATE`, [job.id, job.workerId, job.attemptCount]);
        if (owned.rowCount !== 1) throw new LearningJobIdentityError('Job đã mất quyền giữ lượt xử lý.');
        const target = await db.query(`SELECT assignment.id FROM learning.form_assignment AS assignment
          JOIN learning.form_assignment_roster AS roster ON roster.assignment_id = assignment.id
          WHERE assignment.id = $1::uuid AND assignment.erp_course_class_id = $2::bigint
            AND assignment.session_number = $3 AND roster.student_ref = $4::uuid
            AND roster.erp_student_contact_id = $5::bigint FOR UPDATE OF assignment`,
        [payload.assignmentId, payload.classId, payload.sessionNumber, payload.studentRef, payload.studentId]);
        if (target.rowCount !== 1) throw new LearningJobIdentityError('Đích điểm danh không thuộc học viên/phiếu của lớp.');
        const found = await db.query('SELECT * FROM learning.portal_attendance_binding WHERE assignment_id = $1::uuid FOR UPDATE', [payload.assignmentId]);
        let binding = found.rows[0];
        const changed = binding && String(binding.target_session_id) !== resolved.resolvedSessionId;
        if (binding?.review_required || (changed && binding?.write_started)) {
          await db.query('UPDATE learning.portal_attendance_binding SET review_required = true, updated_at = now() WHERE assignment_id = $1::uuid', [payload.assignmentId]);
          return { ...normalize(binding), reviewRequired: true,
            canReadbackKnown: resolved.status === 'already_present' && resolved.targetSessionId === String(binding.target_session_id) };
        }
        if (!binding) {
          const legacy = await db.query('SELECT 1 FROM learning.portal_attendance_legacy_guard WHERE unit_key = $1', [job.unitKey]);
          if (legacy.rowCount) return { reviewRequired: true, targetSessionId: null,
            bindingRevision: null, reason: 'legacy_target_unverified' };
          const inserted = await db.query(`INSERT INTO learning.portal_attendance_binding
            (assignment_id, class_id, session_number, target_session_id, schedule_fingerprint)
            VALUES ($1::uuid, $2::bigint, $3, $4::bigint, $5) RETURNING *`,
          [payload.assignmentId, payload.classId, payload.sessionNumber, resolved.targetSessionId, resolved.scheduleFingerprint]);
          binding = inserted.rows[0];
        } else if (changed && !binding.write_started) {
          const updated = await db.query(`UPDATE learning.portal_attendance_binding
            SET target_session_id = $2::bigint, schedule_fingerprint = $3, revision = revision + 1, updated_at = now()
            WHERE assignment_id = $1::uuid RETURNING *`, [payload.assignmentId, resolved.resolvedSessionId, resolved.scheduleFingerprint]);
          binding = updated.rows[0];
        }
        if (resolved.targetSessionId !== String(binding.target_session_id)) {
          throw new LearningJobIdentityError('Đích đọc lại không khớp liên kết chung của phiếu.');
        }
        const priorOperation = await db.query('SELECT status FROM learning.portal_attendance_operation WHERE operation_key = $1', [job.operationKey]);
        if (priorOperation.rows[0]?.status === 'intent' && resolved.status === 'resolved') {
          // Timeout không chứng minh execution cũ đã dừng; chỉ đọc lại, không PUT lần hai.
          await db.query('UPDATE learning.portal_attendance_binding SET review_required = true WHERE assignment_id = $1::uuid', [payload.assignmentId]);
          return { ...normalize(binding), reviewRequired: true, reason: 'write_outcome_unknown' };
        }
        // Giữ liên kết sau bất kỳ ý định ghi: timeout không cho phép chọn buổi mới.
        await db.query(`UPDATE learning.portal_attendance_binding SET write_started = true,
          updated_at = now() WHERE assignment_id = $1::uuid`, [payload.assignmentId]);
        await db.query(`INSERT INTO learning.portal_attendance_operation
          (operation_key, assignment_id, student_ref, target_session_id, binding_revision, session_date, status)
          VALUES ($1, $2::uuid, $3::uuid, $4::bigint, $5, $6::date, 'intent')
          ON CONFLICT (operation_key) DO NOTHING`,
        [job.operationKey, payload.assignmentId, payload.studentRef, String(binding.target_session_id), Number(binding.revision), resolved.sessionDate]);
        const operation = await db.query('SELECT * FROM learning.portal_attendance_operation WHERE operation_key = $1', [job.operationKey]);
        const row = operation.rows[0];
        if (row.assignment_id !== payload.assignmentId || row.student_ref !== payload.studentRef
          || String(row.target_session_id) !== String(binding.target_session_id) || Number(row.binding_revision) !== Number(binding.revision)) {
          throw new LearningJobIdentityError('Ý định ghi cũ có định danh khác.');
        }
        return { ...normalize(binding), scheduleFingerprint: resolved.scheduleFingerprint, writeStarted: true };
      });
    },
    async record(job, payload, binding, output) {
      return withTransaction(pool, async db => {
      // Phản hồi cũ không được ghi đè kết quả của worker đang sở hữu lượt mới.
      const owned = await db.query(`SELECT id FROM learning.outbox_job WHERE id = $1::uuid
        AND worker_id = $2 AND attempt_count = $3 AND status = 'processing'
        AND lease_until > clock_timestamp() FOR UPDATE`, [job.id, job.workerId, job.attemptCount]);
      if (owned.rowCount !== 1) throw new LearningJobIdentityError('Job đã mất quyền ghi kết quả điểm danh.');
      const result = await db.query(`UPDATE learning.portal_attendance_operation
        SET status = $5, session_date = COALESCE($6::date, session_date),
          readback_at = CASE WHEN $5 IN ('synced', 'already_present') THEN clock_timestamp() ELSE NULL END,
          updated_at = now()
        WHERE operation_key = $1 AND assignment_id = $2::uuid AND target_session_id = $3::bigint
          AND binding_revision = $4 AND student_ref = $7::uuid RETURNING operation_key`,
      [job.operationKey, payload.assignmentId, binding.targetSessionId, binding.bindingRevision,
        output.status, output.sessionDate, payload.studentRef]);
      if (result.rowCount !== 1) throw new LearningJobIdentityError('Không lưu được kết quả tại đúng đích điểm danh.');
      if (output.status === 'target_changed' || output.scheduleChanged) {
        await db.query('UPDATE learning.portal_attendance_binding SET review_required = true WHERE assignment_id = $1::uuid', [payload.assignmentId]);
      }
      });
    }
  };
}
