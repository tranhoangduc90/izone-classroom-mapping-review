-- Đầu vào: schema Speaking hiện hành; không chứa hồ sơ học viên.
-- Việc chính: thêm phạm vi lớp đã đối soát và mẫu bài dùng chung cho khóa 67.
-- Kết quả: API chỉ mở lớp có nguồn xác minh, đăng ký bài lặp không đổi lịch sử.
-- Khi lỗi: transaction rollback; giữ nguyên API cũ và kiểm thông báo psql.
BEGIN;
SET LOCAL application_name = 'mapping-git:issue-30';
SET LOCAL lock_timeout = '5s';
SELECT pg_advisory_xact_lock(hashtext('mapping_db_schema_migrations'));

CREATE TABLE speaking_homework.class_scope (
  class_id BIGINT PRIMARY KEY,
  class_code TEXT NOT NULL UNIQUE,
  course_key TEXT NOT NULL CHECK (course_key = '67'),
  active BOOLEAN NOT NULL DEFAULT false,
  source_key TEXT NOT NULL CHECK (length(source_key) >= 3),
  source_observed_at TIMESTAMPTZ NOT NULL,
  membership_observed_at TIMESTAMPTZ,
  membership_snapshot_hash TEXT CHECK (membership_snapshot_hash ~ '^[a-f0-9]{64}$'),
  verified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE speaking_homework.assignment_template (
  assignment_code TEXT PRIMARY KEY,
  course_key TEXT NOT NULL CHECK (course_key = '67'),
  page_path TEXT NOT NULL CHECK (page_path IN ('index.html', 'lesson-3.html', 'lesson-4.html')),
  title TEXT NOT NULL,
  doctor_course_key TEXT,
  required_practice_count INTEGER NOT NULL CHECK (required_practice_count BETWEEN 0 AND 2),
  parts JSONB NOT NULL CHECK (jsonb_typeof(parts) = 'array' AND jsonb_array_length(parts) BETWEEN 1 AND 8),
  active BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Chép cấu hình chuyên môn đã chạy, không chép bài làm hoặc thông tin học viên.
INSERT INTO speaking_homework.assignment_template
  (assignment_code, course_key, page_path, title, doctor_course_key, required_practice_count, parts)
SELECT a.assignment_code, '67',
  CASE a.assignment_code WHEN '67-speaking-paraphrase' THEN 'index.html'
    WHEN '67-speaking-lam_ro' THEN 'lesson-3.html' ELSE 'lesson-4.html' END,
  a.title, a.doctor_course_key, a.required_practice_count,
  jsonb_agg(jsonb_build_object('part_key', p.part_key, 'display_title', p.display_title,
    'practice_url', p.practice_url, 'min_questions', p.min_questions, 'position', p.position)
    ORDER BY p.position)
FROM speaking_homework.assignment a
JOIN mapping.classroom_course_mapping c ON c.erp_course_class_id = a.class_id
JOIN speaking_homework.assignment_part p ON p.assignment_id = a.id
WHERE c.erp_class_name_snapshot = 'IC2304' AND c.status = 'approved'
  AND a.status IN ('draft', 'open')
  AND a.assignment_code IN ('67-speaking-paraphrase', '67-speaking-lam_ro', '67-speaking-diem_giua')
GROUP BY a.id;

REVOKE ALL ON speaking_homework.class_scope, speaking_homework.assignment_template FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON speaking_homework.class_scope,
  speaking_homework.assignment_template TO speaking_homework_api;
-- API nội bộ đối soát lại đăng ký riêng khóa 67; không tạo/duyệt student mapping.
GRANT INSERT, UPDATE ON mapping.erp_class_membership_snapshot TO speaking_homework_api;
COMMIT;
