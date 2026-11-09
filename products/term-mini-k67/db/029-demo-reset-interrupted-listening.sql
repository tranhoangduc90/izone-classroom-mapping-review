-- The interrupted attempt must keep its exam session until the attempt is deleted.
-- The demo reset already clears the reverse link before deleting the attempt.
DO $migration$
DECLARE
  signature regprocedure := 'assessment.reset_demo_term_test_student(text,text,uuid)'::regprocedure;
  definition text;
  old_step text := $old$  UPDATE assessment.term_test_attempt
  SET exam_session_id = NULL
  WHERE test_slug = trim(p_test_slug)
    AND erp_course_class_id = target_class_id
    AND erp_student_contact_id = target_student_id;

$old$;
  old_note text := '  -- Gỡ hai chiều liên kết giữa phiên thi và bài làm trước khi xóa.';
  new_note text := '  -- Bỏ liên kết từ phiên đến bài, rồi xóa bài trước khi xóa phiên.';
BEGIN
  definition := pg_get_functiondef(signature);
  IF strpos(definition, old_step) = 0 AND strpos(definition, new_note) > 0 THEN
    RETURN;
  END IF;
  IF strpos(definition, old_note || E'\n' || old_step) = 0
     OR strpos(definition, '  UPDATE assessment.term_test_exam_session' || E'\n' || '  SET attempt_id = NULL') = 0
     OR strpos(definition, '  DELETE FROM assessment.term_test_attempt') = 0 THEN
    RAISE EXCEPTION 'Unexpected K67 demo reset function definition';
  END IF;
  EXECUTE replace(replace(definition, old_step, ''), old_note, new_note);
END
$migration$;
