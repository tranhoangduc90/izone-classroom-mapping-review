import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../src/config.js';

const baseEnv = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://example.test/main',
  LEARNING_ENABLED: 'true',
  LEARNING_DATABASE_URL: 'postgres://example.test/learning',
  AUTH_MODE: 'legacy',
  LEGACY_REVIEW_TOKEN: 'test-token-12345',
  ERP_SYNC_URL: 'https://example.test/erp',
  ERP_SYNC_SECRET: 's'.repeat(32)
};

test('production Progress Log không khởi động khi thiếu URL điểm danh Portal', () => {
  assert.throws(() => loadConfig(baseEnv), /LEARNING_ATTENDANCE_SYNC_URL/);
  assert.equal(loadConfig({
    ...baseEnv,
    LEARNING_ATTENDANCE_SYNC_URL: 'https://example.test/attendance'
  }).learningAttendanceSyncUrl, 'https://example.test/attendance');
  assert.equal(loadConfig({ ...baseEnv, NODE_ENV: 'test' }).learningAttendanceSyncUrl, '');
});
