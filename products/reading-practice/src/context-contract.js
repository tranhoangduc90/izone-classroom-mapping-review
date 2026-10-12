import crypto from 'node:crypto';
import { z } from 'zod';

// Nhận snapshot chỉ có lớp/roster/quyền; kiểm định danh, phạm vi và thời gian trước khi ghi.
// Không nhận token phiên, bài làm hoặc điểm. Sai hợp đồng trả mã lỗi, không in dữ liệu.
export const CONTEXT_PRODUCT = 'PRODUCT-TERM-MINI-K67';
export const CONTEXT_MAX_BYTES = 1048576;
export const CONTEXT_TTL_MS = 120000;
export const CONTEXT_CLASS_IDS = Object.freeze(['-8062028', '1124', '1131', '1135', '1157', '1166', '1187', '1199', '1226', '1250', '1293']);
const id = z.string().regex(/^-?[1-9][0-9]{0,18}$/).refine(value => {
  const n = BigInt(value);
  return n >= -9223372036854775808n && n <= 9223372036854775807n;
});
const email = z.email().max(320).refine(value => value === value.toLowerCase());
const name = z.string().min(1).max(500);
const rows = shape => z.array(z.object(shape).strict()).max(10000);
const payloadSchema = z.object({
  apiVersion: z.literal(1), productId: z.literal(CONTEXT_PRODUCT),
  classes: rows({ erp_course_class_id: id, erp_class_name_snapshot: name }),
  students: rows({ public_id: z.uuid(), erp_course_class_id: id,
    erp_student_contact_id: id, erp_student_name_snapshot: name,
    status: z.enum(['approved', 'rejected', 'pending_review', 'superseded']) }),
  memberships: rows({ erp_course_class_id: id, erp_student_contact_id: id,
    erp_student_name_snapshot: name, source_state: z.enum(['active', 'missing']) }),
  accounts: rows({ email, google_subject: z.string().min(1).max(255).nullable(),
    display_name: z.string().max(500).nullable(), role: z.enum(['teacher', 'admin']),
    status: z.enum(['active', 'disabled']), can_access_all_classes: z.boolean() }),
  access: rows({ reviewer_email: email, erp_course_class_id: id })
}).strict();
export class ContextError extends Error {
  constructor(code) { super(code); this.code = code; }
}
function unique(values) {
  if (new Set(values).size !== values.length) throw new ContextError('CONTEXT_DUPLICATE');
}
function checkedPayload(input) {
  const parsed = payloadSchema.safeParse(input);
  if (!parsed.success) throw new ContextError('CONTEXT_INVALID_PAYLOAD');
  const p = parsed.data;
  unique(p.classes.map(row => row.erp_course_class_id));
  unique(p.students.map(row => row.public_id));
  unique(p.memberships.map(row => `${row.erp_course_class_id}:${row.erp_student_contact_id}`));
  unique(p.accounts.map(row => row.email));
  unique(p.accounts.filter(row => row.google_subject !== null).map(row => row.google_subject));
  unique(p.access.map(row => `${row.reviewer_email}:${row.erp_course_class_id}`));
  const classes = new Set(p.classes.map(row => row.erp_course_class_id));
  if (p.classes.some(row => !CONTEXT_CLASS_IDS.includes(row.erp_course_class_id))) throw new ContextError('CONTEXT_OUTSIDE_SCOPE');
  const accounts = new Set(p.accounts.map(row => row.email));
  for (const row of [...p.students, ...p.memberships, ...p.access]) {
    if (!classes.has(row.erp_course_class_id)) throw new ContextError('CONTEXT_OUTSIDE_SCOPE');
  }
  if (p.access.some(row => !accounts.has(row.reviewer_email))) throw new ContextError('CONTEXT_OUTSIDE_SCOPE');
  return p;
}
function revision(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}
export function createContextSnapshot(input, now = Date.now()) {
  const payload = checkedPayload(input);
  return { ...payload, capturedAt: new Date(now).toISOString(), sourceRevision: revision(payload) };
}
export function parseContextSnapshot(input, now = Date.now()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ContextError('CONTEXT_INVALID_PAYLOAD');
  const { capturedAt, sourceRevision, ...rest } = input;
  const payload = checkedPayload(rest);
  const captured = Date.parse(capturedAt);
  if (typeof capturedAt !== 'string' || !Number.isFinite(captured)
      || new Date(captured).toISOString() !== capturedAt
      || captured > now + 5000 || now - captured > CONTEXT_TTL_MS) {
    throw new ContextError('CONTEXT_INVALID_TIME');
  }
  if (!/^[0-9a-f]{64}$/.test(sourceRevision) || sourceRevision !== revision(payload)) {
    throw new ContextError('CONTEXT_REVISION_MISMATCH');
  }
  if (Buffer.byteLength(JSON.stringify(input)) > CONTEXT_MAX_BYTES) throw new ContextError('CONTEXT_TOO_LARGE');
  return { ...payload, capturedAt, sourceRevision };
}
