-- Mở rộng lượt K67 để Reading có thể nộp trước; bài cũ giữ mặc định Listening trước.
-- Chỉ chạy trong database riêng K67, trong giao dịch; không đổi điểm/nháp lịch sử.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
ALTER TABLE assessment.term_test_attempt
  ADD COLUMN exam_mode text NOT NULL DEFAULT 'lis_first' CHECK (exam_mode IN ('lis_first','read_first')),
  ADD COLUMN exam_delivery text NOT NULL DEFAULT 'legacy' CHECK (exam_delivery IN ('legacy','cbt','answer_sheet')),
  ALTER COLUMN listening_answers DROP NOT NULL,
  ALTER COLUMN listening_result DROP NOT NULL,
  ALTER COLUMN listening_submitted_at DROP NOT NULL;
ALTER TABLE assessment.term_test_exam_session
  ADD COLUMN exam_mode text NOT NULL DEFAULT 'lis_first' CHECK (exam_mode IN ('lis_first','read_first'));
ALTER TABLE assessment.term_test_attempt DROP CONSTRAINT term_test_attempt_completion_check;
ALTER TABLE assessment.term_test_attempt ADD CONSTRAINT term_test_attempt_completion_check CHECK (
  (exam_mode='lis_first' AND (
    (completed_at IS NULL AND reading_answers IS NULL AND reading_result IS NULL AND combined_result IS NULL)
    OR (completed_at IS NOT NULL AND reading_answers IS NOT NULL AND reading_result IS NOT NULL AND combined_result IS NOT NULL)
  )) OR (exam_mode='read_first' AND (
    (completed_at IS NULL AND combined_result IS NULL AND (listening_submitted_at IS NULL OR reading_submitted_at IS NULL))
    OR (completed_at IS NOT NULL AND combined_result IS NOT NULL
      AND listening_submitted_at IS NOT NULL AND reading_submitted_at IS NOT NULL)
  ))
);
ALTER TABLE assessment.term_test_attempt ADD CONSTRAINT term_test_attempt_section_snapshot_check CHECK (
  (exam_mode='lis_first' AND listening_submitted_at IS NOT NULL AND listening_answers IS NOT NULL AND listening_result IS NOT NULL)
  OR (exam_mode='read_first' AND (
  ((listening_submitted_at IS NULL AND listening_answers IS NULL AND listening_result IS NULL)
   OR (listening_submitted_at IS NOT NULL AND listening_answers IS NOT NULL AND listening_result IS NOT NULL))
  AND ((reading_submitted_at IS NULL AND reading_answers IS NULL AND reading_result IS NULL)
   OR (reading_submitted_at IS NOT NULL AND reading_answers IS NOT NULL AND reading_result IS NOT NULL))
  ))
);
-- CHECK của PostgreSQL coi NULL là chưa bác bỏ; nhánh mới phải nêu IS NULL/IS NOT NULL rõ.
ALTER TABLE assessment.term_test_attempt ADD CONSTRAINT read_first_reading_policy_check CHECK (
  exam_mode<>'read_first'
  OR (reading_started_at IS NULL AND reading_deadline_at IS NULL)
  OR (reading_started_at IS NOT NULL AND (
    (attempt_mode='answer_sheet' AND reading_deadline_at IS NULL)
    OR (attempt_mode<>'answer_sheet' AND reading_deadline_at IS NOT NULL AND reading_deadline_at>reading_started_at)
  ))
);
ALTER TABLE assessment.term_test_exam_session ADD CONSTRAINT read_first_listening_policy_check CHECK (
  exam_mode<>'read_first'
  OR (listening_started_at IS NULL AND listening_deadline_at IS NULL AND listening_submitted_at IS NULL)
  OR (listening_started_at IS NOT NULL AND (listening_submitted_at IS NULL OR listening_submitted_at>=listening_started_at)
    AND ((attempt_mode='cbt' AND listening_deadline_at IS NOT NULL AND listening_deadline_at>listening_started_at)
      OR (attempt_mode<>'cbt' AND listening_deadline_at IS NULL)))
);
COMMIT;
