-- Dữ liệu vào: đúng bài Homework Lesson 2 IC2304 và 21 claim lịch sử đã lưu.
-- Việc chính: đổi mã tạm thành mã chính thức ở trạng thái nháp, đăng ký hai phần.
-- Kết quả: giữ nguyên ID bài và mọi claim cũ; không sửa Google Docs hay Classroom.
BEGIN;

DO $$
DECLARE
  v_assignment_id UUID;
  v_claim_count INTEGER;
BEGIN
  IF (SELECT count(*) FROM mapping.classroom_course_mapping
      WHERE erp_course_class_id = 1293 AND classroom_course_id = '826336470852'
        AND erp_class_name_snapshot = 'IC2304' AND status = 'approved') <> 1 THEN
    RAISE EXCEPTION 'IC2304_CLASSROOM_MAPPING_NOT_APPROVED';
  END IF;

  SELECT id INTO v_assignment_id FROM speaking_homework.assignment
  WHERE class_id = 1293 AND course_id = '826336470852'
    AND course_work_id = '873394669810'
    AND assignment_code IN ('67-speaking-lesson2-legacy', '67-speaking-paraphrase');
  IF v_assignment_id IS NULL THEN
    RAISE EXCEPTION 'LESSON2_LEGACY_ASSIGNMENT_NOT_FOUND';
  END IF;
  IF (SELECT count(*) FROM speaking_homework.assignment
      WHERE class_id = 1293 AND course_id = '826336470852'
        AND course_work_id = '873394669810') <> 1 THEN
    RAISE EXCEPTION 'LESSON2_ASSIGNMENT_NOT_UNIQUE';
  END IF;
  SELECT count(*) INTO v_claim_count FROM speaking_homework.conversation_claim
    WHERE assignment_id = v_assignment_id;
  IF v_claim_count < 21 THEN
    RAISE EXCEPTION 'LESSON2_HISTORY_MISSING';
  END IF;

  UPDATE speaking_homework.assignment
  SET assignment_code = '67-speaking-paraphrase', status = 'draft',
      delivery_mode = 'direct', doctor_course_key = '67', required_practice_count = 0
  WHERE id = v_assignment_id;

  INSERT INTO speaking_homework.assignment_part
    (assignment_id, part_key, display_title, practice_url, min_questions, position)
  VALUES
    (v_assignment_id, 'paraphrase', 'Luyện tập Paraphrase',
      'https://ducizone.short.gy/paraphrase_cau_hoi', 5, 1),
    (v_assignment_id, 'speaking', 'Luyện full câu Speaking',
      'https://ducizone.short.gy/freestyle', 3, 2)
  ON CONFLICT (assignment_id, part_key) DO NOTHING;

  IF (SELECT count(*) FROM speaking_homework.assignment_part
      WHERE assignment_id = v_assignment_id) <> 2
    OR (SELECT count(*) FROM speaking_homework.assignment_part
      WHERE assignment_id = v_assignment_id AND (
        (part_key = 'paraphrase' AND min_questions = 5 AND position = 1
          AND practice_url = 'https://ducizone.short.gy/paraphrase_cau_hoi') OR
        (part_key = 'speaking' AND min_questions = 3 AND position = 2
          AND practice_url = 'https://ducizone.short.gy/freestyle'))) <> 2 THEN
    RAISE EXCEPTION 'LESSON2_PARTS_CONFLICT';
  END IF;
  IF (SELECT count(*) FROM speaking_homework.conversation_claim
      WHERE assignment_id = v_assignment_id) <> v_claim_count THEN
    RAISE EXCEPTION 'LESSON2_HISTORY_CHANGED';
  END IF;
END $$;

COMMIT;
