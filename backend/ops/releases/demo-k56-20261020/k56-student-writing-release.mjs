// Phản hồi Writing của học viên K56. Chỉ runtime demo riêng được mở ngay;
// lớp thật giữ nguyên mốc công bố sau hai giờ và bản chấm/Portal không bị sửa.
const K56_SLUGS = new Set(['term-test-1-k56', 'term-test-2-k56', 'mini-test-k56']);
export const WRITING_RELEASE_DELAY_MS = 2 * 60 * 60 * 1000;

export function studentWritingGrading(testSlug, grading, now = Date.now()) {
  if (!K56_SLUGS.has(testSlug) || !grading?.ready) return grading;
  if (process.env.DEPLOYMENT_PROFILE === 'k56-demo'
      && process.env.DEMO_ISOLATED_MODE === 'true') return grading;
  const readyAt = grading.readyAt instanceof Date
    ? grading.readyAt.getTime() : Date.parse(grading.readyAt || '');
  if (!Number.isFinite(readyAt) || readyAt <= 0) {
    return { status: 'review_required', ready: false, tasks: [] };
  }
  const availableAt = readyAt + WRITING_RELEASE_DELAY_MS;
  if (now >= availableAt) return grading;
  return { status: 'awaiting_release', ready: false, availableAt: new Date(availableAt).toISOString(), tasks: [] };
}
