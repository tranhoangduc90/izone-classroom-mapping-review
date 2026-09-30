import assert from 'node:assert/strict';
import test from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';

const origin = 'https://tranhoangduc90.github.io';
const idleDays = 90;
const absoluteDays = 365;

test('phiên giảng viên production giữ 90 ngày khi hoạt động và tối đa 365 ngày', async () => {
  const calls = [];
  const now = Date.now();
  const pool = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('UPDATE mapping.reviewer_account')) {
        return { rowCount: 1, rows: [{ email: 'teacher@example.invalid',
          display_name: 'Giảng viên thử', role: 'teacher', can_access_all_classes: false }] };
      }
      if (sql.includes('INSERT INTO mapping.reviewer_session')) {
        return { rowCount: 1, rows: [{
          idle_expires_at: new Date(now + idleDays * 86_400_000),
          absolute_expires_at: new Date(now + absoluteDays * 86_400_000)
        }] };
      }
      if (sql.includes('UPDATE mapping.reviewer_session AS session')) {
        return { rowCount: 1, rows: [{ email: 'teacher@example.invalid',
          display_name: 'Giảng viên thử', role: 'teacher', can_access_all_classes: false,
          idle_expires_at: new Date(now + idleDays * 86_400_000),
          absolute_expires_at: new Date(now + absoluteDays * 86_400_000) }] };
      }
      if (sql.includes("revoked_reason = COALESCE(revoked_reason, 'logout')")) {
        return { rowCount: 1, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    }
  };
  const app = createApp({
    config: {
      nodeEnv: 'production', authMode: 'google', googleClientId: 'test-client',
      allowedOrigins: new Set([origin]), trustProxyHops: 0,
      teacherSessionIdleDays: idleDays,
      teacherSessionAbsoluteDays: absoluteDays,
      teacherSessionCookieName: 'izone_teacher_session',
      teacherSessionCookiePath: '/mapping-api',
      teacherSessionCookieSecure: true,
      teacherSessionCookieSameSite: 'None',
      teacherSessionCookiePartitioned: true
    },
    pool,
    verifyGoogleToken: async () => ({ email: 'teacher@example.invalid',
      sub: 'google-subject-test', email_verified: true, name: 'Giảng viên thử' })
  });
  const login = await request(app).post('/api/auth/session')
    .set('Origin', origin).send({ credential: 'google-credential-for-test-only' });
  assert.equal(login.status, 201);
  const cookie = login.headers['set-cookie'][0];
  assert.match(cookie, /HttpOnly/u);
  assert.match(cookie, /Secure/u);
  assert.match(cookie, /SameSite=None/u);
  assert.match(cookie, /Partitioned/u);
  assert.match(cookie, /Path=\/mapping-api/u);
  const maxAge = Number(cookie.match(/Max-Age=(\d+)/u)?.[1]);
  assert(maxAge >= 89 * 86_400 && maxAge <= 90 * 86_400);
  const inserted = calls.find(call => call.sql.includes('INSERT INTO mapping.reviewer_session'));
  assert.deepEqual(inserted.params.slice(-2), [idleDays, absoluteDays]);

  const restored = await request(app).get('/api/auth/session')
    .set('Origin', origin).set('Cookie', cookie.split(';', 1)[0]);
  assert.equal(restored.status, 200);
  const renewal = calls.find(call => call.sql.includes('UPDATE mapping.reviewer_session AS session'));
  assert.equal(renewal.params[1], idleDays);
  assert.match(renewal.sql, /LEAST\(session\.absolute_expires_at/u);

  const logout = await request(app).delete('/api/auth/session')
    .set('Origin', origin).set('x-izone-csrf', '1')
    .set('Cookie', cookie.split(';', 1)[0]);
  assert.equal(logout.status, 200);
  assert.match(logout.headers['set-cookie'][0], /Max-Age=0/u);
  assert(calls.some(call => call.sql.includes("revoked_reason = COALESCE(revoked_reason, 'logout')")));
});
