// Database giữ công việc bền vững; thông báo chỉ đánh thức, không mang bài hoặc danh tính học viên.
// Khi mạng lỗi: giữ job và hẹn gửi lại. Backend kiểm dự phòng mỗi 5 phút; hàng trống không gọi n8n.
export const fallbackSweepMs = 5 * 60 * 1000;
export const notificationStatusSql = `SELECT
  count(*) FILTER (WHERE status='processing' AND lease_until>now())::int AS active,
  count(*) FILTER (WHERE (status IN ('queued','retry_wait') AND next_attempt_at<=now())
    OR (status='processing' AND lease_until<=now() AND next_attempt_at<=now()))::int AS due,
  min(CASE WHEN status='processing' THEN GREATEST(lease_until,next_attempt_at)
    ELSE next_attempt_at END) FILTER (WHERE status IN ('queued','retry_wait','processing')) AS next_at,
  min(lease_until) FILTER (WHERE status='processing' AND lease_until>now()) AS next_lease,
  now() AS server_now
FROM assessment.term_test_writing_grading_job;`;

export function createTermTestWritingNotifier({ pool, url, secret, fetchImpl = fetch,
  setTimer = setTimeout, clearTimer = clearTimeout,
  setRecurringTimer = setInterval, clearRecurringTimer = clearInterval,
  log = message => console.error(message) }) {
  const enabled = Boolean(url);
  if (enabled && (new URL(url).protocol !== 'https:' || String(secret || '').length < 32)) {
    throw new Error('TERM_TEST_NOTIFY_CONFIG_INVALID');
  }
  let timer = null;
  let targetAt = Infinity;
  let running = false;
  let pending = false;
  let closed = false;
  let lastSendAt = 0;
  const fallbackTimer = enabled ? setRecurringTimer(() => {
    if (closed) return;
    log(JSON.stringify({ event: 'term_test_fallback_sweep', intervalSeconds: 300 }));
    kick();
  }, fallbackSweepMs) : null;
  fallbackTimer?.unref?.();

  function schedule(delay) {
    if (!enabled || closed) return;
    const safeDelay = Math.max(100, Math.min(2_147_000_000, delay));
    const at = Date.now() + safeDelay;
    if (timer && targetAt <= at) return;
    if (timer) clearTimer(timer);
    targetAt = at;
    timer = setTimer(() => {
      timer = null;
      targetAt = Infinity;
      void pump();
    }, safeDelay);
    timer?.unref?.();
  }

  function kick() {
    if (running) pending = true;
    else schedule(100);
  }

  async function pump() {
    if (!enabled || closed) return;
    if (running) {
      pending = true;
      return;
    }
    running = true;
    try {
      const result = await pool.query(notificationStatusSql);
      if (closed) return;
      if (result.rows.length !== 1) throw new Error('STATUS_INVALID');
      const row = result.rows[0];
      const slots = Math.max(0, 4 - Number(row.active));
      const count = Math.min(slots, Number(row.due));
      const serverNow = new Date(row.server_now).getTime();
      if (!Number.isFinite(serverNow) || !Number.isInteger(count) || count < 0) throw new Error('STATUS_INVALID');
      if (count > 0) {
        const cooldown = 2000 - (Date.now() - lastSendAt);
        if (cooldown > 0) {
          schedule(cooldown);
          return;
        }
        lastSendAt = Date.now();
        const responses = await Promise.all(Array.from({ length: count }, async () => {
          const response = await fetchImpl(url, {
            method: 'POST',
            redirect: 'error',
            signal: AbortSignal.timeout(8000),
            headers: { 'Content-Type': 'application/json', 'x-term-test-notify': secret },
            body: JSON.stringify({ kind: 'term_test_writing_ready' })
          });
          await response.body?.cancel?.();
          if (!response.ok) throw new Error('NOTIFY_HTTP_FAILED');
          return response.status;
        }));
        log(JSON.stringify({ event: 'term_test_notify_sent', count: responses.length }));
        schedule(30000);
      } else if (row.next_at) {
        const next = slots === 0 ? row.next_lease : row.next_at;
        const delay = new Date(next).getTime() - serverNow;
        if (!Number.isFinite(delay)) throw new Error('STATUS_INVALID');
        schedule(Math.max(1000, delay + 100));
      }
    } catch {
      log(JSON.stringify({ event: 'term_test_notify_failed', retrySeconds: 30 }));
      schedule(30000);
    } finally {
      running = false;
      if (pending) {
        pending = false;
        schedule(100);
      }
    }
  }

  function close() {
    closed = true;
    if (timer) clearTimer(timer);
    if (fallbackTimer) clearRecurringTimer(fallbackTimer);
    timer = null;
  }

  return { kick, pump, close, enabled };
}

// Chỉ báo sau khi lời gọi lưu/commit thành công; lỗi thông báo không đổi kết quả nộp/chấm.
export function withTermTestWritingNotifications(service, notifier) {
  if (!service) return null;
  const wrapped = { ...service };
  for (const name of ['ensureSubmission', 'claimJobs', 'completeDispatch', 'completeResult', 'failJob']) {
    wrapped[name] = async (...args) => {
      const result = await service[name](...args);
      try {
        notifier.kick();
      } catch {
        // Công việc đã commit; lịch dự phòng vẫn giữ khả năng nhận lại.
      }
      return result;
    };
  }
  return wrapped;
}
