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

test('cấu hình đọc lịch ERP là tùy chọn nhưng phải đầy đủ và dùng HTTPS', () => {
  const env = { ...baseEnv, NODE_ENV: 'test',
    LEARNING_ERP_SCHEDULE_METABASE_URL: '' };
  assert.equal(loadConfig(env).learningErpScheduleMetabaseUrl, '');
  assert.throws(() => loadConfig({ ...env,
    LEARNING_ERP_SCHEDULE_METABASE_URL: 'https://metabase.example.test'
  }), /Cấu hình đọc lịch ERP/);
  assert.throws(() => loadConfig({ ...env,
    LEARNING_ERP_SCHEDULE_METABASE_URL: 'http://metabase.example.test',
    LEARNING_ERP_SCHEDULE_METABASE_USERNAME: 'schedule-reader',
    LEARNING_ERP_SCHEDULE_METABASE_PASSWORD: 'private-test-value'
  }), /HTTPS/);
  assert.equal(loadConfig({ ...env,
    LEARNING_ERP_SCHEDULE_METABASE_URL: 'https://metabase.example.test',
    LEARNING_ERP_SCHEDULE_METABASE_USERNAME: 'schedule-reader',
    LEARNING_ERP_SCHEDULE_METABASE_PASSWORD: 'private-test-value'
  }).learningErpScheduleMetabaseUsername, 'schedule-reader');
});
