import { CONTEXT_TTL_MS } from './context-contract.js';

// Chỉ chặn quyền giáo viên và nhận diện/mở lượt mới khi nguồn quá cũ.
// Route lưu/nộp/resume/result/callback đang có token không phụ thuộc nguồn này.
export function createContextGuard({ pool, now = () => Date.now() }) {
  return async function requireFreshContext(_req, res, next) {
    try {
      const row = (await pool.query(`SELECT captured_at FROM mapping.k67_context_state
        WHERE singleton=true AND api_version=1 AND product_id='PRODUCT-TERM-MINI-K67'`)).rows[0];
      const captured = row ? new Date(row.captured_at).getTime() : NaN;
      if (Number.isFinite(captured) && captured <= now() + 5000 && now() - captured <= CONTEXT_TTL_MS) return next();
    } catch { /* Không mở quyền nếu DB/ngữ cảnh không xác nhận được. */ }
    return res.status(503).json({ ok: false, error: 'CONTEXT_UNAVAILABLE',
      message: 'Chưa xác nhận được danh sách lớp và quyền hiện tại. Bài đang làm vẫn được lưu; vui lòng thử mở lớp lại sau.' });
  };
}
