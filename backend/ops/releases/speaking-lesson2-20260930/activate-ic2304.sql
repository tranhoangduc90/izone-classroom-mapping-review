-- Dữ liệu vào: bài buổi 2 đã ở trạng thái nháp và 15 bản sao Docs đã ghép đúng học viên.
-- Việc chính: kiểm đủ bản sao, định danh và lịch sử, rồi mới mở cổng nộp.
-- Kết quả: chỉ bài buổi 2 IC2304 chuyển sang trạng thái mở.
BEGIN;

DO $$
DECLARE
  v_assignment_id UUID;
BEGIN
  SELECT id INTO v_assignment_id FROM speaking_homework.assignment
  WHERE class_id = 1293 AND course_id = '826336470852'
    AND course_work_id = '873394669810'
    AND assignment_code = '67-speaking-paraphrase'
    AND status = 'draft' AND delivery_mode = 'direct';
  IF v_assignment_id IS NULL THEN
    RAISE EXCEPTION 'LESSON2_DRAFT_NOT_FOUND';
  END IF;
  IF (SELECT count(*) FROM speaking_homework.assignment_document
      WHERE assignment_id = v_assignment_id AND student_ref IS NOT NULL
        AND classroom_submission_id IS NOT NULL) <> 15 THEN
    RAISE EXCEPTION 'LESSON2_COPIES_INCOMPLETE';
  END IF;
  IF (SELECT count(DISTINCT student_ref) FROM speaking_homework.assignment_document
      WHERE assignment_id = v_assignment_id) <> 15
    OR (SELECT count(DISTINCT document_id) FROM speaking_homework.assignment_document
      WHERE assignment_id = v_assignment_id) <> 15
    OR (SELECT count(DISTINCT classroom_submission_id) FROM speaking_homework.assignment_document
      WHERE assignment_id = v_assignment_id) <> 15 THEN
    RAISE EXCEPTION 'LESSON2_COPIES_DUPLICATED';
  END IF;
  IF (SELECT count(*) FROM speaking_homework.conversation_claim
      WHERE assignment_id = v_assignment_id) < 21 THEN
    RAISE EXCEPTION 'LESSON2_HISTORY_MISSING';
  END IF;
  UPDATE speaking_homework.assignment SET status = 'open' WHERE id = v_assignment_id;
END $$;

COMMIT;
