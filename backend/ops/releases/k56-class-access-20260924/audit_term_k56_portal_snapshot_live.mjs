import assert from 'node:assert/strict';
import { readTermK56PortalSnapshot } from '../../../src/term-test-portal-snapshot.js';

// Dữ liệu vào: ID một lớp K56 đã có đủ điểm hai Term trên Portal thật.
// Việc chính: chọn một mã học viên trong RAM và thử đúng đường GET/lọc của API ứng viên.
// Kết quả: chỉ in số cột, số ô điểm và trạng thái; không in hồ sơ hay mã học viên.
// Khi lỗi: in mã kỹ thuật theo bước, không in phản hồi Portal hoặc stack trace.
const classId = String(process.argv[2] ?? '');
const MAX_BYTES = 4 * 1024 * 1024;
let stage = 'input';

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

async function readSource() {
  const response = await fetch(
    `https://gateway.izone.edu.vn/portal/v1/course-classes/${classId}/student-tests`,
    { headers: { accept: 'application/json' }, redirect: 'error',
      signal: AbortSignal.timeout(10_000) }
  );
  if (!response.ok || !response.body) fail('PORTAL_GET_FAILED');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > MAX_BYTES) fail('PORTAL_RESPONSE_TOO_LARGE');
    chunks.push(Buffer.from(chunk));
  }
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!Array.isArray(body.class_tests) || !Array.isArray(body.student_test_grades)) {
    fail('PORTAL_RESPONSE_SHAPE');
  }
  return body;
}

function chooseCompleteStudent(body) {
  const columns = [1, 2].flatMap(phase => ['Listening', 'Reading', 'Writing']
    .map(skill => body.class_tests.filter(item =>
      item?.name === `Term Test ${phase} ${skill}`)));
  if (columns.some(matches => matches.length !== 1)) fail('TERM_COLUMN_AMBIGUOUS');
  const ids = columns.map(matches => Number(matches[0].id));
  if (new Set(ids).size !== 6 || ids.some(id => !Number.isSafeInteger(id) || id <= 0)) {
    fail('TERM_COLUMN_INVALID');
  }
  const byStudent = new Map();
  for (const row of body.student_test_grades) {
    const studentId = Number(row?.student_id);
    if (!ids.includes(Number(row?.class_test_id)) || !Number.isSafeInteger(studentId)
      || studentId <= 0) continue;
    const rows = byStudent.get(studentId) ?? [];
    rows.push(row);
    byStudent.set(studentId, rows);
  }
  const studentId = [...byStudent.entries()]
    .sort(([left], [right]) => left - right)
    .find(([, rows]) => ids.every(id => rows.filter(row =>
      Number(row.class_test_id) === id && typeof row.grade === 'number'
      && Number.isFinite(row.grade)).length === 1))?.[0];
  if (!studentId) fail('COMPLETE_TERM_GRADES_MISSING');
  return studentId;
}

function assertMinimal(snapshot, phase, studentId) {
  assert.deepEqual(Object.keys(snapshot).sort(),
    ['class_tests', 'student_test_grades']);
  assert.deepEqual(snapshot.class_tests.map(item => item.name),
    ['Listening', 'Reading', 'Writing'].map(skill => `Term Test ${phase} ${skill}`));
  assert.deepEqual(snapshot.class_tests.map(item => item.max_grade),
    phase === 1 ? [40, 26, 9] : [40, 40, 9]);
  assert.equal(snapshot.student_test_grades.length, 3);
  assert.equal(new Set(snapshot.student_test_grades.map(item => item.class_test_id)).size, 3);
  for (const item of snapshot.class_tests) {
    assert.deepEqual(Object.keys(item).sort(), ['id', 'max_grade', 'name']);
  }
  for (const item of snapshot.student_test_grades) {
    assert.equal(Number(item.student_id), studentId);
    assert.ok(Object.keys(item).every(key =>
      ['student_id', 'class_test_id', 'grade', 'meta'].includes(key)));
    if (item.meta) {
      assert.deepEqual(Object.keys(item.meta), ['records']);
      assert.deepEqual(Object.keys(item.meta.records[0]), ['id']);
    }
  }
}

try {
  if (!/^[1-9][0-9]{0,14}$/.test(classId)) fail('CLASS_ID_INVALID');
  stage = 'source';
  const source = await readSource();
  const studentId = chooseCompleteStudent(source);
  const results = [];
  for (const phase of [1, 2]) {
    stage = `term_${phase}`;
    const snapshot = await readTermK56PortalSnapshot({ classId, studentId,
      testSlug: `term-test-${phase}-k56` });
    assertMinimal(snapshot, phase, studentId);
    results.push({ term: phase, columns: snapshot.class_tests.length,
      gradeRows: snapshot.student_test_grades.length, minimal: true });
  }
  console.log(JSON.stringify({ toolOutcome: 'success', businessOutcome: 'success',
    livePortalRead: true, results, personalFieldsEmitted: false }));
} catch (error) {
  const code = typeof error?.code === 'string' && /^[A-Z0-9_]{3,80}$/.test(error.code)
    ? error.code : 'LIVE_SNAPSHOT_AUDIT_FAILED';
  console.log(JSON.stringify({ toolOutcome: 'success', businessOutcome: 'failure',
    stage, code, personalFieldsEmitted: false }));
  process.exitCode = 2;
}
