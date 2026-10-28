// Nhận trạng thái link và lượt kiểm của đúng link đó; lỗi kỹ thuật không thành bài thiếu.
// Trả cờ cho phép học viên chủ động kiểm lại. Lượt đang chạy/đã đạt luôn được giữ.
const technicalCodes = new Set(['CHECK_REVIEW_REQUIRED', 'CHECK_SERVICE_UNAVAILABLE',
  'SHARE_UNAVAILABLE', 'SHARE_CONTENT_INVALID']);

export function canRetrySpeakingCheck(link, job) {
  const status = link?.check_status ?? link?.status;
  if (!link || status === 'accepted') return false;
  return technicalCodes.has(link.check_code)
    || job?.status === 'review'
    || (job?.status === 'failed' && Number(job.attempts) >= 5);
}

export function speakingCheckView(link, job, statusKey = 'status') {
  const retryable = canRetrySpeakingCheck(link, job);
  return { ...link, retryable,
    ...(retryable ? { [statusKey]: 'rejected', check_code: link.check_code || 'CHECK_REVIEW_REQUIRED' } : {}) };
}
