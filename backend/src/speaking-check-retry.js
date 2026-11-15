import { SHARE_OPENING_ATTACHMENT } from './speaking-share-reader.js';

// Nhận trạng thái link và lượt kiểm của đúng link đó; lỗi kỹ thuật không thành bài thiếu.
// Trả cờ cho phép học viên chủ động kiểm lại. Lượt đang chạy/đã đạt luôn được giữ.
const technicalCodes = new Set(['CHECK_REVIEW_REQUIRED', 'CHECK_SERVICE_UNAVAILABLE',
  'SHARE_UNAVAILABLE', 'SHARE_CONTENT_INVALID', SHARE_OPENING_ATTACHMENT]);

export function canRetrySpeakingCheck(link, job) {
  const status = link?.check_status ?? link?.status;
  if (!link || status === 'accepted') return false;
  return technicalCodes.has(link.check_code)
    || job?.status === 'review'
    || (job?.status === 'failed' && Number(job.attempts) >= 5);
}

export function speakingCheckView(link, job, statusKey = 'status') {
  const retryable = canRetrySpeakingCheck(link, job);
  if (retryable && link.check_code === SHARE_OPENING_ATTACHMENT) {
    const action = statusKey === 'check_status' ? 'Mở bài luyện' : 'Mở bài đã chọn';
    const checkMessage = `Chưa đọc được nội dung đoạn chat của em vì nó khởi đầu bằng một tệp. Em hãy quay lại nhấn ${action} và chat ngay trong đoạn chat vừa mở. Nếu vẫn không được, hãy gửi link cho giảng viên kèm theo ảnh chụp màn hình để được hỗ trợ.`;
    return { ...link, [statusKey]: 'rejected', retryable, evidence: { ...link.evidence, checkMessage } };
  }
  return { ...link, retryable,
    ...(retryable ? { [statusKey]: 'rejected', check_code: link.check_code || 'CHECK_REVIEW_REQUIRED' } : {}) };
}
