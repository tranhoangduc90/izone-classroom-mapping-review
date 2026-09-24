const SAFE_SQL_REFERENCE = /^(?:\$[1-9]\d*(?:::[a-z_][a-z0-9_]*(?:\[\])?)?|[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*)$/i;

function requireSafeSqlReference(value, label) {
  if (typeof value !== 'string' || !SAFE_SQL_REFERENCE.test(value)) {
    throw new TypeError(`${label} phải là placeholder hoặc tham chiếu cột SQL an toàn.`);
  }
  return value;
}

// Dữ liệu nhận vào: biểu thức email đã xác thực và mã lớp trong chính câu SQL.
// Việc chính: chấp nhận quyền đã vật hóa hoặc phân công lớp trực tiếp theo tên lớp.
// Kết quả: một predicate SQL fail-closed; quyền xem mọi lớp vẫn được kiểm riêng ở caller.
// Khi lỗi: từ chối biểu thức động không an toàn ngay lúc module khởi tạo.
export function buildTeacherClassAccessPredicate({ reviewerEmailSql, classIdSql }) {
  const reviewerEmail = requireSafeSqlReference(reviewerEmailSql, 'reviewerEmailSql');
  const classId = requireSafeSqlReference(classIdSql, 'classIdSql');

  return `(
    EXISTS (
      SELECT 1
      FROM mapping.reviewer_class_access AS effective_access
      WHERE effective_access.reviewer_email = ${reviewerEmail}
        AND effective_access.erp_course_class_id = ${classId}
    )
    OR EXISTS (
      SELECT 1
      FROM mapping.reviewer_class_assignment AS effective_assignment
      JOIN mapping.classroom_course_mapping AS assigned_course
        ON upper(trim(assigned_course.erp_class_name_snapshot)) = upper(trim(effective_assignment.class_name))
      WHERE effective_assignment.reviewer_email = ${reviewerEmail}
        AND assigned_course.erp_course_class_id = ${classId}
    )
  )`;
}
