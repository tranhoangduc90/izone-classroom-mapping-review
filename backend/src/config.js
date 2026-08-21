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
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(3).default(1),
  ERP_SYNC_URL: z.string().url().optional().default(''),
  ERP_SYNC_SECRET: z.string().optional().default(''),
  ERP_SYNC_TIMEOUT_MS: z.coerce.number().int().min(1000).max(10000).default(5000),
  MINI_TEST_SYNC_SECRET: z.string().optional().default(''),
  WRITING_TEST_SYNC_SECRET: z.string().optional().default(''),
  TERM_TEST_PUBLIC_API_BASE_URL: z.string().url().trim().optional().default(''),
  TERM_TEST_ASSET_DIR: z.string().trim().optional().default(''),
  TERM_TEST_SESSION_SECRET: z.string().optional().default(''),
  APP_VERSION: z.string().trim().max(100).default('1.0.0'),
  BUILD_SHA: z.string().trim().regex(/^(?:unknown|[0-9a-f]{7,64})$/i).default('unknown')
}).superRefine((value, context) => {
  if (Boolean(value.ERP_SYNC_URL) !== Boolean(value.ERP_SYNC_SECRET)) {
    context.addIssue({ code: 'custom', message: 'ERP_SYNC_URL và ERP_SYNC_SECRET phải được cấu hình cùng nhau.' });
  }
  if (value.ERP_SYNC_SECRET && value.ERP_SYNC_SECRET.length < 32) {
    context.addIssue({ code: 'custom', path: ['ERP_SYNC_SECRET'], message: 'ERP_SYNC_SECRET phải có ít nhất 32 ký tự.' });
  }
  if (value.MINI_TEST_SYNC_SECRET && value.MINI_TEST_SYNC_SECRET.length < 32) {
    context.addIssue({ code: 'custom', path: ['MINI_TEST_SYNC_SECRET'], message: 'MINI_TEST_SYNC_SECRET phải có ít nhất 32 ký tự.' });
  }
  if (value.WRITING_TEST_SYNC_SECRET && value.WRITING_TEST_SYNC_SECRET.length < 32) {
    context.addIssue({ code: 'custom', path: ['WRITING_TEST_SYNC_SECRET'], message: 'WRITING_TEST_SYNC_SECRET phải có ít nhất 32 ký tự.' });
  }
  if (Boolean(value.TERM_TEST_ASSET_DIR) !== Boolean(value.TERM_TEST_SESSION_SECRET)) {
    context.addIssue({ code: 'custom', message: 'TERM_TEST_ASSET_DIR và TERM_TEST_SESSION_SECRET phải được cấu hình cùng nhau.' });
  }
  if (value.TERM_TEST_SESSION_SECRET && value.TERM_TEST_SESSION_SECRET.length < 32) {
    context.addIssue({ code: 'custom', path: ['TERM_TEST_SESSION_SECRET'], message: 'TERM_TEST_SESSION_SECRET phải có ít nhất 32 ký tự.' });
  }
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
    trustProxyHops: parsed.TRUST_PROXY_HOPS,
    erpSyncUrl: parsed.ERP_SYNC_URL,
    erpSyncSecret: parsed.ERP_SYNC_SECRET,
    erpSyncTimeoutMs: parsed.ERP_SYNC_TIMEOUT_MS,
    miniTestSyncSecret: parsed.MINI_TEST_SYNC_SECRET,
    writingTestSyncSecret: parsed.WRITING_TEST_SYNC_SECRET,
    termTestPublicApiBaseUrl: parsed.TERM_TEST_PUBLIC_API_BASE_URL.replace(/\/+$/, ''),
    termTestAssetDir: parsed.TERM_TEST_ASSET_DIR,
    termTestSessionSecret: parsed.TERM_TEST_SESSION_SECRET,
    appVersion: parsed.APP_VERSION,
    buildSha: parsed.BUILD_SHA
  };
}
