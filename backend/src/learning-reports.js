import {
  periodicReportSystemOutputV1Schema,
  teacherHumanNoteV1Schema
} from './learning-contracts.js';

function listSection(title, points, emptyLabel) {
  const lines = [`## ${title}`];
  if (!points.length) return [...lines, emptyLabel];
  return [...lines, ...points.map(point => `- ${point.text}`)];
}

export function renderPeriodicSystemReport(outputInput) {
  const output = periodicReportSystemOutputV1Schema.parse(outputInput);
  const lines = [
    '# Phân tích của hệ thống',
    '',
    `Dữ liệu: buổi ${output.fromSessionNumber}–${output.toSessionNumber}, ${output.evidenceCount} evidence.`,
    '',
    ...listSection('Điều đã tiến bộ', output.progress, 'Chưa đủ bằng chứng để kết luận tiến bộ.'),
    '',
    ...listSection('Điều cần chú ý', output.recurringIssues, 'Chưa thấy lỗi lặp lại rõ ràng.'),
    '',
    '## Tình trạng tham gia',
    `- Nộp đủ: ${output.attendance.submittedComplete}/${output.attendance.expectedSessions} buổi`,
    `- Nộp thiếu: ${output.attendance.submittedIncomplete} buổi`,
    `- Chưa có phiếu: ${output.attendance.missed} buổi`,
    '',
    '## Một việc tiếp theo',
    output.nextAction?.text || 'Chưa đủ bằng chứng để đề xuất một việc cụ thể.'
  ];
  if (output.insufficientData) {
    lines.push('', `> Chưa đủ dữ liệu: ${output.insufficientDataReason}`);
  }
  return lines.join('\n');
}

export function assembleStudentPeriodicMessage({ systemOutput, humanNote }) {
  const output = periodicReportSystemOutputV1Schema.parse(systemOutput);
  const note = teacherHumanNoteV1Schema.parse(humanNote);
  return {
    systemLabel: 'Phân tích của hệ thống',
    systemMarkdown: renderPeriodicSystemReport(output),
    humanLabel: 'Lời nhắn từ giảng viên',
    humanNote: note.noteText
  };
}
