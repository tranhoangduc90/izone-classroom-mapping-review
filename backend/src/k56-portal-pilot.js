// Dữ liệu vào: slug K56 và ID kỹ thuật của lớp/học viên trong ERP.
// Việc chính: kiểm hình dạng đích; quyền mở lớp–đề được kiểm riêng trong database trước khi gửi.
// Kết quả: đúng ba loại bài K56 có thể tạo điểm, không phụ thuộc ID lớp pilot.
// Khi lỗi: không tạo payload ghi Portal; caller báo trạng thái cần kiểm tra.
export const K56_PORTAL_TESTS = Object.freeze({
  'term-test-1-k56': { listening: 40, reading: 26, writing: 9 },
  'term-test-2-k56': { listening: 40, reading: 40, writing: 9 },
  'mini-test-k56': { listening: 10, reading: 13 }
});

function isSafePositiveId(value) {
  const text = String(value ?? '');
  return /^[1-9][0-9]*$/.test(text) && Number.isSafeInteger(Number(text));
}

export function isK56PortalAttempt(attempt) {
  return Object.hasOwn(K56_PORTAL_TESTS, String(attempt?.test_slug || attempt?.slug || ''))
    && isSafePositiveId(attempt?.class_id)
    && isSafePositiveId(attempt?.student_id);
}

export function buildK56PortalGrades(attempt, result, extraGrades = {}) {
  if (!isK56PortalAttempt(attempt)) return {};
  const testSlug = attempt.test_slug || attempt.slug;
  // Mini giữ điểm thô và URL writer K56 hiện hành, không bị thay đổi bởi Term.
  const limits = K56_PORTAL_TESTS[testSlug];
  const grades = {};
  for (const skill of ['listening', 'reading']) {
    const section = result?.[skill];
    if (!section) continue;
    if (section.total !== limits[skill] || !Number.isInteger(section.correct)
      || section.correct < 0 || section.correct > limits[skill]) throw new Error('K56_INVALID_RAW_SCORE');
    // ERP K56 lưu số câu đúng cho cả hai Term; Band chỉ hiển thị trên web.
    grades[skill] = section.correct;
  }
  if (limits.writing && extraGrades.writing !== null && extraGrades.writing !== undefined) {
    const score = extraGrades.writing;
    if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 9 || !Number.isInteger(score * 2)) throw new Error('K56_INVALID_WRITING_SCORE');
    grades.writing = score;
  }
  return grades;
}
