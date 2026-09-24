-- Dữ liệu vào: ba định nghĩa đề K56 và danh sách lớp ERP đã đối soát.
-- Việc chính: tạo cổng mở bài theo từng cặp lớp–đề, mặc định đóng.
-- Kết quả: migration không tự mở lớp, kể cả pilot IC2264; bước phát hành
-- chỉ bật sau khi đã nhập roster và đọc lại đúng từng cặp lớp–đề.
-- Khi lỗi: giao dịch rollback, không chạm schema assessment của K67.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE IF NOT EXISTS assessment_k56.term_test_class_access (
  test_slug TEXT NOT NULL REFERENCES assessment_k56.test_definition(slug),
  erp_course_class_id BIGINT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT false,
  source TEXT NOT NULL DEFAULT 'manual_review',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (test_slug, erp_course_class_id),
  CONSTRAINT term_test_class_access_k56_slug_check CHECK (right(test_slug, 4) = '-k56')
);

COMMIT;
