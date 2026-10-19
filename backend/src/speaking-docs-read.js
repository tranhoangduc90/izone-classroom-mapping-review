import { readFileSync } from 'node:fs';
import { SpeakingHomeworkError } from './speaking-homework.js';

const validId = /^[A-Za-z0-9_-]{5,120}$/;
const failure = (code, message, status = 503) => new SpeakingHomeworkError(code, message, status);
const unavailable = () => failure('DOC_READ_UNAVAILABLE', 'Chưa đọc được Google Docs. Bài đã lưu vẫn được giữ; hãy thử mở lại.');

// Đọc cấu hình riêng trên máy chủ; không để nội dung khóa xuất hiện trong lỗi hoặc log.
export function loadDocsReadCredentials(file) {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    const keys = ['clientId', 'clientSecret', 'refreshToken'];
    if (keys.some(key => typeof data[key] !== 'string' || !data[key].trim())) throw new Error();
    return Object.fromEntries(keys.map(key => [key, data[key]]));
  } catch { throw new Error('DOCS_READ_CONFIG_INVALID'); }
}

// Đầu vào: Docs ID và cấu hình Google chỉ ở máy chủ. Chỉ đọc Docs, không ghi Google.
// Gộp lượt đang chờ, giới hạn tải và toàn thời gian chờ; lỗi không trả nội dung cũ.
export function createDirectDocsReader({ credentials, call = fetch, now = Date.now,
  timeoutMs = 7500, tokenTimeoutMs = 3000, concurrency = 6, maxPending = 30 } = {}) {
  if (!credentials || ['clientId', 'clientSecret', 'refreshToken'].some(key => !credentials[key]))
    throw new Error('DOCS_READ_CONFIG_INVALID');
  if (![timeoutMs, tokenTimeoutMs, concurrency, maxPending].every(Number.isSafeInteger)
      || Math.min(timeoutMs, tokenTimeoutMs, concurrency, maxPending) <= 0 || maxPending < concurrency)
    throw new Error('DOCS_READ_LIMITS_INVALID');
  let token = null, refreshing = null, active = 0;
  const pending = new Map(), waiting = [];

  async function within(promise, signal) {
    signal.throwIfAborted();
    let listener;
    try {
      return await Promise.race([promise, new Promise((_, reject) => {
        listener = () => reject(signal.reason);
        signal.addEventListener('abort', listener, { once: true });
      })]);
    } finally { signal.removeEventListener('abort', listener); }
  }
  function release() {
    active -= 1;
    while (waiting.length && active < concurrency) {
      const next = waiting.shift();
      if (!next.signal.aborted) { active += 1; next.granted = true; next.resolve(); break; }
    }
  }
  async function acquire(signal) {
    signal.throwIfAborted();
    if (active < concurrency) { active += 1; return; }
    let entry;
    try { await within(new Promise(resolve => {
      entry = { resolve, signal, granted: false }; waiting.push(entry);
    }), signal); }
    catch (error) {
      const index = waiting.indexOf(entry);
      if (index >= 0) waiting.splice(index, 1);
      else if (entry?.granted) release();
      throw error;
    }
  }
  async function accessToken(signal) {
    if (token && token.expiresAt > now() + 60000) return token.value;
    if (!refreshing) {
      refreshing = (async () => {
        const refreshSignal = AbortSignal.timeout(tokenTimeoutMs);
        const response = await within(call('https://oauth2.googleapis.com/token', {
          method: 'POST', redirect: 'error', headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'refresh_token', client_id: credentials.clientId,
            client_secret: credentials.clientSecret, refresh_token: credentials.refreshToken }),
          signal: refreshSignal,
        }), refreshSignal);
        const data = await within(response.json(), refreshSignal);
        if (!response.ok || typeof data.access_token !== 'string' || !Number.isFinite(Number(data.expires_in))
            || Number(data.expires_in) <= 60) throw unavailable();
        token = { value: data.access_token, expiresAt: now() + Number(data.expires_in) * 1000 };
        return token.value;
      })().finally(() => { refreshing = null; });
    }
    return within(refreshing, signal);
  }
  async function read(documentId) {
    const signal = AbortSignal.timeout(timeoutMs);
    let acquired = false;
    try {
      await acquire(signal); acquired = true;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const bearer = await accessToken(signal);
        const response = await within(call(`https://docs.googleapis.com/v1/documents/${encodeURIComponent(documentId)}?includeTabsContent=true`, {
          method: 'GET', redirect: 'error', headers: { authorization: `Bearer ${bearer}` }, signal,
        }), signal);
        if (response.status === 401 && attempt === 0) {
          // Token có thể bị thu hồi sớm; chỉ bỏ đúng token vừa bị từ chối, không xóa token mới của lượt khác.
          if (token?.value === bearer) token = null;
          continue;
        }
        if (response.status === 403) throw failure('DOC_READ_FORBIDDEN', 'Hệ thống chưa có quyền đọc Docs này. Hãy kiểm tra quyền chia sẻ của bản Homework.', 403);
        if (response.status === 404) throw failure('DOC_READ_NOT_FOUND', 'Không tìm thấy bản Homework hoặc tài khoản hệ thống chưa được chia sẻ file.', 404);
        if (!response.ok) throw unavailable();
        const document = await within(response.json(), signal);
        if (document?.documentId !== documentId || !document.revisionId || !Array.isArray(document.tabs)) throw unavailable();
        return document;
      }
      throw unavailable();
    } catch (error) {
      if (error instanceof SpeakingHomeworkError) throw error;
      throw unavailable();
    } finally { if (acquired) release(); }
  }
  return {
    get(documentId) {
      if (!validId.test(documentId || '')) return Promise.reject(failure('INVALID_DOCUMENT_ID', 'Mã Google Docs chưa hợp lệ.', 400));
      if (pending.has(documentId)) return pending.get(documentId);
      if (pending.size >= maxPending) return Promise.reject(failure('DOC_READ_BUSY', 'Đang có nhiều lượt mở Docs. Hãy đợi vài giây rồi thử lại.'));
      const result = read(documentId).finally(() => { pending.delete(documentId); });
      pending.set(documentId, result);
      return result;
    },
  };
}

// Đường mở bài dùng đọc trực tiếp khi đã bật; đường ghi biên nhận vẫn giữ gateway cũ.
export function createOpeningDocsGateway({ gateway, credentialFile, readCredentials = loadDocsReadCredentials, call = fetch }) {
  if (!gateway || !credentialFile) return gateway;
  const reader = createDirectDocsReader({ credentials: readCredentials(credentialFile), call });
  return { get: reader.get, write: gateway.write };
}
