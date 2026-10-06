import { z } from 'zod';

// Nhận cấu hình có tiền tố K67; kiểm đúng DB/đường API và khóa riêng trước khởi động.
// Thiếu/sai cấu hình: dừng với tên trường, không in giá trị bí mật.
const secret = z.string().min(32);
const positive = (min, max, fallback) => z.coerce.number().int().min(min).max(max).default(fallback);
const schema = z.object({
  K67_ENV: z.enum(['production', 'test', 'development']).default('production'),
  K67_PORT: positive(1, 65535, 8796),
  K67_DATABASE_URL: z.url(),
  K67_DB_POOL_MAX: positive(1, 10, 5),
  K67_AUTH_MODE: z.enum(['google', 'legacy']).default('google'),
  K67_GOOGLE_CLIENT_ID: z.string().trim().default(''),
  K67_LEGACY_REVIEW_TOKEN: z.string().default(''),
  K67_ALLOWED_ORIGINS: z.string().min(1).default('https://tranhoangduc90.github.io'),
  K67_TEACHER_SESSION_IDLE_DAYS: positive(1, 180, 90),
  K67_TEACHER_SESSION_ABSOLUTE_DAYS: positive(1, 730, 365),
  K67_TRUST_PROXY_HOPS: positive(0, 3, 1),
  K67_ERP_SYNC_URL: z.union([z.literal(''), z.url()]).default(''),
  K67_ERP_SYNC_SECRET: z.union([z.literal(''), secret]).default(''),
  K67_ERP_SYNC_TIMEOUT_MS: positive(1000, 60000, 5000),
  K67_MINI_SYNC_SECRET: z.union([z.literal(''), secret]).default(''),
  K67_WRITING_SYNC_SECRET: z.union([z.literal(''), secret]).default(''),
  K67_NOTIFY_URL: z.union([z.literal(''), z.url()]).default(''),
  K67_NOTIFY_SECRET: z.union([z.literal(''), secret]).default(''),
  K67_PUBLIC_API_BASE_URL: z.url(),
  K67_ASSET_DIR: z.string().trim().min(1),
  K67_SESSION_SECRET: secret,
  K67_APP_VERSION: z.string().trim().min(1).max(100),
  K67_BUILD_SHA: z.string().regex(/^[0-9a-f]{7,64}$/i)
});
export function loadConfig(env = process.env) {
  const result = schema.safeParse(env);
  if (!result.success) {
    const fields = [...new Set(result.error.issues.map(issue => issue.path.join('.')))];
    throw new Error(`Cấu hình K67 thiếu hoặc sai: ${fields.join(', ')}`);
  }
  const p = result.data;
  const db = new URL(p.K67_DATABASE_URL);
  const databaseName = decodeURIComponent(db.pathname.slice(1));
  if (!['postgres:', 'postgresql:'].includes(db.protocol)
      || !/^term_mini_k67(?:_test_[a-z0-9_]+)?$/.test(databaseName)
      || decodeURIComponent(db.username) !== 'k67_app' || db.search || db.hash) {
    throw new Error('K67 phải dùng database riêng term_mini_k67 và role k67_app.');
  }
  const api = new URL(p.K67_PUBLIC_API_BASE_URL);
  if (api.pathname.replace(/\/+$/, '') !== '/term-mini-k67-api') {
    throw new Error('K67 cần đường API riêng /term-mini-k67-api.');
  }
  if (p.K67_AUTH_MODE === 'google' && !p.K67_GOOGLE_CLIENT_ID) throw new Error('Thiếu K67_GOOGLE_CLIENT_ID.');
  if (p.K67_AUTH_MODE === 'legacy' && p.K67_LEGACY_REVIEW_TOKEN.length < 10) throw new Error('Thiếu K67_LEGACY_REVIEW_TOKEN.');
  if (p.K67_TEACHER_SESSION_ABSOLUTE_DAYS < p.K67_TEACHER_SESSION_IDLE_DAYS) throw new Error('Hạn phiên K67 không hợp lệ.');
  for (const pair of [['K67_ERP_SYNC_URL', 'K67_ERP_SYNC_SECRET'], ['K67_NOTIFY_URL', 'K67_NOTIFY_SECRET']]) {
    if (Boolean(p[pair[0]]) !== Boolean(p[pair[1]])) throw new Error(`Cần đủ ${pair.join(' và ')}.`);
  }
  if (p.K67_ENV === 'production') {
    if (databaseName !== 'term_mini_k67') throw new Error('Production K67 không dùng DB fixture.');
    for (const field of ['K67_ERP_SYNC_URL', 'K67_NOTIFY_URL', 'K67_PUBLIC_API_BASE_URL']) {
      if (!p[field].startsWith('https://')) throw new Error(`${field} cần HTTPS ở production.`);
    }
    for (const field of ['K67_MINI_SYNC_SECRET', 'K67_WRITING_SYNC_SECRET']) {
      if (!p[field]) throw new Error(`Thiếu ${field} ở production.`);
    }
  }
  return Object.freeze({
    nodeEnv: p.K67_ENV, port: p.K67_PORT,
    databaseUrl: p.K67_DATABASE_URL, databaseName, dbPoolMax: p.K67_DB_POOL_MAX,
    authMode: p.K67_AUTH_MODE, googleClientId: p.K67_GOOGLE_CLIENT_ID,
    legacyReviewToken: p.K67_LEGACY_REVIEW_TOKEN,
    allowedOrigins: new Set(p.K67_ALLOWED_ORIGINS.split(',').map(value => value.trim()).filter(Boolean)),
    teacherSessionIdleDays: p.K67_TEACHER_SESSION_IDLE_DAYS,
    teacherSessionAbsoluteDays: p.K67_TEACHER_SESSION_ABSOLUTE_DAYS,
    teacherSessionCookieName: 'izone_k67_teacher_session',
    teacherSessionCookiePath: '/term-mini-k67-api',
    teacherSessionCookieSecure: p.K67_ENV === 'production',
    teacherSessionCookiePartitioned: p.K67_ENV === 'production',
    teacherSessionCookieSameSite: p.K67_ENV === 'production' ? 'None' : 'Lax',
    trustProxyHops: p.K67_TRUST_PROXY_HOPS,
    erpSyncUrl: p.K67_ERP_SYNC_URL, erpSyncSecret: p.K67_ERP_SYNC_SECRET,
    erpSyncTimeoutMs: p.K67_ERP_SYNC_TIMEOUT_MS,
    miniTestSyncSecret: p.K67_MINI_SYNC_SECRET,
    writingTestSyncSecret: p.K67_WRITING_SYNC_SECRET,
    termTestNotifyUrl: p.K67_NOTIFY_URL, termTestNotifySecret: p.K67_NOTIFY_SECRET,
    termTestPublicApiBaseUrl: p.K67_PUBLIC_API_BASE_URL.replace(/\/+$/, ''),
    termTestAssetDir: p.K67_ASSET_DIR, termTestSessionSecret: p.K67_SESSION_SECRET,
    appVersion: p.K67_APP_VERSION, buildSha: p.K67_BUILD_SHA
  });
}
