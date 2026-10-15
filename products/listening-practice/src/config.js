import {z} from 'zod';

// Mỗi biến thuộc Reading; không lấy ngầm cấu hình runtime khác. Thiếu cấu hình thì dừng khởi động.
export function readConfig(env=process.env){
 const schema=z.object({
  LISTENING_DATABASE_URL:z.url().refine(v=>/^postgres(?:ql)?:\/\//.test(v)),
  LISTENING_CONTEXT_URL:z.url(),LISTENING_CONTEXT_KEY:z.string().min(32),
  LISTENING_OWNER_SOURCE_URL:z.url(),LISTENING_OWNER_SOURCE_KEY:z.string().min(32),
  LISTENING_ADMIN_KEY:z.string().min(43),LISTENING_GOOGLE_CLIENT_ID:z.string().min(10),
  LISTENING_PAGE_BASE:z.url().refine(v=>v.endsWith('/')),
  LISTENING_ALLOWED_ORIGINS:z.string().min(1),LISTENING_PORT:z.coerce.number().int().min(1024).max(65535).default(8818),
  LISTENING_DOCS_CLIENT_ID:z.string().optional(),LISTENING_DOCS_REFRESH_TOKEN:z.string().optional(),LISTENING_DOCS_CLIENT_SECRET:z.string().optional(),
  LISTENING_AUDIO_FILE:z.string().min(1),
  LISTENING_REVIEW_FILE:z.string().min(1).optional(),
  GOOGLE_APPLICATION_CREDENTIALS:z.string().optional()
 });
 const c=schema.parse(env);c.origins=c.LISTENING_ALLOWED_ORIGINS.split(',').map(v=>new URL(v.trim()).origin);
 if(!c.origins.includes(new URL(c.LISTENING_PAGE_BASE).origin))throw new Error('Reading page origin missing from allowlist');
 if(!c.GOOGLE_APPLICATION_CREDENTIALS&&!(c.LISTENING_DOCS_CLIENT_ID&&c.LISTENING_DOCS_REFRESH_TOKEN&&c.LISTENING_DOCS_CLIENT_SECRET))throw new Error('Reading Docs credentials missing');
 return c;
}
