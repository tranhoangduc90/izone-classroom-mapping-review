// Dữ liệu vào: trạng thái hàng ghi Google Docs đã lưu trong PostgreSQL.
// Việc chính: một backend giữ khóa điều phối, nghe tín hiệu sau commit và đánh thức n8n khi có việc.
// Kết quả: hàng trống không tạo execution; mất tín hiệu được kiểm lại sau tối đa năm phút.
// Khi lỗi: hàng vẫn nằm trong database, log chỉ mã sự kiện và thử lại có giới hạn nhịp.
export const speakingDocsChannel = 'speaking_homework_write_doc_ready';
export const speakingDocsFallbackMs = 5 * 60 * 1000;
const LEADER_LOCK_ID = 79202368;
const MIN_SEND_GAP_MS = 60_000;

export const speakingDocsStatusSql = `SELECT
  count(*) FILTER (WHERE status='pending'
    OR (status='failed' AND updated_at<=now()-interval '30 seconds')
    OR (status='processing' AND updated_at<=now()-interval '5 minutes'))::int AS due,
  min(CASE
    WHEN status='pending' THEN created_at
    WHEN status='failed' THEN updated_at+interval '30 seconds'
    ELSE updated_at+interval '5 minutes' END) AS next_at,
  now() AS server_now
FROM speaking_homework.outbox
WHERE kind='write_doc' AND attempts<5
  AND status IN ('pending','failed','processing');`;

export function createSpeakingDocsNotifier({ pool, url, secret, fetchImpl = fetch,
  setTimer = setTimeout, clearTimer = clearTimeout,
  setRecurringTimer = setInterval, clearRecurringTimer = clearInterval,
  now = () => Date.now(), log = message => console.error(message) }) {
  const enabled = Boolean(url && pool);
  if (url && !pool) throw new Error('SPEAKING_DOCS_NOTIFY_DATABASE_REQUIRED');
  if (enabled && (new URL(url).protocol !== 'https:' || String(secret || '').length < 32)) {
    throw new Error('SPEAKING_DOCS_NOTIFY_CONFIG_INVALID');
  }
  let listener = null;
  let leader = false;
  let closed = false;
  let running = false;
  let pending = false;
  let timer = null;
  let timerAt = Infinity;
  let acquiring = null;
  let lastSentAt = -Infinity;

  // Nhận lại khóa khi backend khác rời đi; backend đang giữ khóa kiểm bù tín hiệu bị lỡ.
  const fallback = enabled ? setRecurringTimer(() => {
    if (closed) return;
    if (leader) kick();
    else void acquireLeadership();
  }, speakingDocsFallbackMs) : null;
  fallback?.unref?.();

  function schedule(delay) {
    if (!enabled || closed) return;
    const bounded = Math.max(100, Math.min(2_147_000_000, delay));
    const at = now() + bounded;
    if (timer && timerAt <= at) return;
    if (timer) clearTimer(timer);
    timerAt = at;
    timer = setTimer(() => {
      timer = null;
      timerAt = Infinity;
      void pump();
    }, bounded);
    timer?.unref?.();
  }

  function kick() {
    if (!leader || closed) return;
    if (running) pending = true;
    else schedule(100);
  }

  async function pump() {
    if (!enabled || closed) return;
    if (running) { pending = true; return; }
    running = true;
    try {
      const result = await pool.query(speakingDocsStatusSql);
      const row = result.rows[0];
      const due = Number(row?.due);
      const serverNow = new Date(row?.server_now).getTime();
      if (!Number.isInteger(due) || due < 0 || !Number.isFinite(serverNow)) {
        throw new Error('SPEAKING_DOCS_STATUS_INVALID');
      }
      if (due > 0) {
        const wait = MIN_SEND_GAP_MS - (now() - lastSentAt);
        if (wait > 0) { schedule(wait); return; }
        lastSentAt = now();
        const response = await fetchImpl(url, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
          headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
          body: JSON.stringify({ kind: 'speaking_docs_ready' })
        });
        await response.body?.cancel?.();
        if (!response.ok) throw new Error('SPEAKING_DOCS_NOTIFY_HTTP_FAILED');
        log(JSON.stringify({ event: 'speaking_docs_notify_sent', count: 1 }));
        schedule(MIN_SEND_GAP_MS);
      } else if (row.next_at) {
        const delay = new Date(row.next_at).getTime() - serverNow;
        if (!Number.isFinite(delay)) throw new Error('SPEAKING_DOCS_STATUS_INVALID');
        schedule(Math.max(1000, delay + 100));
      }
    } catch {
      log(JSON.stringify({ event: 'speaking_docs_notify_failed', retrySeconds: 30 }));
      schedule(30_000);
    } finally {
      running = false;
      if (pending) { pending = false; kick(); }
    }
  }

  function loseLeadership(candidate) {
    if (closed || listener !== candidate) return;
    listener = null;
    leader = false;
    if (timer) clearTimer(timer);
    timer = null;
    timerAt = Infinity;
    try { candidate.release(true); } catch { /* Kết nối đã mất. */ }
    log(JSON.stringify({ event: 'speaking_docs_listener_failed' }));
  }

  async function acquireLeadership() {
    if (!enabled || closed) return false;
    if (leader) return true;
    if (acquiring) return acquiring;
    acquiring = (async () => {
      let candidate;
      try {
        candidate = await pool.connect();
        const lock = await candidate.query('SELECT pg_try_advisory_lock($1) AS acquired', [LEADER_LOCK_ID]);
        if (lock.rows[0]?.acquired !== true) { candidate.release(); return false; }
        await candidate.query(`LISTEN ${speakingDocsChannel}`);
        if (closed) { candidate.release(true); return false; }
        listener = candidate;
        leader = true;
        candidate.on('notification', kick);
        candidate.on('error', () => loseLeadership(candidate));
        candidate.on('end', () => loseLeadership(candidate));
        kick();
        return true;
      } catch {
        try { candidate?.release(true); } catch { /* Kết nối đã mất. */ }
        log(JSON.stringify({ event: 'speaking_docs_listener_connect_failed' }));
        return false;
      }
    })();
    try { return await acquiring; } finally { acquiring = null; }
  }

  async function start() { return acquireLeadership(); }

  async function close() {
    closed = true;
    if (acquiring) await acquiring;
    if (timer) clearTimer(timer);
    if (fallback) clearRecurringTimer(fallback);
    if (listener) {
      try { await listener.query(`UNLISTEN ${speakingDocsChannel}`); } catch { /* Đang tắt. */ }
      try { await listener.query('SELECT pg_advisory_unlock($1)', [LEADER_LOCK_ID]); } catch { /* Đang tắt. */ }
      listener.release();
    }
    listener = null;
    leader = false;
  }

  return { enabled, start, kick, pump, close };
}
