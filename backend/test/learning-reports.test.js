import assert from 'node:assert/strict';
import test from 'node:test';
import { assembleStudentPeriodicMessage, renderPeriodicSystemReport } from '../src/learning-reports.js';

const evidenceId = '90000000-0000-4000-8000-000000000001';
const systemOutput = {
  schemaVersion: 'PeriodicReportSystemOutputV1',
  studentRef: '60000000-0000-4000-8000-000000000001',
  classId: '2139',
  fromSessionNumber: 1,
  toSessionNumber: 5,
  evidenceCount: 8,
  progress: [{ text: 'Đã giảm lỗi chọn heading chỉ vì trùng từ.', evidenceIds: [evidenceId] }],
  recurringIssues: [{ text: 'Vẫn bỏ sót giới hạn số từ ở câu điền.', evidenceIds: [evidenceId] }],
  attendance: { expectedSessions: 5, submittedComplete: 4, submittedIncomplete: 1, missed: 0 },
  nextAction: { text: 'Trước khi điền, gạch chân giới hạn số từ của từng nhóm câu.', evidenceIds: [evidenceId] },
  insufficientData: false,
  insufficientDataReason: null
};

test('bản hệ thống ngắn, có phạm vi và không giả làm lời giảng viên', () => {
  const markdown = renderPeriodicSystemReport(systemOutput);
  assert.match(markdown, /^# Phân tích của hệ thống/u);
  assert.match(markdown, /buổi 1–5, 8 evidence/);
  assert.doesNotMatch(markdown, /Cô|Thầy|giảng viên nhắn/);
});

test('lời người thật bắt buộc tách khỏi output hệ thống', () => {
  const message = assembleStudentPeriodicMessage({
    systemOutput,
    humanNote: {
      schemaVersion: 'TeacherHumanNoteV1',
      reportId: '80000000-0000-4000-8000-000000000001',
      teacherEmail: 'teacher@example.test',
      noteText: 'Cô thấy em đã kiên trì hơn hẳn, giữ nhịp này nhé.'
    }
  });
  assert.equal(message.systemLabel, 'Phân tích của hệ thống');
  assert.equal(message.humanLabel, 'Lời nhắn từ giảng viên');
  assert.match(message.humanNote, /Cô thấy em/);
  assert.doesNotMatch(message.systemMarkdown, /Cô thấy em/);
});
