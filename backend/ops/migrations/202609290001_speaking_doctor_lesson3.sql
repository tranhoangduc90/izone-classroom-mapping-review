-- Dữ liệu vào: biên nhận bài Speaking đã có đủ bốn link và danh mục bài luyện khóa 67.
-- Việc chính: lưu bằng chứng phân tích một lần cho mỗi biên nhận và bật phân tích Lesson 3.
-- Kết quả: worker có thể ghi đề xuất theo mã bài; khi lỗi giao dịch migration rollback toàn bộ.
CREATE TABLE IF NOT EXISTS speaking_homework.doctor_analysis (
  receipt_id UUID PRIMARY KEY REFERENCES speaking_homework.receipt(id),
  catalog_digest CHAR(64) NOT NULL,
  matches JSONB NOT NULL,
  analyzed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'speaking_homework_api') THEN
    GRANT SELECT, INSERT, UPDATE ON speaking_homework.doctor_analysis TO speaking_homework_api;
  END IF;
END $$;

UPDATE speaking_homework.assignment
SET doctor_course_key = '67'
WHERE assignment_code = '67-speaking-lam_ro'
  AND class_id = 2304
  AND doctor_course_key IS NULL;

-- Nếu học viên đã nộp trong lúc chờ phát hành, tạo việc phân tích đúng một lần.
INSERT INTO speaking_homework.outbox (receipt_id, kind)
SELECT r.id, 'doctor_analyze'
FROM speaking_homework.receipt r
JOIN speaking_homework.submission s ON s.id = r.submission_id
JOIN speaking_homework.access_grant g ON g.id = s.access_grant_id
JOIN speaking_homework.assignment a ON a.id = g.assignment_id
WHERE a.assignment_code = '67-speaking-lam_ro'
  AND a.class_id = 2304
  AND s.status = 'submitted'
ON CONFLICT (receipt_id, kind) DO NOTHING;
