import { checkSubmission } from './speaking-checker.js';
import { createSpeakingHomeworkService } from './speaking-homework.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Dữ liệu vào: một check_job đã claim theo khóa bền trong PostgreSQL.
// Việc chính: đọc Share thật, nhờ AI đếm bài luyện, rồi ghi đúng kết quả vào link.
// Kết quả: accepted/rejected hoặc failed có retry; chỉ ghi mã lỗi vào log, không ghi nội dung chat.
export async function runSpeakingCheckJob(service, job, check = checkSubmission) {
  try {
    const result = await check({ section: job.part, url: job.share_url, minimum: Number(job.min_questions) });
    if (result.kind === 'error') {
      await service.failCheckJob({ checkJobId: job.job_id, errorCode: 'CONTENT_CHECK_UNAVAILABLE' });
      return 'retry';
    }
    if (result.kind === 'blocked' && !result.fingerprint) {
      await service.rejectCheckJob({ checkJobId: job.job_id,
        checkCode: result.title === 'Chưa mở được hội thoại' ? 'SHARE_UNAVAILABLE' : 'SHARE_CONTENT_INVALID' });
      return 'rejected';
    }
    if (!/^[0-9a-f]{64}$/.test(result.fingerprint || '') || !Number.isInteger(result.count)) {
      await service.failCheckJob({ checkJobId: job.job_id, errorCode: 'INVALID_CHECK_RESULT' });
      return 'retry';
    }
    const typingWarning = result.kind === 'warning'
      ? { summary: result.message.slice(0, 500), evidence: (result.typingEvidence || []).slice(0, 5) }
      : null;
    const response = await service.completeCheck({
      checkJobId: job.job_id, fingerprint: result.fingerprint,
      questionCount: result.count,
      qualityPassed: ['pass', 'warning'].includes(result.kind)
        && result.count >= Number(job.min_questions),
      typingWarning,
      evidence: { source: result.source || 'chatgpt_share',
        coveredCategories: result.coveredCategories || [],
        completedTurns: result.completedTurns || [] }
    });
    return response.status;
  } catch (error) {
    console.error(`Kiểm Speaking lỗi: ${String(error?.code || 'CHECK_WORKER_ERROR').slice(0, 80)}.`);
    try { await service.failCheckJob({ checkJobId: job.job_id, errorCode: 'CHECK_WORKER_ERROR' }); }
    catch { console.error('Không cập nhật được trạng thái hàng kiểm Speaking.'); }
    return 'retry';
  }
}

// Mỗi nhịp xử lý tối đa bốn link; các lượt đọc/AI chạy song song, DB chỉ khóa lúc nhận/chốt.
// Sau restart, job đang xử lý quá lease được nhận lại, nên không để trạng thái chờ vô hạn.
export function startSpeakingCheckWorker({ pool, enabled = false, pollMs = 5000, concurrency = 4 }) {
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
      const jobs = [];
      for (let index = 0; index < concurrency; index += 1) {
        const job = await service.claimCheckJob();
        if (!job) break;
        jobs.push(job);
      }
      if (jobs.length) await Promise.all(jobs.map(job => runSpeakingCheckJob(service, job)));
    } catch (error) {
      console.error(`Hàng kiểm Speaking chưa xử lý được: ${String(error?.code || 'WORKER_ERROR').slice(0, 80)}.`);
      await sleep(1000);
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
