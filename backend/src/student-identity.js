// Nhận mã người học hoặc UUID đã dùng ở sản phẩm; chỉ tra cứu danh tính hiện hành.
// Không cấp phiên, tạo lượt bài, chạy giờ hoặc coi danh tính đã nhớ là quyền vào bài.
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const maxContactId = '9223372036854775807';

export function normalizeContactIdentity(value) {
  if (!value || value.authority !== 'erp-contact' || typeof value.id !== 'string'
      || !/^[1-9][0-9]{0,18}$/.test(value.id)
      || (value.id.length === 19 && value.id > maxContactId)) return null;
  return { authority: 'erp-contact', id: value.id };
}

export function parseStudentIdentityRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some(key => !['identity', 'studentRef', 'classCode'].includes(key))) return null;
  const byIdentity = Object.hasOwn(body, 'identity');
  const byRef = Object.hasOwn(body, 'studentRef');
  if (byIdentity === byRef) return null;
  const identity = byIdentity ? normalizeContactIdentity(body.identity) : null;
  if (byIdentity && !identity) return null;
  if (byRef && (typeof body.studentRef !== 'string' || !uuid.test(body.studentRef))) return null;
  if (body.classCode !== undefined && (typeof body.classCode !== 'string'
      || !/^[A-Z0-9._-]{2,32}$/.test(body.classCode.trim().toUpperCase()))) return null;
  return { identity, studentRef: byRef ? body.studentRef.toLowerCase() : null,
    classCode: body.classCode?.trim().toUpperCase() || null };
}

// Danh sách aliases là các mã của cùng người theo lớp. Không chọn đại lớp đầu tiên.
// Bản ghi lỗi hoặc hai người cùng khớp phải báo rõ, không lọc lỗi rồi nhận là duy nhất.
export function resolvedStudentIdentity(rows, input) {
  if (!Array.isArray(rows)) throw new Error('IDENTITY_SOURCE_INVALID');
  if (!rows.length) return { status: 'missing', identity: null, aliases: [] };
  const aliases = [], people = new Set(), keys = new Set();
  for (const row of rows) {
    const identity = normalizeContactIdentity({ authority: 'erp-contact', id: row.person_id });
    if (!identity || typeof row.student_ref !== 'string' || !uuid.test(row.student_ref)
        || typeof row.class_id !== 'string' || !/^[1-9][0-9]{0,18}$/.test(row.class_id)
        || typeof row.class_code !== 'string' || !/^[A-Z0-9._-]{2,32}$/.test(row.class_code.trim().toUpperCase())
        || typeof row.student_name !== 'string' || !row.student_name.trim()) throw new Error('IDENTITY_SOURCE_INVALID');
    if (input.identity && identity.id !== input.identity.id) throw new Error('IDENTITY_SOURCE_MISMATCH');
    if (input.studentRef && row.student_ref.toLowerCase() !== input.studentRef) throw new Error('IDENTITY_SOURCE_MISMATCH');
    const classCode = row.class_code.trim().toUpperCase();
    if (input.classCode && input.classCode !== classCode) throw new Error('IDENTITY_SOURCE_MISMATCH');
    people.add(identity.id);
    const key = `${row.class_id}:${row.student_ref.toLowerCase()}`;
    if (!keys.has(key)) {
      keys.add(key);
      aliases.push({ classId: row.class_id, classCode, studentRef: row.student_ref.toLowerCase(),
        studentName: row.student_name });
    }
  }
  if (people.size !== 1) return { status: 'ambiguous', identity: null, aliases: [] };
  return { status: 'unique', identity: { authority: 'erp-contact', id: [...people][0] }, aliases };
}

export function createStudentIdentityHandler({ resolve }) {
  return async (req, res, next) => {
    const input = parseStudentIdentityRequest(req.body);
    if (!input) return res.status(400).json({ ok: false, error: 'INVALID_STUDENT_IDENTITY',
      message: 'Thông tin nhận diện chưa hợp lệ. Hãy chọn đúng lớp và người học.' });
    try {
      const rows = await resolve(input, req);
      res.set('Cache-Control', 'no-store');
      return res.json({ ok: true, ...resolvedStudentIdentity(rows, input) });
    } catch (error) {
      if (['IDENTITY_SOURCE_INVALID', 'IDENTITY_SOURCE_MISMATCH'].includes(error.message)) {
        return res.status(503).json({ ok: false, error: error.message,
          message: 'Chưa kiểm được chính xác người học. Hãy thử lại sau.' });
      }
      return next(error);
    }
  };
}

// Nguồn Mapping sở hữu các UUID theo lớp. Chỉ trả mã/tên/lớp của người được hỏi;
// nguồn còn hoạt động, không trả thông tin tài khoản Google hoặc bất kỳ mã phiên nào.
export const mappingStudentIdentitySql = `SELECT
  m.erp_student_contact_id::text AS person_id, m.public_id::text AS student_ref,
  m.erp_course_class_id::text AS class_id, c.erp_class_name_snapshot AS class_code,
  m.erp_student_name_snapshot AS student_name
FROM mapping.student_mapping_review m
JOIN mapping.classroom_course_mapping c ON c.erp_course_class_id=m.erp_course_class_id
  AND c.status='approved'
WHERE m.status <> 'superseded' AND m.erp_student_contact_id>0 AND m.erp_course_class_id>0
  AND (($1::bigint IS NOT NULL AND m.erp_student_contact_id=$1::bigint)
    OR ($2::uuid IS NOT NULL AND m.public_id=$2::uuid))
  AND ($3::text IS NULL OR upper(trim(c.erp_class_name_snapshot))=$3::text)
  AND EXISTS(SELECT 1 FROM mapping.erp_class_membership_snapshot e
    WHERE e.erp_course_class_id=m.erp_course_class_id
      AND e.erp_student_contact_id=m.erp_student_contact_id AND e.source_state='active'
      AND lower(trim(coalesce(e.registration_status,''))) NOT IN ('dropped','on_hold'))
ORDER BY c.erp_class_name_snapshot,m.public_id`;

