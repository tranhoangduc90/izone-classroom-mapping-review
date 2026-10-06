// Nhận HTTP từ phép thử K67; chuyển API tới backend cố định và giả lập Portal.
// Chỉ ba học viên giả được ghi điểm; sai khóa/đích bị từ chối. Không gọi Portal thật.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export const fixtureIdentity = 'PRODUCT-TERM-MINI-K67:synthetic-live-http-v1';
export const students = Object.freeze([9870677001, 9870677002, 9870677003]);
const tests = Array.from({ length: 6 }, (_, i) => ({ id: 6701 + i,
  name: `Phase ${Math.floor(i / 3) + 1} ${['Listening','Reading','Writing'][i % 3]}` }));
function initialState(intent) {
  return { identity: fixtureIdentity, fixture_intent: intent, fault: 'none', audit: [],
    class_tests: tests, student_test_grades: students.flatMap((student, index) => tests.map((test, j) => ({
      student_id: student, class_test_id: test.id, grade: null,
      meta: { records: [{ id: 670000 + index * 10 + j }] }
    }))) };
}
function authorized(supplied, expected) {
  const a = Buffer.from(String(supplied || '')), b = Buffer.from(String(expected || ''));
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}
async function body(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error('BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
export function createFixtureGateway({ backend, portalSecret, controlSecret, statePath = null, intent = '0'.repeat(32) }) {
  const target = new URL(backend);
  if (target.protocol !== 'http:' || target.pathname !== '/' || target.search || target.hash
      || target.username || target.password || portalSecret.length < 32 || controlSecret.length < 32
      || portalSecret === controlSecret || !/^[0-9a-f]{32}$/.test(intent)) throw new Error('INVALID_FIXTURE_CONFIG');
  let state = statePath && fs.existsSync(statePath)
    ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : initialState(intent);
  if (state.identity !== fixtureIdentity || state.fixture_intent !== intent || JSON.stringify(state.class_tests) !== JSON.stringify(tests)
      || state.student_test_grades.length !== students.length * tests.length
      || state.student_test_grades.some(row => !students.includes(row.student_id)
        || !tests.some(test => test.id === row.class_test_id))) throw new Error('FIXTURE_STATE_MISMATCH');
  function save() {
    if (!statePath) return;
    const temporary = `${statePath}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(state), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, statePath);
  }
  save();
  function reply(res, code, value) {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(value));
  }
  const server = http.createServer(async (req, res) => {
    try {
      // Tiền tố riêng bị bỏ ở đây giống Nginx dự kiến; upstream không lấy từ dữ liệu khách.
      if (req.url.startsWith('/term-mini-k67-api/')) {
        const data = await body(req);
        const headers = { ...req.headers, host: target.host };
        delete headers['x-k67-fixture-control']; delete headers['x-k67-fixture-service'];
        const upstream = http.request({ hostname: target.hostname, port: target.port, method: req.method,
          path: req.url.slice('/term-mini-k67-api'.length), headers }, incoming => {
          res.writeHead(incoming.statusCode, incoming.headers); incoming.pipe(res);
          incoming.on('error', () => res.destroy());
        });
        upstream.setTimeout(15000, () => upstream.destroy(new Error('UPSTREAM_TIMEOUT')));
        upstream.on('error', () => {
          if (!res.headersSent) reply(res, 502, { ok: false, error: 'FIXTURE_UPSTREAM_ERROR' });
          else res.destroy();
        });
        req.on('aborted', () => upstream.destroy());
        res.on('close', () => upstream.destroy());
        upstream.end(data); return;
      }
      if (req.url === '/fixture/ready' && req.method === 'GET') {
        reply(res, 200, { ok: true, identity: fixtureIdentity }); return;
      }
      if (req.url === '/fixture/state' || req.url === '/fixture/control') {
        if (!authorized(req.headers['x-k67-fixture-control'], controlSecret)) {
          reply(res, 401, { ok: false, error: 'FIXTURE_UNAUTHORIZED' }); return;
        }
        if (req.url === '/fixture/state' && req.method === 'GET') { reply(res, 200, state); return; }
        if (req.url === '/fixture/control' && req.method === 'POST') {
          const data = JSON.parse((await body(req)).toString());
          if (!['none','write_then_disconnect','ack_without_write'].includes(data.fault) || Object.keys(data).length !== 1) {
            reply(res, 422, { ok: false }); return;
          }
          state.fault = data.fault; save(); reply(res, 200, { ok: true }); return;
        }
        reply(res, 405, { ok: false }); return;
      }
      if (req.url !== '/portal/v1/course-classes/1124/student-tests') {
        reply(res, 404, { ok: false, error: 'FIXTURE_TARGET_DENIED' }); return;
      }
      if (!authorized(req.headers['x-k67-fixture-service'], portalSecret)) {
        reply(res, 401, { ok: false, error: 'FIXTURE_UNAUTHORIZED' }); return;
      }
      if (req.method === 'GET') {
        state.audit.push({ method: 'GET', classId: 1124 }); save();
        reply(res, 200, { class_tests: state.class_tests, student_test_grades: state.student_test_grades }); return;
      }
      if (req.method !== 'PUT') { reply(res, 405, { ok: false }); return; }
      const data = JSON.parse((await body(req)).toString());
      const row = state.student_test_grades.find(item => item.student_id === data.student_id
        && item.class_test_id === data.class_test_id);
      if (!row || !Number.isFinite(data.grade) || data.grade < 0 || data.grade > 9
          || Math.round(data.grade * 2) !== data.grade * 2 || data.record_id !== row.meta.records[0].id
          || Object.keys(data).sort().join(',') !== 'class_test_id,grade,record_id,student_id') {
        reply(res, 422, { ok: false, error: 'FIXTURE_INVALID_WRITE' }); return;
      }
      if (row.grade !== null && row.grade !== data.grade) {
        reply(res, 409, { ok: false, error: 'FIXTURE_EXISTING_GRADE' }); return;
      }
      // Diễn tập Portal trả ACK nhưng ô vẫn trống; tiêu thụ fault đúng một PUT.
      // Chỉ đích giả/khóa điều khiển riêng được phép bật tình huống này.
      if (state.fault === 'ack_without_write') {
        state.audit.push({ method: 'PUT', classId: 1124, ...data, fault: 'ack_without_write' });
        state.fault = 'none'; save(); reply(res, 200, { ok: true }); return;
      }
      row.grade = data.grade;
      state.audit.push({ method: 'PUT', classId: 1124, ...data });
      const disconnect = state.fault === 'write_then_disconnect'; state.fault = 'none'; save();
      if (disconnect) { req.socket.destroy(); return; }
      reply(res, 200, { ok: true });
    } catch (error) {
      if (!res.headersSent) reply(res, 422, { ok: false, error: error.message === 'BODY_TOO_LARGE' ? 'BODY_TOO_LARGE' : 'FIXTURE_INVALID_REQUEST' });
      else res.destroy();
    }
  });
  server.requestTimeout = 17000; server.headersTimeout = 18000;
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createFixtureGateway({ backend: 'http://term-mini-k67-http-fixture:8796',
    portalSecret: process.env.K67_FIXTURE_PORTAL_SECRET || '',
    controlSecret: process.env.K67_FIXTURE_CONTROL_SECRET || '', statePath: '/fixture-state/portal.json',
    intent: process.env.K67_FIXTURE_INTENT || '' });
  server.listen(8876, '0.0.0.0');
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
}
