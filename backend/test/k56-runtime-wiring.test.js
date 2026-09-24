import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('server truyền pool K56 vào tuyến đồng bộ điểm Portal', () => {
  // K56 phải đọc cổng quyền lớp–đề và ghi trạng thái đồng bộ bằng cùng pool đã cách ly schema.
  // Nếu chỉ truyền config, tuyến này trả disabled dù bài đã được chấm xong.
  const source = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  assert.ok(/createErpGradeSync\(\{\s*config,\s*pool\s*\}\)/.test(source),
    'Server phải truyền pool đã cách ly schema vào đồng bộ điểm K56.');
});

test('đối soát roster chỉ khởi chạy khi profile K56 được bật rõ ràng', () => {
  const source = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  assert.ok(/startK56RosterReconciler\(\{\s*pool,\s*enabled:\s*config\.k56RosterReconcileEnabled/.test(source));
  assert.ok(/await k56RosterReconciler\.stop\(\)/.test(source));
});
