/*
 * Dữ liệu nhận vào: app.js trong image API đang chạy.
 * Việc chính: bổ sung các phương thức được trình duyệt phép gọi khi kiểm tra CORS.
 * Kết quả: học viên lưu nháp bằng PATCH và giảng viên gửi nhận xét bằng PUT được.
 * Khi lỗi: dừng build nếu image gốc đã đổi hoặc có nhiều vị trí cần sửa.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const path = '/app/src/app.js';
const expectedHash = 'a2b8523e1268a67be980a75b1b79d0d4130d3cdb1d6175b423e321531766acf4';
const original = readFileSync(path);
const actualHash = createHash('sha256').update(original).digest('hex');
if (actualHash !== expectedHash) throw new Error('APP_SOURCE_CHANGED');

const source = original.toString('utf8');
const marker = "    res.set('Access-Control-Allow-Credentials', 'true');";
const addition = "\n    res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');";
if (source.split(marker).length !== 2 || source.includes('Access-Control-Allow-Methods')) {
  throw new Error('CORS_PATCH_GUARD_FAILED');
}
writeFileSync(path, source.replace(marker, `${marker}${addition}`), 'utf8');
