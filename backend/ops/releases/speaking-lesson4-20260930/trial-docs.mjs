import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { planSpeakingCopyCta, verifySpeakingCopyCta } from '../../../src/speaking-classroom-copies.js';
import { planSpeakingStatusWrite, verifySpeakingStatusWrite } from '../../../src/speaking-docs-writer.js';

const documentId = process.argv[2];
const receiptId = process.argv[3];
if (!/^[A-Za-z0-9_-]{20,120}$/.test(documentId || '')) {
  throw new Error('Cần truyền Doc ID của bản sao thử.');
}

// Đầu vào: Doc ID của bản sao thử và có thể có ID biên nhận giả.
// Việc chính: gọi Google Docs qua gws, lập kế hoạch gắn CTA/ghi trạng thái rồi đọc lại.
// Kết quả: chỉ in các cờ kiểm chứng; khi lỗi, lệnh dừng và in mã lỗi, không in nội dung Docs.
function gws(path, params, body) {
  const args = ['docs', 'documents', path, '--params', JSON.stringify(params)];
  if (body) args.push('--json', JSON.stringify(body));
  const launcher = process.platform === 'win32'
    ? { file: 'pwsh', args: ['-NoProfile', '-File', join(process.env.APPDATA, 'npm', 'gws.ps1'), ...args] }
    : { file: 'gws', args };
  const result = spawnSync(launcher.file, launcher.args, {
    encoding: 'utf8', maxBuffer: 4 * 1024 * 1024
  });
  if (result.status !== 0) throw new Error(`GWS_${path.toUpperCase()}_FAILED:${result.status}:${result.error?.code || ''}`);
  return JSON.parse(result.stdout);
}
function read() {
  return gws('get', { documentId, includeTabsContent: true });
}
function write(plan) {
  if (plan.status !== 'write') return;
  gws('batchUpdate', { documentId }, {
    requests: plan.requests, writeControl: { requiredRevisionId: plan.revisionId }
  });
}

const classCode = 'IC2304';
const assignmentCode = '67-speaking-diem_giua';
let document = read();
if (!document.title?.startsWith('THỬ NỘI BỘ - ')) {
  throw new Error('Chỉ được chạy trên bản sao Docs dành cho thử nội bộ.');
}
const cta = planSpeakingCopyCta({ document, documentId, classCode, assignmentCode });
write(cta);
document = read();
if (!verifySpeakingCopyCta({ document, documentId, classCode, assignmentCode })) {
  throw new Error('CTA_READBACK_FAILED');
}
console.log(JSON.stringify({ cta: 'verified', url: cta.url }));

if (receiptId) {
  const teacherBaseUrl = 'https://tranhoangduc90.github.io/izone-ai-team-pages/speaking-homework/teacher.html';
  const status = planSpeakingStatusWrite({ document, documentId, receiptId, teacherBaseUrl });
  write(status);
  document = read();
  if (!verifySpeakingStatusWrite({ document, documentId, linkUrl: status.linkUrl })) {
    throw new Error('STATUS_READBACK_FAILED');
  }
  console.log(JSON.stringify({ status: 'verified', teacherLink: status.linkUrl }));
}
