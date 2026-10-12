import {z} from 'zod';

// Mỗi biến thuộc Reading; không lấy ngầm cấu hình runtime khác. Thiếu cấu hình thì dừng khởi động.
export function readConfig(env=process.env){
 const schema=z.object({
  READING_DATABASE_URL:z.url().refine(v=>/^postgres(?:ql)?:\/\//.test(v)),
  READING_CONTEXT_URL:z.url(),READING_CONTEXT_KEY:z.string().min(32),
  READING_OWNER_SOURCE_URL:z.url(),READING_OWNER_SOURCE_KEY:z.string().min(32),
  READING_ADMIN_KEY:z.string().min(43),READING_GOOGLE_CLIENT_ID:z.string().min(10),
  READING_PAGE_BASE:z.url().refine(v=>v.endsWith('/')),
  READING_ALLOWED_ORIGINS:z.string().min(1),READING_PORT:z.coerce.number().int().min(1024).max(65535).default(8808),
  READING_DOCS_CLIENT_ID:z.string().optional(),READING_DOCS_REFRESH_TOKEN:z.string().optional(),READING_DOCS_CLIENT_SECRET:z.string().optional(),
  GOOGLE_APPLICATION_CREDENTIALS:z.string().optional()
 });
 const c=schema.parse(env);c.origins=c.READING_ALLOWED_ORIGINS.split(',').map(v=>new URL(v.trim()).origin);
 if(!c.origins.includes(new URL(c.READING_PAGE_BASE).origin))throw new Error('Reading page origin missing from allowlist');
 if(!c.GOOGLE_APPLICATION_CREDENTIALS&&!(c.READING_DOCS_CLIENT_ID&&c.READING_DOCS_REFRESH_TOKEN&&c.READING_DOCS_CLIENT_SECRET))throw new Error('Reading Docs credentials missing');
 return c;
}
