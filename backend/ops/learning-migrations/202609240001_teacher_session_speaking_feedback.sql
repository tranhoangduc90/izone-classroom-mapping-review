-- Dữ liệu nhận vào: nhận xét Speaking mà giảng viên gửi cho một học viên trong một phiếu.
-- Việc chính: giữ lịch sử từng lần gửi; bản có revision cao nhất là bản học viên nhìn thấy.
-- Kết quả: chỉ tài khoản API lớp học được đọc và thêm nhận xét, không sửa hoặc xóa lịch sử.
-- Khi lỗi: migration rollback; giảng viên vẫn thấy nhận xét cũ và có thể thử gửi lại.
CREATE TABLE IF NOT EXISTS learning.teacher_session_feedback (
  id UUID PRIMARY KEY,
  assignment_id UUID NOT NULL,
  student_ref UUID NOT NULL,
  skill_code TEXT NOT NULL CHECK (skill_code = 'speaking'),
  revision INTEGER NOT NULL CHECK (revision > 0),
  note_text TEXT NOT NULL CHECK (char_length(btrim(note_text)) BETWEEN 1 AND 500),
  sent_by_email TEXT NOT NULL,
  operation_id UUID NOT NULL UNIQUE,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (assignment_id, student_ref)
    REFERENCES learning.form_assignment_roster(assignment_id, student_ref),
  UNIQUE (assignment_id, student_ref, skill_code, revision)
);

CREATE INDEX IF NOT EXISTS teacher_session_feedback_latest
  ON learning.teacher_session_feedback (assignment_id, student_ref, skill_code, revision DESC);

GRANT SELECT, INSERT ON learning.teacher_session_feedback TO learning_api;
GRANT UPDATE (status, updated_at) ON learning.form_assignment TO learning_api;