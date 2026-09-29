-- Dữ liệu vào: lớp IC2304 đã duyệt và bài Classroom Lesson 4 còn ở trạng thái nháp.
-- Việc chính: đăng ký đúng mã bài, hai phần Speaking và hai bài bổ trợ bắt buộc.
-- Kết quả: backend có cấu hình bài nháp; chưa cho học viên mở phiên nộp.
BEGIN;

DO $$
DECLARE
  v_assignment_id UUID;
BEGIN
  IF (SELECT count(*) FROM mapping.classroom_course_mapping
      WHERE erp_course_class_id = 1293 AND classroom_course_id = '826336470852'
        AND erp_class_name_snapshot = 'IC2304' AND status = 'approved') <> 1 THEN
    RAISE EXCEPTION 'IC2304_CLASSROOM_MAPPING_NOT_APPROVED';
  END IF;

  IF (SELECT count(*) FROM speaking_homework.doctor_exercise
      WHERE course_key = '67' AND active = true) < 2 THEN
    RAISE EXCEPTION 'SPEAKING_DOCTOR_CATALOG_TOO_SMALL';
  END IF;

  INSERT INTO speaking_homework.assignment
    (class_id, course_id, course_work_id, assignment_code,
      doctor_course_key, required_practice_count, title, status)
  VALUES (1293, '826336470852', '888120053939', '67-speaking-diem_giua',
    '67', 2, 'Homework Lesson 4', 'draft')
  ON CONFLICT (course_id, course_work_id) DO NOTHING;

  SELECT id INTO v_assignment_id FROM speaking_homework.assignment
  WHERE class_id = 1293 AND course_id = '826336470852'
    AND course_work_id = '888120053939'
    AND assignment_code = '67-speaking-diem_giua'
    AND doctor_course_key = '67' AND required_practice_count = 2
    AND title = 'Homework Lesson 4' AND status = 'draft';
  IF v_assignment_id IS NULL THEN
    RAISE EXCEPTION 'LESSON4_ASSIGNMENT_CONFLICT';
  END IF;

  INSERT INTO speaking_homework.assignment_part
    (assignment_id, part_key, display_title, practice_url, min_questions, position)
  VALUES
    (v_assignment_id, 'insert_middle', 'Chèn điểm giữa trong Speaking',
      'https://ducizone.short.gy/chen_diem_giua_speak', 3, 1),
    (v_assignment_id, 'freestyle', 'Full câu Speaking · Freestyle',
      'https://ducizone.short.gy/freestyle', 3, 2)
  ON CONFLICT (assignment_id, part_key) DO NOTHING;

  IF (SELECT count(*) FROM speaking_homework.assignment_part
      WHERE assignment_id = v_assignment_id) <> 2
    OR (SELECT count(*) FROM speaking_homework.assignment_part
      WHERE assignment_id = v_assignment_id
        AND ((part_key = 'insert_middle' AND min_questions = 3 AND position = 1
          AND practice_url = 'https://ducizone.short.gy/chen_diem_giua_speak')
        OR (part_key = 'freestyle' AND min_questions = 3 AND position = 2
          AND practice_url = 'https://ducizone.short.gy/freestyle'))) <> 2 THEN
    RAISE EXCEPTION 'LESSON4_PARTS_CONFLICT';
  END IF;
END $$;

COMMIT;
