import { createHmac, timingSafeEqual } from 'node:crypto';

const MAX_AGE_SECONDS = 300;

function signature(payload, secret) {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

// Dữ liệu nhận vào: định danh phiếu đã được giảng viên có quyền chọn.
// Việc chính: ký link sống trong 5 phút; người giữ link không thể đổi phiếu hoặc bản chấm.
// Kết quả: dịch vụ demo chỉ tạo lượt thử cho phiếu đã được cấp quyền.
// Khi lỗi: từ chối link thiếu, hết hạn hoặc bị sửa.
export function createLearningDemoGrant({ assignmentId, publicToken, definitionHash, secret, now = Date.now() }) {
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('Thiếu khóa cấp quyền demo.');
  const payload = Buffer.from(JSON.stringify({ assignmentId, publicToken, definitionHash,
    expiresAt: Math.floor(now / 1000) + MAX_AGE_SECONDS })).toString('base64url');
  return `${payload}.${signature(payload, secret)}`;
}

// Grant nháp chỉ chứa định danh/hash, không đưa câu hỏi hay đáp án vào URL.
export function createLearningDraftDemoGrant({draft,reviewer,secret,now=Date.now()}) {
  if(typeof secret!=='string'||secret.length<32) throw new Error('Thiếu khóa cấp quyền demo.');
  const payload=Buffer.from(JSON.stringify({kind:'draft',draftId:draft.id,revision:draft.revision,
    contentHash:draft.contentHash,ownerEmail:reviewer.email,canAccessAllClasses:reviewer.canAccessAllClasses===true,
    expiresAt:Math.floor(now/1000)+MAX_AGE_SECONDS})).toString('base64url');
  return `${payload}.${signature(payload,secret)}`;
}

export function verifyLearningDemoGrant(grant, secret, now = Date.now()) {
  if (typeof grant !== 'string' || grant.length > 2048 || typeof secret !== 'string' || secret.length < 32) return null;
  const parts = grant.split('.');
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]+$/.test(parts[1])) return null;
  const received = Buffer.from(parts[1]);
  const expected = Buffer.from(signature(parts[0], secret));
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) return null;
  try {
    const value = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    if(value.kind==='draft') {
      if(!/^[0-9a-f-]{36}$/i.test(value.draftId)||!Number.isInteger(value.revision)||value.revision<1
        ||!/^[0-9a-f]{64}$/.test(value.contentHash)||typeof value.ownerEmail!=='string'||value.ownerEmail.length>254
        ||typeof value.canAccessAllClasses!=='boolean'||!Number.isInteger(value.expiresAt)
        ||value.expiresAt<=Math.floor(now/1000)||value.expiresAt>Math.floor(now/1000)+MAX_AGE_SECONDS) return null;
      return value;
    }
    if (!/^[0-9a-f-]{36}$/i.test(value.assignmentId)
      || !/^[0-9a-f-]{36}$/i.test(value.publicToken)
      || !/^[0-9a-f]{64}$/.test(value.definitionHash)
      || !Number.isInteger(value.expiresAt)
      || value.expiresAt <= Math.floor(now / 1000)
      || value.expiresAt > Math.floor(now / 1000) + MAX_AGE_SECONDS) return null;
    return value;
  } catch { return null; }
}
