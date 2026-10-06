import pg from 'pg';
import { createContextSourceApp } from './context-source.js';

// Dịch vụ nguồn riêng đọc view bằng role chỉ đọc; backend thi không có URL DB này.
// Thiếu cấu hình hoặc danh tính DB sai dừng sớm, không in credential.
let url;
try { url = new URL(process.env.K67_CONTEXT_SOURCE_DATABASE_URL || ''); }
catch { throw new Error('CONTEXT_SOURCE_DATABASE_INVALID'); }
if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.username !== 'k67_context_reader'
    || url.pathname !== '/mapping_db' || url.search || url.hash) throw new Error('CONTEXT_SOURCE_DATABASE_INVALID');
const secret = process.env.K67_CONTEXT_SOURCE_SECRET;
const pool = new pg.Pool({ connectionString: url.href, max: 2, statement_timeout: 5000,
  connectionTimeoutMillis: 5000, application_name: 'k67_context_source_v1' });
const identity = (await pool.query('SELECT current_database() AS db,current_user AS role')).rows[0];
if (identity.db !== 'mapping_db' || identity.role !== 'k67_context_reader') throw new Error('CONTEXT_SOURCE_IDENTITY_INVALID');
const app = createContextSourceApp({ pool, secret });
const server = app.listen(8797, '0.0.0.0');
server.requestTimeout = 6000;
server.headersTimeout = 7000;
function stop() { server.close(async () => { await pool.end(); process.exit(0); }); setTimeout(() => process.exit(1), 10000).unref(); }
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
