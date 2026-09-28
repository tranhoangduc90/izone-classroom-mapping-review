-- Dữ liệu vào: assignment Lesson 3 và lớp IC2304 đã duyệt trong mapping.
-- Việc chính: dùng ERP class ID 1293 thay vì mã hiển thị 2304 để bật Bác sĩ AI.
-- Kết quả: đúng một bài được bật; biên nhận đã có được đưa vào hàng phân tích.
DO $$
BEGIN
  IF (SELECT count(*) FROM speaking_homework.assignment
      WHERE class_id = 1293 AND assignment_code = '67-speaking-lam_ro') <> 1
    OR NOT EXISTS (SELECT 1 FROM mapping.classroom_course_mapping
      WHERE erp_course_class_id = 1293
        AND erp_class_name_snapshot = 'IC2304' AND status = 'approved') THEN
    RAISE EXCEPTION 'SPEAKING_DOCTOR_CLASS_MAPPING_MISMATCH';
  END IF;
  IF EXISTS (SELECT 1 FROM speaking_homework.assignment
      WHERE class_id = 1293 AND assignment_code = '67-speaking-lam_ro'
        AND doctor_course_key IS NOT NULL AND doctor_course_key <> '67') THEN
    RAISE EXCEPTION 'SPEAKING_DOCTOR_COURSE_KEY_CONFLICT';
  END IF;
  UPDATE speaking_homework.assignment
    SET doctor_course_key = '67'
    WHERE class_id = 1293 AND assignment_code = '67-speaking-lam_ro'
      AND doctor_course_key IS NULL;
END $$;

INSERT INTO speaking_homework.outbox (receipt_id, kind)
SELECT r.id, 'doctor_analyze'
FROM speaking_homework.receipt r
JOIN speaking_homework.submission s ON s.id = r.submission_id
JOIN speaking_homework.access_grant g ON g.id = s.access_grant_id
JOIN speaking_homework.assignment a ON a.id = g.assignment_id
WHERE a.class_id = 1293 AND a.assignment_code = '67-speaking-lam_ro'
  AND s.status = 'submitted'
ON CONFLICT (receipt_id, kind) DO NOTHING;
