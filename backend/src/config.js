import { z } from 'zod';

// Nhận biến môi trường, kiểm tra kiểu dữ liệu và dừng sớm nếu cấu hình production bị thiếu.
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8788),
  DATABASE_URL: z.string().min(1),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(30).default(10),
  AUTH_MODE: z.enum(['google', 'legacy']).default('google'),
  GOOGLE_CLIENT_ID: z.string().trim().optional().default(''),
  LEGACY_REVIEW_TOKEN: z.string().optional().default(''),
  ALLOWED_ORIGINS: z.string().min(1).default('https://tranhoangduc90.github.io'),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(3).default(1)
});

export function loadConfig(env = process.env) {
  const parsed = envSchema.parse(env);
  if (parsed.AUTH_MODE === 'google' && !parsed.GOOGLE_CLIENT_ID) {
    throw new Error('GOOGLE_CLIENT_ID là bắt buộc khi AUTH_MODE=google.');
  }
  if (parsed.AUTH_MODE === 'legacy' && parsed.LEGACY_REVIEW_TOKEN.length < 10) {
    throw new Error('LEGACY_REVIEW_TOKEN phải có ít nhất 10 ký tự khi AUTH_MODE=legacy.');
  }

  return {
    nodeEnv: parsed.NODE_ENV,
    port: parsed.PORT,
    databaseUrl: parsed.DATABASE_URL,
    dbPoolMax: parsed.DB_POOL_MAX,
    authMode: parsed.AUTH_MODE,
    googleClientId: parsed.GOOGLE_CLIENT_ID,
    legacyReviewToken: parsed.LEGACY_REVIEW_TOKEN,
    allowedOrigins: new Set(parsed.ALLOWED_ORIGINS.split(',').map(value => value.trim()).filter(Boolean)),
    trustProxyHops: parsed.TRUST_PROXY_HOPS
  };
}
