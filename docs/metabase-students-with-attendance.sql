-- Lấy học viên đã có dữ liệu điểm danh ở các lớp khóa 56/67 còn hoạt động.
-- Truy vấn lọc lớp trước khi đọc điểm danh và đăng ký để tránh quá thời gian chờ Metabase.
WITH current_classes AS (
  SELECT cc.id, cc.name
  FROM course_classes AS cc
  JOIN courses AS course_info
    ON course_info.id = cc.course_id
  WHERE course_info.short_name IN ('56', '67')
    AND cc.status IN ('on_going', 'pending')
    AND cc.deleted_at IS NULL
),
attended_students AS (
  SELECT DISTINCT
    cs.course_class_id,
    scs.student_id
  FROM current_classes AS active_class
  JOIN class_sessions AS cs
    ON cs.course_class_id = active_class.id
  JOIN student_class_sessions AS scs
    ON scs.class_session_id = cs.class_session_id
),
ranked_registrations AS (
  SELECT
    cr.course_class_id,
    oi.customer_id,
    cr.status,
    cr.updated_at,
    ROW_NUMBER() OVER (
      PARTITION BY cr.course_class_id, oi.customer_id
      ORDER BY cr.updated_at DESC, cr.id DESC
    ) AS registration_rank
  FROM current_classes AS active_class
  JOIN class_registrations AS cr
    ON cr.course_class_id = active_class.id
  JOIN order_items AS oi
    ON oi.id = cr.order_item_id
)
SELECT
  active_class.id AS course_class_id,
  active_class.name AS class_name,
  student.id AS erp_student_id,
  student.full_name AS erp_student_name,
  student.email AS erp_email,
  latest_registration.status AS erp_registration_status,
  latest_registration.updated_at AS erp_registration_updated_at
FROM current_classes AS active_class
JOIN attended_students AS attended
  ON attended.course_class_id = active_class.id
JOIN contacts AS student
  ON student.id = attended.student_id
LEFT JOIN ranked_registrations AS latest_registration
  ON latest_registration.course_class_id = active_class.id
  AND latest_registration.customer_id = student.id
  AND latest_registration.registration_rank = 1
WHERE student.deleted_at IS NULL
ORDER BY active_class.name, student.full_name, student.id;
