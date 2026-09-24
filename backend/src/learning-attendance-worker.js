import { runLearningJobBatch } from './learning-outbox.js';

export const ATTENDANCE_JOB_BATCH_LIMIT = 10;
export const ATTENDANCE_JOB_LEASE_SECONDS = 180;

// Nhận một pool PostgreSQL và hàm gọi Portal; mỗi nhịp chỉ lấy job điểm danh,
// xử lý tuần tự theo lease và để job tự retry nếu Portal tạm thời lỗi.
export function startLearningAttendanceWorker({ pool, handler, pollMs = 2000 }) {
  if (!pool || !handler) return { stop() {} };
  const workerId = `learning-attendance-${process.pid}`;
  let stopped = false;
  let running = false;
  let timer = null;
  let resolveStopped;
  const stoppedPromise = new Promise(resolve => { resolveStopped = resolve; });

  async function tick() {
    if (stopped || running) return;
    running = true;
    try {
      const results = await runLearningJobBatch({
        pool,
        workerId,
        handler,
        limit: ATTENDANCE_JOB_BATCH_LIMIT,
        leaseSeconds: ATTENDANCE_JOB_LEASE_SECONDS,
        jobTypes: ['sync_portal_attendance']
      });
      const failures = results.filter(result => result.status === 'failed_or_retry');
      if (failures.length) {
        console.warn(`Có ${failures.length} tác vụ điểm danh đang chờ thử lại hoặc cần kiểm tra.`);
      }
    } catch (error) {
      console.error(`Không thể xử lý hàng đợi điểm danh: ${error.code || 'WORKER_ERROR'}`);
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
