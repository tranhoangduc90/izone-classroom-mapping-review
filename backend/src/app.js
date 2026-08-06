import crypto from 'node:crypto';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import { z } from 'zod';
import { createAuthMiddleware } from './auth.js';
import { listReviewsSql, writeDecisionSql } from './sql.js';

const reviewQuerySchema = z.object({
  class_id: z.string().regex(/^\d+$/).optional(),
  status: z.enum(['pending_review', 'approved', 'rejected', 'superseded', 'all']).default('all')
});

const decisionSchema = z.object({
  reviewId: z.string().uuid(),
  decision: z.enum(['approve', 'reject', 'choose_another', 'edit_mapping', 'reopen']),
  classroomUserId: z.string().trim().min(1).max(255).optional(),
  note: z.string().trim().max(1000).optional().default('')
}).superRefine((value, context) => {
  if (['choose_another', 'edit_mapping'].includes(value.decision) && !value.classroomUserId) {
    context.addIssue({ code: 'custom', path: ['classroomUserId'], message: 'Cần chọn tài khoản Classroom.' });
  }
});

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function addCors(config) {
  return function corsMiddleware(req, res, next) {
    const origin = req.get('origin');
    if (origin && !config.allowedOrigins.has(origin)) {
      return res.status(403).json({ ok: false, error: 'ORIGIN_NOT_ALLOWED', message: 'Nguồn truy cập không được phép.' });
    }
    if (origin) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Vary', 'Origin');
    }
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, x-review-token');
    res.set('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') return res.status(204).end();
    return next();
  };
}

// Tạo Express app bằng dependency injection để có thể kiểm thử mà không cần database thật.
export function createApp({ config, pool, verifyGoogleToken }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxyHops);
  app.use(helmet());
  app.use(addCors(config));
  app.use(rateLimit({
    windowMs: 60_000,
    limit: 120,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { ok: false, error: 'RATE_LIMITED', message: 'Có quá nhiều yêu cầu; vui lòng thử lại sau.' }
  }));
  app.use(express.json({ limit: '32kb', strict: true }));

  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.get('/ready', asyncRoute(async (_req, res) => {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  }));

  const authenticate = createAuthMiddleware({ config, pool, verifyGoogleToken });
  app.get('/api/auth/me', authenticate, (req, res) => {
    res.json({ ok: true, reviewer: req.reviewer });
  });

  app.get('/api/mapping/reviews', authenticate, asyncRoute(async (req, res) => {
    const parsed = reviewQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: 'INVALID_QUERY', message: 'Bộ lọc không hợp lệ.' });
    }

    const result = await pool.query(listReviewsSql, [
      parsed.data.class_id || null,
      parsed.data.status,
      req.reviewer.email,
      req.reviewer.canAccessAllClasses
    ]);
    const response = result.rows[0]?.response || { ok: true, items: [] };
    response.reviewer = req.reviewer;
    return res.json(response);
  }));

  app.post('/api/mapping/reviews/decision', authenticate, asyncRoute(async (req, res) => {
    const parsed = decisionSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: 'INVALID_DECISION', message: 'Dữ liệu quyết định không hợp lệ.' });
    }

    const result = await pool.query(writeDecisionSql, [
      parsed.data.reviewId,
      parsed.data.decision,
      parsed.data.classroomUserId || null,
      parsed.data.note || null,
      req.reviewer.email,
      req.reviewer.canAccessAllClasses
    ]);
    const response = result.rows[0]?.response;
    if (!response) throw new Error('Database không trả kết quả quyết định.');
    return res.status(response.ok ? 200 : 409).json(response);
  }));

  app.use((_req, res) => {
    res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Không tìm thấy endpoint.' });
  });

  app.use((error, _req, res, _next) => {
    const requestId = crypto.randomUUID();
    // Chỉ log mã tra cứu và loại lỗi; không ghi token, payload hoặc dữ liệu học viên.
    console.error(`API error request_id=${requestId} type=${error?.name || 'Error'}`);
    res.status(500).json({ ok: false, error: 'INTERNAL_ERROR', message: 'Hệ thống gặp lỗi tạm thời.', requestId });
  });

  return app;
}
