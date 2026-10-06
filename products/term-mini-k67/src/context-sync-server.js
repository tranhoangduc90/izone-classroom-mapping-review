import pg from 'pg';
import { applyContextSnapshot, fetchContextSnapshot } from './context-sync.js';

// Tiến trình riêng nhận API mỗi 30 giây, ghi mirror bằng role không có quyền bài thi.
// Lỗi giữ snapshot cũ và báo mã cố định; không ghi URL/khóa/danh sách người vào log.
let db, api;
try {
  db = new URL(process.env.K67_CONTEXT_DATABASE_URL || '');
  api = new URL(process.env.K67_CONTEXT_API_URL || '');
} catch { throw new Error('CONTEXT_SYNC_CONFIG_INVALID'); }
const secret = process.env.K67_CONTEXT_API_SECRET || '';
if (!['postgres:', 'postgresql:'].includes(db.protocol) || db.username !== 'k67_context_sync'
    || !/^\/term_mini_k67(?:_test_[a-z0-9_]+)?$/.test(db.pathname) || db.search || db.hash
    || api.protocol !== 'https:' || api.pathname !== '/term-mini-k67-context/v1/snapshot'
    || api.username || api.password || api.hash || api.search || secret.length < 32) throw new Error('CONTEXT_SYNC_CONFIG_INVALID');
const pool = new pg.Pool({ connectionString: db.href, max: 2, statement_timeout: 10000, connectionTimeoutMillis: 5000 });
const identity = (await pool.query('SELECT current_database() AS db,current_user AS role')).rows[0];
if (`/${identity.db}` !== db.pathname || identity.role !== 'k67_context_sync') throw new Error('CONTEXT_SYNC_IDENTITY_INVALID');
let stopping = false;
let wake;
function stop() { stopping = true; wake?.(); }
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
while (!stopping) {
  try {
    const snapshot = await fetchContextSnapshot({ url: api.href, secret });
    await applyContextSnapshot(pool, snapshot);
    console.log(JSON.stringify({ event: 'k67_context_applied', sourceRevision: snapshot.sourceRevision, capturedAt: snapshot.capturedAt }));
  } catch { console.error(JSON.stringify({ event: 'k67_context_unavailable' })); }
  if (!stopping) await new Promise(resolve => { const timer = setTimeout(resolve, 30000); wake = () => { clearTimeout(timer); resolve(); }; });
}
await pool.end();
