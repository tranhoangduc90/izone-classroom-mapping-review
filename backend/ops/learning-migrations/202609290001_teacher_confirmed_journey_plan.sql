-- Giảng viên xác nhận số buổi và vị trí các buổi Test cho cả lớp.
-- Journey dùng kế hoạch này để hiện ô buổi chưa có phiếu; không suy ra điểm hoặc ngày học.
CREATE TABLE IF NOT EXISTS learning.class_journey_plan (
  erp_course_class_id BIGINT PRIMARY KEY,
  total_sessions INTEGER NOT NULL CHECK (total_sessions BETWEEN 1 AND 100),
  test_session_numbers INTEGER[] NOT NULL DEFAULT ARRAY[]::integer[],
  test_sources JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(test_sources) = 'array'),
  session_dates JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(session_dates) = 'array'),
  revision INTEGER NOT NULL CHECK (revision > 0),
  confirmed_by_email TEXT NOT NULL,
  confirmed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON learning.class_journey_plan TO learning_api;
