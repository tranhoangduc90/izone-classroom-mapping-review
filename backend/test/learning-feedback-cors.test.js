import assert from 'node:assert/strict';
import test from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';

test('trình duyệt Pages được phép gửi PUT nhận xét Speaking với CSRF header', async () => {
  const app = createApp({
    config: {
      nodeEnv: 'test',
      port: 8788,
      databaseUrl: 'postgresql://unused-in-tests',
      dbPoolMax: 2,
      authMode: 'legacy',
      googleClientId: '',
      legacyReviewToken: 'test-only-token',
      allowedOrigins: new Set(['https://tranhoangduc90.github.io']),
      trustProxyHops: 0
    },
    pool: { query: async () => ({ rowCount: 0, rows: [] }) }
  });

  const response = await request(app)
    .options('/api/learning/teacher/session-feedback')
    .set('Origin', 'https://tranhoangduc90.github.io')
    .set('Access-Control-Request-Method', 'PUT')
    .set('Access-Control-Request-Headers', 'content-type,x-izone-csrf');

  assert.equal(response.status, 204);
  assert.equal(response.headers['access-control-allow-origin'], 'https://tranhoangduc90.github.io');
  assert.equal(response.headers['access-control-allow-credentials'], 'true');
  assert.match(response.headers['access-control-allow-headers'], /x-izone-csrf/i);
  assert.match(response.headers['access-control-allow-methods'], /(?:^|,\s*)PUT(?:,|$)/);
});
