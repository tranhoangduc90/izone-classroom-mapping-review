-- Dữ liệu vào: bài Speaking buổi 4 có hai bài bổ trợ bắt buộc và các lượt luyện thêm.
-- Việc chính: lưu ngưỡng nộp theo bài, mở rộng slot bổ trợ và tạo hàng phân tích lỗi.
-- Kết quả: biên nhận chỉ phát sau hai bài đạt; lượt luyện thêm có lịch sử riêng, có retry.
ALTER TABLE speaking_homework.assignment
  ADD COLUMN IF NOT EXISTS required_practice_count INTEGER NOT NULL DEFAULT 0
  CHECK (required_practice_count BETWEEN 0 AND 10);

ALTER TABLE speaking_homework.practice_link
  DROP CONSTRAINT IF EXISTS practice_link_slot_check;
ALTER TABLE speaking_homework.practice_link
  ADD CONSTRAINT practice_link_slot_check CHECK (slot >= 1);

CREATE TABLE IF NOT EXISTS speaking_homework.practice_analysis_job (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_link_id UUID NOT NULL UNIQUE REFERENCES speaking_homework.practice_link(id),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'done', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS practice_analysis_queue_idx
  ON speaking_homework.practice_analysis_job(created_at)
  WHERE status IN ('pending', 'failed');

CREATE TABLE IF NOT EXISTS speaking_homework.practice_analysis (
  practice_link_id UUID PRIMARY KEY REFERENCES speaking_homework.practice_link(id),
  catalog_digest CHAR(64) NOT NULL,
  matches JSONB NOT NULL,
  analyzed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'speaking_homework_api') THEN
    GRANT SELECT, INSERT, UPDATE ON speaking_homework.practice_analysis_job,
      speaking_homework.practice_analysis TO speaking_homework_api;
  END IF;
END $$;

-- Bài đã có trong Classroom sau này được đăng ký theo course_id/course_work_id thật.
-- Không gán mã bài vào Doc mẫu cũ hoặc tạo bài Classroom giả để tránh ghi nhầm học viên.