// Nhận family từ cấu hình triển khai, không từ request. K56 giữ danh sách thi và
// is_eligible riêng; K67 giữ roster đã chốt và fallback Mapping hiện hành của nó.
// K67 không có bảng term_test_class_access của K56 nên chỉ ghép điều kiện khi thật sự dùng K56.
export function termStudentIdentitySql({ k56 = false } = {}) {
  const access = k56 ? `AND EXISTS(SELECT 1 FROM assessment.term_test_class_access a
    WHERE a.test_slug=$4 AND a.erp_course_class_id=c.erp_course_class_id AND a.enabled)` : '';
  const eligible = k56 ? `AND COALESCE((to_jsonb(r)->>'is_eligible')::boolean,false)` : '';
  const fallback = k56 ? '' : `UNION ALL
    SELECT m.erp_student_contact_id::text,m.public_id::text,m.erp_course_class_id::text,
      c.erp_class_name_snapshot,m.erp_student_name_snapshot
    FROM target_classes c JOIN mapping.student_mapping_review m
      ON m.erp_course_class_id=c.erp_course_class_id
    WHERE m.status<>'superseded' AND m.erp_student_contact_id>0
      AND NOT EXISTS(SELECT 1 FROM assessment.term_test_roster r
        WHERE r.test_slug=$4 AND r.erp_course_class_id=c.erp_course_class_id)`;
  return `WITH definition AS (
    SELECT slug FROM assessment.test_definition WHERE slug=$4 AND is_active
  ), target_classes AS (
    SELECT c.erp_course_class_id,c.erp_class_name_snapshot FROM mapping.classroom_course_mapping c
    CROSS JOIN definition d WHERE c.erp_course_class_id>0
      AND ($3::text IS NULL OR upper(trim(c.erp_class_name_snapshot))=$3::text) ${access}
  ), candidates AS (
    SELECT r.erp_student_contact_id::text AS person_id,r.student_ref::text AS student_ref,
      r.erp_course_class_id::text AS class_id,c.erp_class_name_snapshot AS class_code,
      r.student_name_snapshot AS student_name
    FROM target_classes c JOIN assessment.term_test_roster r ON r.erp_course_class_id=c.erp_course_class_id
    WHERE r.test_slug=$4 AND r.erp_student_contact_id>0 ${eligible}
    ${fallback}
  ) SELECT * FROM candidates WHERE ($1::bigint IS NOT NULL AND person_id::bigint=$1::bigint)
    OR ($2::uuid IS NOT NULL AND student_ref::uuid=$2::uuid)
  ORDER BY class_code,student_ref`;
}

export const studentIdentityParameters = input => [input.identity?.id || null, input.studentRef, input.classCode];

function pendingIdentityReads() {
  const pending = new Map();
  return async (key, read) => {
    let work = pending.get(key);
    if (!work) {
      work = Promise.resolve().then(read);
      if (pending.size < 512) pending.set(key, work);
    }
    try { return await work; }
    finally { if (pending.get(key) === work) pending.delete(key); }
  };
}

export function mountMappingStudentIdentity(app, { pool, middleware = [], readOnce = pendingIdentityReads() } = {}) {
  app.post('/api/student-identity/resolve', ...middleware, createStudentIdentityHandler({
    resolve: async input => {
      const params = studentIdentityParameters(input);
      const result = await readOnce(JSON.stringify(['student-identity-v1', ...params]),
        () => pool.query(mappingStudentIdentitySql, params));
      return result.rows;
    }
  }));
}

// Bộ nối nhỏ cho runtime Term/Mini riêng. Caller truyền đúng pool và middleware
// đang dùng; riêng K67 giữ requireContext để không bỏ kiểm độ mới danh sách lớp.
export function mountTermStudentIdentity(app, { pool, k56 = false, middleware = [], readOnce = pendingIdentityReads() } = {}) {
  const sql = termStudentIdentitySql({ k56 });
  app.post('/api/term-tests/:testSlug/student-identity', ...middleware, (req, res, next) => {
    if (!/^(?:term-test-[1-9][0-9]*(?:-k56)?|mini-test-[a-z0-9-]+)$/.test(req.params.testSlug || ''))
      return res.status(400).json({ ok: false, error: 'INVALID_TEST_SLUG', message: 'Mã bài test chưa hợp lệ.' });
    return createStudentIdentityHandler({ resolve: async input => {
      const params = [...studentIdentityParameters(input), req.params.testSlug];
      const query = () => pool.query(sql, params);
      const result = readOnce ? await readOnce(JSON.stringify(['student-identity-v1', ...params]), query) : await query();
      return result.rows;
    } })(req, res, next);
  });
}
