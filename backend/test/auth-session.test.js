import assert from 'node:assert/strict';
import test from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';

const origin = 'https://tranhoangduc90.github.io';

function config() {
  return {
    nodeEnv: 'test',
    authMode: 'google',
    googleClientId: 'client-for-test',
    allowedOrigins: new Set([origin]),
    trustProxyHops: 0,
    teacherSessionIdleDays: 90,
    teacherSessionAbsoluteDays: 365,
    teacherSessionCookieName: 'izone_teacher_session',
    teacherSessionCookiePath: '/mapping-api',
    teacherSessionCookieSecure: false,
    teacherSessionCookieSameSite: 'Lax'
  };
}

function pool() {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('UPDATE mapping.reviewer_account')) {
        return { rowCount: 1, rows: [{ email: 'teacher@example.invalid', display_name: 'Giảng viên thử', role: 'teacher', can_access_all_classes: false }] };
      }
      if (sql.includes('INSERT INTO mapping.reviewer_session')) {
        return { rowCount: 1, rows: [{ idle_expires_at: new Date(Date.now() + 90 * 86_400_000), absolute_expires_at: new Date(Date.now() + 365 * 86_400_000) }] };
      }
      if (sql.includes('UPDATE mapping.reviewer_session AS session')) {
        return { rowCount: 1, rows: [{ email: 'teacher@example.invalid', display_name: 'Giảng viên thử', role: 'teacher', can_access_all_classes: false, idle_expires_at: new Date(Date.now() + 90 * 86_400_000), absolute_expires_at: new Date(Date.now() + 365 * 86_400_000) }] };
      }
      if (sql.includes("revoked_reason = COALESCE(revoked_reason, 'logout')")) return { rowCount: 1, rows: [] };
      return { rowCount: 0, rows: [] };
    }
  };
}

test('Google credential chỉ mở phiên; cookie HttpOnly được khôi phục rồi thu hồi khi đăng xuất', async () => {
  const database = pool();
  const app = createApp({
    config: config(),
    pool: database,
    verifyGoogleToken: async () => ({ email: 'teacher@example.invalid', sub: 'google-subject-test', email_verified: true, name: 'Giảng viên thử' })
  });
  const login = await request(app)
    .post('/api/auth/session')
    .set('Origin', origin)
    .send({ credential: 'google-credential-for-test-only' });
  assert.equal(login.status, 201);
  const setCookie = login.headers['set-cookie'][0];
  assert.match(setCookie, /^izone_teacher_session=[A-Za-z0-9_-]{43};/u);
  assert.match(setCookie, /Path=\/mapping-api/u);
  assert.match(setCookie, /HttpOnly/u);
  assert.match(setCookie, /SameSite=Lax/u);
  assert.equal(JSON.stringify(database.calls).includes('google-credential-for-test-only'), false);

  const cookie = setCookie.split(';', 1)[0];
  const restored = await request(app).get('/api/auth/session').set('Origin', origin).set('Cookie', cookie);
  assert.equal(restored.status, 200);
  assert.equal(restored.body.reviewer.email, 'teacher@example.invalid');
  assert.equal(restored.headers['access-control-allow-credentials'], 'true');

  const rejectedLogout = await request(app).delete('/api/auth/session').set('Origin', origin).set('Cookie', cookie);
  assert.equal(rejectedLogout.status, 403);
  assert.equal(rejectedLogout.body.error, 'CSRF_REJECTED');

  const logout = await request(app)
    .delete('/api/auth/session')
    .set('Origin', origin)
    .set('x-izone-csrf', '1')
    .set('Cookie', cookie);
  assert.equal(logout.status, 200);
  assert.match(logout.headers['set-cookie'][0], /Max-Age=0/u);
  assert.equal(database.calls.some(call => call.sql.includes("revoked_reason = COALESCE(revoked_reason, 'logout')")), true);
});

test('cookie giả bị xóa và không được dùng làm Bearer', async () => {
  const database = { query: async () => ({ rowCount: 0, rows: [] }) };
  const app = createApp({ config: config(), pool: database, verifyGoogleToken: async () => { throw new Error('Không được gọi'); } });
  const response = await request(app)
    .get('/api/auth/session')
    .set('Origin', origin)
    .set('Cookie', `izone_teacher_session=${'a'.repeat(43)}`);
  assert.equal(response.status, 401);
  assert.match(response.headers['set-cookie'][0], /Max-Age=0/u);
});
