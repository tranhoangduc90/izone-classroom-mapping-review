-- Dữ liệu vào: lớp đã mapping và ba định nghĩa đề K56 hiện hành.
-- Việc chính: tạo quyền mở bài theo đúng cặp lớp–đề, mặc định đóng.
-- Kết quả: IC2264 đang phục vụ tiếp tục được mở; lớp K56 khác cần cấp quyền riêng.
-- Khi lỗi: transaction rollback; không sửa roster, bài nộp hoặc điểm.
BEGIN;

CREATE TABLE IF NOT EXISTS assessment.term_test_class_access (
  test_slug TEXT NOT NULL REFERENCES assessment.test_definition(slug),
  erp_course_class_id BIGINT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT false,
  source TEXT NOT NULL DEFAULT 'manual_review',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (test_slug, erp_course_class_id),
  CONSTRAINT term_test_class_access_k56_slug_check CHECK (right(test_slug, 4) = '-k56')
);

-- Chỉ giữ nguyên lớp pilot đang có. Chạy lại migration không bật lại quyền đã tắt.
INSERT INTO assessment.term_test_class_access (
  test_slug, erp_course_class_id, enabled, source
)
SELECT definition.slug, course.erp_course_class_id, true, 'existing_ic2264_pilot'
FROM assessment.test_definition AS definition
JOIN mapping.classroom_course_mapping AS course
  ON course.erp_course_class_id = 1252
 AND upper(trim(course.erp_class_name_snapshot)) = 'IC2264'
WHERE definition.slug IN ('term-test-1-k56', 'term-test-2-k56', 'mini-test-k56')
  AND definition.is_active = true
ON CONFLICT (test_slug, erp_course_class_id) DO NOTHING;

DO $permissions$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mapping_review_api') THEN
    GRANT SELECT ON assessment.term_test_class_access TO mapping_review_api;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mapping_app') THEN
    GRANT SELECT ON assessment.term_test_class_access TO mapping_app;
  END IF;
END
$permissions$;

COMMIT;
