/*
 * Dữ liệu nhận vào: kết nối Learning của container và phiếu Buổi 4 đã phát hành.
 * Việc chính: đọc phiếu qua đúng Learning service, không mở lượt làm hoặc ghi database.
 * Kết quả: xác nhận API ứng viên vẫn đọc được phiếu lớp thật; chỉ in số phần/câu.
 * Khi lỗi: trả exit code 1 và mã lỗi, không in token hoặc tên học viên.
 */
import pg from 'pg';
import { createLearningService } from '../../../src/learning-service.js';

const pool = new pg.Pool({ connectionString: process.env.LEARNING_DATABASE_URL, max: 1 });
try {
  const { rows } = await pool.query(`SELECT public_token::text
    FROM learning.form_assignment
    WHERE upper(class_name_snapshot) = 'IC2305'
      AND session_number = 4 AND status = 'published'`);
  if (rows.length !== 1) throw new Error('SESSION4_ASSIGNMENT_COUNT_MISMATCH');
  const assignment = await createLearningService({ pool }).getPublicAssignment(rows[0].public_token);
  const blocks = assignment.definition?.blocks || [];
  const items = blocks.flatMap(block => block.items || []);
  if (assignment.sessionNumber !== 4 || blocks.length !== 2 || items.length !== 8) {
    throw new Error('SESSION4_PUBLIC_DEFINITION_MISMATCH');
  }
  process.stdout.write(`${JSON.stringify({ outcome: 'passed', sessionNumber: 4,
    blocks: blocks.length, items: items.length })}\n`);
} catch (error) {
  process.stderr.write(`RUNTIME_READBACK_FAILED:${error.code || error.message || 'UNKNOWN'}\n`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
