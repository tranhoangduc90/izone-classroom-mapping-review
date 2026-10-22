BEGIN;
-- Bản chụp điểm ERP có nguồn/thời điểm rõ; không sửa ERP hoặc suy ngày thi từ lúc đọc.
CREATE TABLE IF NOT EXISTS learning.external_class_test_snapshot (
 class_id bigint PRIMARY KEY,
 source text NOT NULL CHECK (source='erp_56_mini_test'),
 payload jsonb NOT NULL,
 source_hash text NOT NULL,
 captured_at timestamptz NOT NULL
);
GRANT SELECT,INSERT,UPDATE ON learning.external_class_test_snapshot TO learning_api;
COMMIT;
