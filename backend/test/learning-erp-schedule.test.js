import assert from 'node:assert/strict';
import test from 'node:test';
import { createLearningErpScheduleReader } from '../src/learning-erp-schedule.js';

const columns = ['class_session_id', 'course_class_id', 'starts_at', 'ends_at', 'status']
  .map(name => ({ name }));

test('đọc đúng dòng lịch ERP của một lớp, giữ ID và ngày giờ địa phương', async () => {
  const requests = [];
  const reader = createLearningErpScheduleReader({
    url: 'https://metabase.example.test', username: 'schedule-reader',
    password: 'private-test-value', fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      return {
        ok: true,
        json: async () => requests.length === 1 ? { id: 'private-session' } : {
          data: { cols: columns, rows: [
            [35811, 1294, '2026-09-14 18:30:00', '2026-09-14 21:00:00', 1],
            [35812, 1294, '2026-09-17 18:30:00', '2026-09-17 21:00:00', 0]
          ] }
        }
      };
    }
  });
  const result = await reader('1294');
  assert.deepEqual(result.sessions.map(({ erpSessionId, date }) => ({ erpSessionId, date })), [
    { erpSessionId: '35811', date: '2026-09-14' },
    { erpSessionId: '35812', date: '2026-09-17' }
  ]);
  assert.equal(requests.length, 2);
  assert.match(requests[1].options.body, /course_class_id = 1294/);
  assert.doesNotMatch(requests[1].options.body, /private-test-value/);
  await assert.rejects(() => reader('1294 OR 1=1'), /ERP_SCHEDULE_CLASS_INVALID/);
});

test('dòng lịch khác lớp hoặc phản hồi bị cắt không được dùng để xác nhận', async () => {
  const reader = createLearningErpScheduleReader({
    url: 'https://metabase.example.test', username: 'schedule-reader',
    password: 'private-test-value', fetchImpl: async (url) => ({
      ok: true,
      json: async () => String(url).endsWith('/api/session') ? { id: 'private-session' } : {
        data: { cols: columns, rows: [[35811, 9999,
          '2026-09-14 18:30:00', '2026-09-14 21:00:00', 1]] }
      }
    })
  });
  await assert.rejects(() => reader('1294'), /ERP_SCHEDULE_ROW_INVALID/);
});
