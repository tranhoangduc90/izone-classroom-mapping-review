// Nhận đúng ngữ cảnh lượt làm đã khóa; lưu điểm danh và tác vụ từ checkpoint cùng giao dịch.
// Không gọi Portal ở đây. Khi DB lỗi, giao dịch nộp phần cũng rollback để không báo nhận giả.
export async function readCheckpointAttendance(database, assignmentId, studentRef) {
  const result = await database.query(`SELECT attendance.status,
    EXISTS (SELECT 1 FROM learning.outbox_job AS job
      WHERE job.job_type='sync_portal_attendance'
        AND job.entity_key='student:' || attendance.student_ref::text
        AND job.unit_key='portal-attendance:' || attendance.assignment_id::text || ':session:' || assignment.session_number::text
    ) AS portal_sync_queued
    FROM learning.attendance_record AS attendance
    JOIN learning.form_assignment AS assignment ON assignment.id=attendance.assignment_id
    WHERE attendance.assignment_id=$1::uuid AND attendance.student_ref=$2::uuid`, [assignmentId, studentRef]);
  return { status: result.rows[0]?.status || null, portalSyncQueued: result.rows[0]?.portal_sync_queued === true };
}

export async function recordCheckpointAttendance(database, context, checkpointSubmissionId, receivedAt) {
  const demo = ['DEMO-56', 'DEMO-67'].includes(context.course_code) && String(context.class_id) === '990000567';
  const result = await database.query(`WITH previous AS (
      SELECT status FROM learning.attendance_record
      WHERE assignment_id=$1::uuid AND student_ref=$2::uuid FOR UPDATE
    ), saved AS (
      INSERT INTO learning.attendance_record (assignment_id,student_ref,status,
        source_checkpoint_submission_id,current_reason,decided_at,updated_at)
      VALUES ($1::uuid,$2::uuid,'self_confirmed',$3::uuid,'Đã nộp phần đầu tiên.',$4::timestamptz,$4::timestamptz)
      ON CONFLICT (assignment_id,student_ref) DO UPDATE SET
        status=EXCLUDED.status,source_checkpoint_submission_id=EXCLUDED.source_checkpoint_submission_id,
        source_submission_id=NULL,current_reason=EXCLUDED.current_reason,
        decided_at=EXCLUDED.decided_at,updated_at=EXCLUDED.updated_at
      WHERE learning.attendance_record.status='pending_teacher'
        AND learning.attendance_record.decided_by_email IS NULL
      RETURNING assignment_id,student_ref
    ), event AS (
      INSERT INTO learning.attendance_event (assignment_id,student_ref,previous_status,new_status,
        source_checkpoint_submission_id,reason,actor_type,operation_key)
      SELECT saved.assignment_id,saved.student_ref,(SELECT status FROM previous),'self_confirmed',
        $3::uuid,'Đã nộp phần đầu tiên.','system','attendance-checkpoint:' || $3::text || ':v1'
      FROM saved RETURNING id
    ), job AS (
      INSERT INTO learning.outbox_job (job_type,entity_key,unit_key,operation_key,idempotency_key,payload)
      SELECT 'sync_portal_attendance','student:' || $2::text,
        'portal-attendance:' || $1::text || ':session:' || $7::int::text,
        'portal-attendance-checkpoint:' || $3::text || ':v1',
        'portal-attendance-checkpoint:' || $3::text || ':enqueue:v1',
        jsonb_build_object('schemaVersion','LearningPortalAttendanceCheckpointJobV1',
          'checkpointSubmissionId',$3::text,'assignmentId',$1::text,'studentRef',$2::text,
          'classId',$5::text,'studentId',$6::text,'sessionNumber',$7::int,'attendanceStatus','PRESENT')
      FROM event WHERE NOT $8::boolean
      RETURNING id
    ) SELECT EXISTS (SELECT 1 FROM saved) AS attendance_saved,
      EXISTS (SELECT 1 FROM event) AS event_saved, EXISTS (SELECT 1 FROM job) AS job_saved`,
  [context.assignment_id, context.student_ref, checkpointSubmissionId, receivedAt,
    context.class_id, context.student_id, Number(context.session_number), demo]);
  const saved = result.rows[0];
  if (!saved || saved.attendance_saved !== saved.event_saved || saved.job_saved !== (saved.attendance_saved && !demo)) {
    throw new Error('CHECKPOINT_ATTENDANCE_WRITE_INCOMPLETE');
  }
  return readCheckpointAttendance(database, context.assignment_id, context.student_ref);
}
