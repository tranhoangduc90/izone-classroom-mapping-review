// Nhận định danh phiếu, đếm học viên nộp đủ và dùng đồng hồ database để quyết định nhận bài.
// Khóa phiếu trước phiên làm bài: các lần nộp đồng thời không vượt mốc người thứ ba.
export async function lockSubmissionAssignment(database, { attemptToken, publicToken }) {
  const result = await database.query(`SELECT assignment.id FROM learning.form_assignment AS assignment
    WHERE ${attemptToken ? `assignment.id = (SELECT assignment_id FROM learning.attempt WHERE attempt_token = $1::uuid)`
      : 'assignment.public_token = $1::uuid'} FOR UPDATE OF assignment;`, [attemptToken || publicToken]);
  return result.rows[0]?.id || null;
}

export async function refreshSubmissionDeadline(database, assignmentId) {
  await database.query(`WITH first_complete AS (
      SELECT student_ref, min(submitted_at) AS first_at FROM learning.submission
      WHERE assignment_id = $1::uuid AND completeness = 'complete' GROUP BY student_ref
    ), third AS (SELECT first_at FROM first_complete ORDER BY first_at, student_ref OFFSET 2 LIMIT 1)
    UPDATE learning.form_assignment AS assignment
    SET auto_submission_threshold_at = third.first_at,
      auto_submission_closes_at = (date_trunc('day', third.first_at AT TIME ZONE 'Asia/Ho_Chi_Minh')
        + interval '22 hours') AT TIME ZONE 'Asia/Ho_Chi_Minh'
    FROM third WHERE assignment.id = $1::uuid AND assignment.auto_submission_threshold_at IS NULL;`, [assignmentId]);
}

export async function readSubmissionWindow(database, assignmentId) {
  const result = await database.query(`SELECT status, opens_at, closes_at,
      auto_submission_threshold_at, auto_submission_closes_at, clock_timestamp() AS server_now,
      (SELECT count(DISTINCT student_ref) FROM learning.submission
        WHERE assignment_id = assignment.id AND completeness = 'complete') AS complete_students
    FROM learning.form_assignment AS assignment WHERE id = $1::uuid;`, [assignmentId]);
  const row = result.rows[0];
  if (!row) throw new Error('Không đọc được hạn nhận bài của phiếu.');
  return submissionWindowFromRow(row);
}

// Dữ liệu thời gian sai khiến phiếu đóng an toàn; giao diện nhận lý do rõ ràng.
export function submissionWindowFromRow(row) {
  const iso = value => value == null ? null : new Date(value).toISOString();
  try {
    const serverNow = iso(row.server_now);
    const manualClosesAt = iso(row.closes_at);
    const autoClosesAt = iso(row.auto_submission_closes_at);
    const thresholdAt = iso(row.auto_submission_threshold_at);
    const candidates = [manualClosesAt, autoClosesAt].filter(Boolean).sort();
    const effectiveClosesAt = candidates[0] || null;
    const reason = row.status !== 'published' ? 'assignment_closed'
      : row.opens_at && Date.parse(row.opens_at) > Date.parse(serverNow) ? 'not_open'
      : effectiveClosesAt && Date.parse(serverNow) >= Date.parse(effectiveClosesAt)
        ? (effectiveClosesAt === autoClosesAt ? 'three_students_cutoff' : 'manual_cutoff') : null;
    if (!serverNow || Boolean(thresholdAt) !== Boolean(autoClosesAt)) throw new Error('Mốc khóa không hợp lệ.');
    return { serverNow, completeStudents: Number(row.complete_students), thresholdAt,
      autoClosesAt, manualClosesAt, effectiveClosesAt, canSubmit: reason === null, reason };
  } catch {
    return { canSubmit: false, reason: 'deadline_invalid' };
  }
}
