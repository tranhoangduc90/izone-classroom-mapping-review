const PORTAL_CLASS_BASE_URL = 'https://gateway.izone.edu.vn/portal/v1/course-classes';
const MAX_PORTAL_BYTES = 4 * 1024 * 1024;
const PORTAL_TIMEOUT_MS = 10_000;

function positiveId(value) {
  const text = String(value ?? '');
  if (!/^[1-9][0-9]{0,14}$/.test(text)) return null;
  const number = Number(text);
  return Number.isSafeInteger(number) ? number : null;
}

function portalError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

// Dữ liệu vào: phản hồi Portal có thể chứa toàn bộ hồ sơ lớp và mã bài Term K56.
// Việc chính: chỉ chọn ba cột Term và các ô điểm của đúng mã học viên được yêu cầu.
// Kết quả: cấu trúc đủ cho writer đối chiếu/ghi điểm, không chứa thông tin liên hệ hay nhận xét.
// Khi lỗi: từ chối phản hồi sai dạng; không trả lại payload Portal chưa lọc.
export function projectTermK56PortalSnapshot(portal, { studentId, testSlug }) {
  const phase = /^term-test-([12])-k56$/.exec(String(testSlug ?? ''))?.[1];
  const targetStudentId = positiveId(studentId);
  if (!phase || !targetStudentId || !Array.isArray(portal?.class_tests)
    || !Array.isArray(portal?.student_test_grades)) {
    throw portalError('PORTAL_SNAPSHOT_INVALID_INPUT');
  }
  const names = new Set(['Listening', 'Reading', 'Writing']
    .map(skill => `Term Test ${phase} ${skill}`));
  const classTests = portal.class_tests
    .filter(item => names.has(item?.name))
    .map(item => {
      const id = positiveId(item.id);
      const maxGrade = Number(item.max_grade);
      if (!id || !Number.isFinite(maxGrade)) throw portalError('PORTAL_SNAPSHOT_INVALID_COLUMN');
      return { id, name: item.name, max_grade: maxGrade };
    });
  if (classTests.length > 6) throw portalError('PORTAL_SNAPSHOT_TOO_MANY_COLUMNS');
  const allowedColumnIds = new Set(classTests.map(item => item.id));
  const grades = portal.student_test_grades
    .filter(item => positiveId(item?.student_id) === targetStudentId
      && allowedColumnIds.has(positiveId(item?.class_test_id)))
    .map(item => {
      const rawGrade = item.grade;
      const grade = rawGrade === null || rawGrade === undefined || rawGrade === ''
        ? null : Number(rawGrade);
      if (grade !== null && !Number.isFinite(grade)) {
        throw portalError('PORTAL_SNAPSHOT_INVALID_GRADE');
      }
      const rawRecordId = item?.meta?.records?.[0]?.id;
      const recordId = rawRecordId === null || rawRecordId === undefined
        ? null : String(rawRecordId);
      if (recordId && !/^[A-Za-z0-9_-]{1,100}$/.test(recordId)) {
        throw portalError('PORTAL_SNAPSHOT_INVALID_RECORD');
      }
      return {
        student_id: targetStudentId,
        class_test_id: positiveId(item.class_test_id),
        grade,
        ...(recordId ? { meta: { records: [{ id: recordId }] } } : {})
      };
    });
  if (grades.length > 12) throw portalError('PORTAL_SNAPSHOT_TOO_MANY_GRADES');
  return { class_tests: classTests, student_test_grades: grades };
}

async function readBoundedJson(response) {
  if (!response?.ok || !response.body) throw portalError('PORTAL_SNAPSHOT_UPSTREAM_UNAVAILABLE');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > MAX_PORTAL_BYTES) {
      await response.body.cancel?.().catch(() => {});
      throw portalError('PORTAL_SNAPSHOT_UPSTREAM_TOO_LARGE');
    }
    chunks.push(Buffer.from(chunk));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw portalError('PORTAL_SNAPSHOT_UPSTREAM_INVALID_JSON');
  }
}

// Dữ liệu vào: ID lớp/học viên đã kiểm ở route K56 và API Portal công khai cố định.
// Việc chính: gọi GET không chuyển hướng, giới hạn thời gian/dung lượng rồi lọc trong RAM.
// Kết quả: n8n chỉ nhận ID, cột và điểm cần thiết; phản hồi gốc không vào execution.
// Khi lỗi: chỉ đưa mã lỗi kỹ thuật ra ngoài, không ghi hay trả hồ sơ lớp từ Portal.
export async function readTermK56PortalSnapshot({ classId, studentId, testSlug,
  fetchImpl = globalThis.fetch }) {
  const id = positiveId(classId);
  if (!id) throw portalError('PORTAL_SNAPSHOT_INVALID_INPUT');
  const url = `${PORTAL_CLASS_BASE_URL}/${id}/student-tests`;
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(PORTAL_TIMEOUT_MS)
    });
  } catch {
    throw portalError('PORTAL_SNAPSHOT_UPSTREAM_UNAVAILABLE');
  }
  const portal = await readBoundedJson(response);
  return projectTermK56PortalSnapshot(portal, { studentId, testSlug });
}
