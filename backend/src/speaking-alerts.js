import { randomUUID } from 'node:crypto';
import { withTransaction } from './db.js';
import { SpeakingHomeworkError } from './speaking-homework.js';

function classroomLink(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && url.hostname === 'classroom.google.com') return url.toString();
  } catch { /* Link rỗng hoặc sai sẽ bị chặn bên dưới. */ }
  throw new SpeakingHomeworkError('INVALID_CLASSROOM_LINK',
    'Classroom chưa trả link mở bài của học viên.', 400);
}

export function createSpeakingAlerts({ pool }) {
  // Dữ liệu vào: toàn bộ trạng thái nộp từ một bài Classroom đã mở.
  // Việc chính: chỉ giữ ca TURNED_IN thiếu biên nhận webapp, bỏ ca RETURNED.
  // Kết quả: các ca mới chờ một email gộp; lỗi mapping rollback cả lần quét.
  async function scan({ courseId, courseWorkId, submissions }) {
    return withTransaction(pool, async client => {
      const assignment = await client.query(`SELECT id, class_id, status
        FROM speaking_homework.assignment
        WHERE course_id = $1 AND course_work_id = $2 FOR UPDATE`, [courseId, courseWorkId]);
      if (assignment.rows.length !== 1) throw new SpeakingHomeworkError('ALERT_ASSIGNMENT_NOT_FOUND',
        'Bài Classroom chưa đăng ký trong Speaking Homework.', 404);
      const { id: assignmentId, class_id: classId, status } = assignment.rows[0];
      if (status !== 'open') return { enabled: false, pending: 0 };
      const turnedInIds = [];
      for (const submission of submissions) {
        if (submission.state !== 'TURNED_IN') continue;
        turnedInIds.push(submission.id);
        const student = await client.query(`SELECT m.public_id, m.erp_student_name_snapshot AS name
          FROM mapping.student_mapping_review m
          WHERE m.erp_course_class_id = $1 AND m.classroom_user_id = $2
            AND m.status = 'approved'`, [classId, submission.userId]);
        if (student.rows.length !== 1) throw new SpeakingHomeworkError('ALERT_STUDENT_UNMAPPED',
          'Có bài Classroom chưa ghép đúng học viên.', 409);
        const receipt = await client.query(`SELECT 1 FROM speaking_homework.receipt r
          JOIN speaking_homework.submission s ON s.id = r.submission_id
          JOIN speaking_homework.access_grant g ON g.id = s.access_grant_id
          WHERE g.assignment_id = $1 AND g.student_ref = $2 LIMIT 1`,
        [assignmentId, student.rows[0].public_id]);
        if (receipt.rows.length) continue;
        await client.query(`INSERT INTO speaking_homework.classroom_alert
          (assignment_id, classroom_submission_id, student_ref, classroom_url)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (assignment_id, classroom_submission_id)
          DO UPDATE SET classroom_url = EXCLUDED.classroom_url, updated_at = now(),
            status = CASE WHEN speaking_homework.classroom_alert.status = 'resolved'
              THEN 'pending' ELSE speaking_homework.classroom_alert.status END`,
        [assignmentId, submission.id, student.rows[0].public_id, classroomLink(submission.alternateLink)]);
      }
      // Bài đã trả lại, rút nộp hoặc đã có biên nhận không còn là cảnh báo chưa gửi.
      await client.query(`UPDATE speaking_homework.classroom_alert ca
        SET status = 'resolved', updated_at = now()
        WHERE ca.assignment_id = $1 AND ca.status = 'pending'
          AND (NOT (ca.classroom_submission_id = ANY($2::text[]))
            OR EXISTS (SELECT 1 FROM speaking_homework.receipt r
              JOIN speaking_homework.submission s ON s.id = r.submission_id
              JOIN speaking_homework.access_grant g ON g.id = s.access_grant_id
              WHERE g.assignment_id = ca.assignment_id AND g.student_ref = ca.student_ref))`,
      [assignmentId, turnedInIds]);
      const pending = await client.query(`SELECT count(*)::int AS count
        FROM speaking_homework.classroom_alert
        WHERE assignment_id = $1 AND status = 'pending'`, [assignmentId]);
      return { enabled: true, pending: pending.rows[0].count };
    });
  }

  // Dữ liệu vào: lần quét có ca mới. Việc chính: khóa các ca chưa gửi cùng một mã lô.
  // Kết quả: tối đa một email chứa tất cả ca trong lần chạy; lô đang gửi không tự gửi lại.
  async function claim({ courseId, courseWorkId }) {
    return withTransaction(pool, async client => {
      const found = await client.query(`SELECT ca.id, ca.classroom_url, ca.student_ref,
          m.erp_student_name_snapshot AS student_name
        FROM speaking_homework.classroom_alert ca
        JOIN speaking_homework.assignment a ON a.id = ca.assignment_id
        JOIN mapping.student_mapping_review m ON m.public_id = ca.student_ref
          AND m.erp_course_class_id = a.class_id
        WHERE a.course_id = $1 AND a.course_work_id = $2 AND a.status = 'open'
          AND ca.status = 'pending'
        ORDER BY ca.detected_at, ca.id FOR UPDATE OF ca SKIP LOCKED LIMIT 100`,
      [courseId, courseWorkId]);
      if (!found.rows.length) return null;
      const batchId = randomUUID();
      await client.query(`UPDATE speaking_homework.classroom_alert
        SET status = 'sending', batch_id = $2, updated_at = now()
        WHERE id = ANY($1::uuid[])`, [found.rows.map(row => row.id), batchId]);
      return { batchId, items: found.rows.map(row => ({
        studentName: row.student_name, classroomUrl: row.classroom_url
      })) };
    });
  }

  // Dữ liệu vào: mã lô sau khi Gmail báo gửi thành công.
  // Việc chính: chốt đã gửi đúng lô; khi thất bại, giữ trạng thái cần kiểm thủ công.
  // Kết quả: không gửi lặp trong lịch tiếp theo.
  async function acknowledge({ batchId }) {
    const result = await pool.query(`UPDATE speaking_homework.classroom_alert
      SET status = 'sent', sent_at = now(), updated_at = now()
      WHERE batch_id = $1 AND status = 'sending' RETURNING id`, [batchId]);
    if (!result.rows.length) throw new SpeakingHomeworkError('ALERT_BATCH_NOT_FOUND',
      'Không thấy lô email đang chờ xác nhận.', 404);
    return { sent: result.rows.length };
  }

  return { scan, claim, acknowledge };
}
