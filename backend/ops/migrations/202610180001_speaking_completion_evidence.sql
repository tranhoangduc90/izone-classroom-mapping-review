-- Giữ bằng chứng công nhận của bài bổ trợ, giống bài chính; không đổi dữ liệu đã nhận.
BEGIN;
ALTER TABLE speaking_homework.practice_link
  ADD COLUMN IF NOT EXISTS evidence JSONB NOT NULL DEFAULT '{}'::jsonb;
COMMIT;
