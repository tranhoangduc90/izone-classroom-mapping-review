import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const workflow = JSON.parse(await readFile(
  new URL('../workflows/progress-log-portal-attendance.json', import.meta.url), 'utf8'
));
const codeFor = name => workflow.nodes.find(node => node.name === name)?.parameters?.jsCode;
const secret = 'test-only-secret';
const shared = {
  assignmentId: '22222222-2222-4222-8222-222222222222',
  studentRef: '33333333-3333-4333-8333-333333333333',
  classId: '1294', studentId: '9002', sessionNumber: 2,
  attendanceStatus: 'PRESENT', commit: false
};

function authenticate(body) {
  const request = { headers: { 'x-learning-attendance-sync': secret }, body };
  const sandbox = {
    $input: { first: () => ({ json: request }) },
    $vars: { TERM_TEST_ERP_SYNC_SECRET: secret }
  };
  return vm.runInNewContext(`(function() { ${codeFor('Xác thực và khóa identity')} })()`, sandbox)[0].json;
}

test('workflow chấp nhận bài nộp và override với identity riêng, không trộn nguồn', () => {
  const submissionId = '11111111-1111-4111-8111-111111111111';
  const submitted = authenticate({ ...shared, schemaVersion: 'LearningPortalAttendanceJobV1', submissionId,
    entityKey: `student:${shared.studentRef}`,
    unitKey: `portal-attendance:${shared.assignmentId}:session:2`,
    operationKey: `portal-attendance:${submissionId}:v1`,
    idempotencyKey: `portal-attendance:${submissionId}:enqueue:v1` });
  assert.equal(submitted.teacherOverride, false);
  const attendanceEventId = '55555555-5555-4555-8555-555555555555';
  const overridden = authenticate({ ...shared, schemaVersion: 'LearningPortalAttendanceOverrideJobV1', attendanceEventId,
    entityKey: `student:${shared.studentRef}`,
    unitKey: `portal-attendance:${shared.assignmentId}:session:2`,
    operationKey: `portal-attendance-override:${attendanceEventId}:v1`,
    idempotencyKey: `portal-attendance-override:${attendanceEventId}:enqueue:v1` });
  assert.equal(overridden.teacherOverride, true);
  assert.equal(overridden.operationKey, `portal-attendance-override:${attendanceEventId}:v1`);
  assert.equal(overridden.submissionId, undefined);
});

test('workflow từ chối tráo identity và trạng thái chưa được ánh xạ', () => {
  const attendanceEventId = '55555555-5555-4555-8555-555555555555';
  const candidate = { ...shared, schemaVersion: 'LearningPortalAttendanceOverrideJobV1', attendanceEventId,
    entityKey: `student:${shared.studentRef}`,
    unitKey: `portal-attendance:${shared.assignmentId}:session:2`,
    operationKey: 'portal-attendance-override:wrong:v1',
    idempotencyKey: `portal-attendance-override:${attendanceEventId}:enqueue:v1` };
  assert.throws(() => authenticate(candidate), /IDENTITY_MISMATCH/);
  assert.throws(() => authenticate({ ...candidate, attendanceStatus: 'ABSENT' }), /INVALID_SCHEMA/);
});
