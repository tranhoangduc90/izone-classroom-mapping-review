import { createSpeakingHomeworkService } from './speaking-homework.js';

// Dữ liệu vào: job đánh giá của một biên nhận đã có đủ link đạt yêu cầu.
// Việc chính: tổng hợp kết quả AI đã kiểm thành một bản đọc cho giảng viên.
// Kết quả: bản đánh giá bền; khi lỗi job được giữ để thử lại, không báo giả thành công.
export function startSpeakingGradeWorker({ pool, enabled = false, pollMs = 5000 }) {
  if (!pool || !enabled) return { async stop() {} };
  const service = createSpeakingHomeworkService({ pool });
  let stopped = false;
  let running = false;
  let timer;
  let resolveStopped;
  const stoppedPromise = new Promise(resolve => { resolveStopped = resolve; });

  async function tick() {
    if (stopped || running) return;
    running = true;
    try {
      const job = await service.claimOutboxJob('grade_speaking');
      if (job) {
        try { await service.completeGradeJob(job.job_id); }
        catch (error) {
          console.error(`Đánh giá Speaking lỗi: ${String(error?.code || 'GRADE_ERROR').slice(0, 80)}.`);
          await service.failOutboxJob({ jobId: job.job_id, errorCode: 'GRADE_ERROR' });
        }
      }
    } catch (error) {
      console.error(`Hàng đánh giá Speaking chưa xử lý được: ${String(error?.code || 'GRADE_WORKER_ERROR').slice(0, 80)}.`);
    } finally {
      running = false;
      if (!stopped) timer = setTimeout(tick, pollMs).unref();
      else resolveStopped();
    }
  }
  timer = setTimeout(tick, 0).unref();
  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (!running) resolveStopped();
      await stoppedPromise;
    }
  };
}
