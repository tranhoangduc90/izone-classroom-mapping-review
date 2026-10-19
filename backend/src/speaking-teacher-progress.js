import { SpeakingHomeworkError } from './speaking-homework.js';

const fail = (code, message, status = 403) => { throw new SpeakingHomeworkError(code, message, status); };

// Nhận quyền Google từ nguồn sở hữu và đọc tiến trình Speaking, kể cả chưa có biên nhận.
// Chỉ SELECT: không mở phiên học viên, kiểm hội thoại, nộp bài hoặc phát sinh job.
export function createSpeakingTeacherProgress({ pool, source }) {
  async function authorize(classId, headers) {
    if (!await source.teacher(String(classId), headers)) {
      fail('TEACHER_ACCESS_DENIED', 'Tài khoản Google này chưa được cấp quyền xem lớp.');
    }
  }

  async function entry({assignmentCode,documentId},headers){
    const legacy=await source.legacyProgress('entry',{assignmentCode,documentId},headers);
    if(legacy.entry)return legacy.entry;
    const {rows}=await pool.query(`SELECT p.class_id,p.class_code,p.student_ref,u.id AS unit_id
      FROM speaking_independent.document_binding b
      JOIN speaking_independent.work_unit u ON u.id=b.work_unit_id AND u.revoked_at IS NULL
      JOIN speaking_independent.profile p ON p.id=u.profile_id
      WHERE b.document_id=$1 AND b.assignment_code=$2
      UNION ALL
      SELECT a.class_id,a.class_code,b.student_ref,u.id AS unit_id
      FROM speaking_independent.source_binding b
      JOIN speaking_independent.source_assignment a ON a.course_id=b.course_id AND a.course_work_id=b.course_work_id
      LEFT JOIN speaking_independent.work_unit u ON u.id=b.work_unit_id AND u.revoked_at IS NULL
      WHERE b.document_id=$1 AND b.assignment_code=$2 AND a.state='PUBLISHED'`,[documentId,assignmentCode]);
    if(!rows.length)fail('TEACHER_ENTRY_NOT_FOUND','File Homework chưa được nhận diện cho bài này.',404);
    if(rows.some(row=>!row.class_id||!row.class_code)||new Set(rows.map(row=>String(row.class_id)+':'+row.student_ref)).size!==1)
      fail('TEACHER_ENTRY_UNRESOLVED','File Homework chưa có một lớp và người học xác định. Hãy kiểm tra lại nguồn bài.',409);
    const first=rows[0];await authorize(first.class_id,headers);
    const context=await source.context({assignmentCode,classCode:first.class_code});
    if(String(context.scope.class_id)!==String(first.class_id))fail('TEACHER_ACCESS_DENIED','Lớp của file Homework đã thay đổi.');
    return {code:assignmentCode,classId:String(first.class_id),classCode:first.class_code,studentRef:first.student_ref,documentId,
      unitIds:[...new Set(rows.filter(row=>row.unit_id).map(row=>row.unit_id))]};
  }

  async function classes({ assignmentCode }, headers) {
    const context = await source.context({ assignmentCode });
    const allowed = [];
    // Giới hạn số lượt đọc nguồn đồng thời; không giữ quyền trong bộ nhớ qua yêu cầu khác.
    for (let offset = 0; offset < context.classes.length; offset += 6) {
      const group = await Promise.all(context.classes.slice(offset, offset + 6).map(async row => {
        return await source.teacher(String(row.class_id), headers)
          ? { classId: String(row.class_id), classCode: row.class_code } : null;
      }));
      allowed.push(...group.filter(Boolean));
    }
    if (!allowed.length) fail('TEACHER_ACCESS_DENIED', 'Tài khoản chưa được cấp lớp nào cho bài này.');
    return { assignment: { code: assignmentCode, title: context.template.title }, classes: allowed };
  }

  async function students({ assignmentCode, classCode }, headers) {
    const context = await source.context({ assignmentCode, classCode });
    await authorize(context.scope.class_id, headers);
    const { rows } = await pool.query(`SELECT u.id, u.status, u.submitted_at, u.document_id,
      u.context_key, u.created_at, p.student_ref, p.identity_ref, p.student_name,
      receipt.id AS receipt_id, progress.link_count, progress.accepted_count, progress.saved_at
      FROM speaking_independent.work_unit u
      JOIN speaking_independent.profile p ON p.id=u.profile_id
      LEFT JOIN speaking_independent.receipt receipt ON receipt.work_unit_id=u.id
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS link_count,
          count(*) FILTER (WHERE current_link.status='accepted')::int AS accepted_count,
          max(current_link.created_at) AS saved_at
        FROM (SELECT DISTINCT ON (kind,part) status,created_at
          FROM speaking_independent.link WHERE work_unit_id=u.id
          ORDER BY kind,part,revision DESC) current_link
      ) progress ON true
      WHERE p.class_id=$1 AND u.assignment_code=$2 AND u.revoked_at IS NULL
      ORDER BY u.created_at,u.id`, [context.scope.class_id, assignmentCode]);
    const roster = new Map();
    for (const member of [...(context.selectionStudents || []), ...(context.students || [])]) {
      roster.set(member.student_ref, { studentRef: member.student_ref, name: member.name, active: true, units: [] });
    }
    for (const row of rows) {
      const ref = row.student_ref || row.identity_ref;
      if (!roster.has(ref)) roster.set(ref, { studentRef: ref, name: row.student_name, active: false, units: [] });
      roster.get(ref).units.push({ id: row.id, status: row.status, submittedAt: row.submitted_at,
        documentId: row.document_id, context: row.context_key, receiptId: row.receipt_id,
        savedAt: row.saved_at, sentLinks: Number(row.link_count || 0), acceptedLinks: Number(row.accepted_count || 0) });
    }
    // Kho cũ có quyền riêng: lỗi nguồn phải hiện lỗi, không giả thành học viên chưa làm.
    const legacy=await source.legacyProgress('students',{assignmentCode,classCode},headers);
    for(const member of legacy.students){
      if(!roster.has(member.studentRef))roster.set(member.studentRef,{...member,units:[]});
      roster.get(member.studentRef).units.push(...member.units);
    }
    return { assignment: { code: assignmentCode, title: context.template.title,
      parts: context.template.parts, requiredPracticeCount: context.template.requiredPracticeCount },
    class: { classId: String(context.scope.class_id), classCode: context.scope.class_code },
    students: [...roster.values()].sort((a, b) => a.name.localeCompare(b.name, 'vi')) };
  }

  async function detail({ id }, headers) {
    if(id.startsWith('legacy_'))return source.legacyProgress('detail',{id:id.slice(7)},headers);
    const { rows: [unit] } = await pool.query(`SELECT u.id,u.assignment_code,u.template,u.status,
      u.document_id,u.submitted_at,p.class_id,p.class_code,p.student_ref,p.student_name,
      receipt.id AS receipt_id,
      (SELECT max(created_at) FROM speaking_independent.link WHERE work_unit_id=u.id) AS saved_at
      FROM speaking_independent.work_unit u
      JOIN speaking_independent.profile p ON p.id=u.profile_id
      LEFT JOIN speaking_independent.receipt receipt ON receipt.work_unit_id=u.id
      WHERE u.id=$1 AND u.revoked_at IS NULL`, [id]);
    if (!unit) fail('TEACHER_WORK_NOT_FOUND', 'Không tìm thấy bài hoặc bạn chưa có quyền xem.', 404);
    await authorize(unit.class_id, headers);
    // Kiểm lại bài/lớp hiện hành. Không dùng đường mở bài hoặc token của học viên.
    await source.context({ assignmentCode: unit.assignment_code, classCode: unit.class_code });
    const { rows: links } = await pool.query(`SELECT DISTINCT ON (l.kind,l.part)
      l.kind,l.part,l.slot,l.exercise_title,l.share_url,
      CASE WHEN review.required THEN 'rejected' ELSE l.status END AS status,
      l.question_count,CASE WHEN review.required THEN 'CHECK_REVIEW_REQUIRED' ELSE l.check_code END AS check_code,
      l.checked_at,l.created_at,l.revision
      FROM speaking_independent.link l
      CROSS JOIN LATERAL (SELECT EXISTS(SELECT 1 FROM speaking_independent.job j
        WHERE j.work_unit_id=l.work_unit_id AND j.link_id=l.id AND j.status='review'
          AND j.kind=CASE WHEN l.kind='main' THEN 'check_main' ELSE 'check_practice' END) AS required) review
      WHERE l.work_unit_id=$1 ORDER BY l.kind,l.part,l.revision DESC`, [id]);
    const { rows: jobs } = await pool.query(`SELECT kind,status FROM speaking_independent.job
      WHERE work_unit_id=$1 AND link_id IS NULL ORDER BY created_at,id`, [id]);
    return { id: unit.id, assignment: { code: unit.assignment_code, title: unit.template.title,
      parts: unit.template.parts, requiredPracticeCount: unit.template.requiredPracticeCount },
    student: { studentRef: unit.student_ref, name: unit.student_name, classCode: unit.class_code },
    status: unit.status, savedAt: unit.saved_at, submittedAt: unit.submitted_at, receiptId: unit.receipt_id, documentId: unit.document_id,
    links: links.map(link => ({ kind: link.kind, part: link.part, slot: link.slot, title: link.exercise_title,
      url: link.share_url, status: link.status, questionCount: link.question_count, checkCode: link.check_code,
      checkedAt: link.checked_at, savedAt: link.created_at, revision: link.revision })),
    processing: jobs.map(job => ({ kind: job.kind, status: job.status })) };
  }
  return { classes, students, detail, entry };
}

// Giao diện gọi đường đọc riêng; nguồn vẫn kiểm cookie/Google và quyền lớp ở mỗi lần đọc.
export function mountSpeakingTeacherProgress(router, { teacher, z }) {
  const headers = req => ({ cookie: req.get('cookie') || '', authorization: req.get('authorization') || '', origin: req.get('origin') || '' });
  const code = z.string().regex(/^[a-zA-Z0-9_-]{3,100}$/);
  const routes = [
    ['/teacher/progress/entry', z.object({assignmentCode:code,documentId:z.string().regex(/^[A-Za-z0-9_-]{5,120}$/)}).strict(), 'entry'],
    ['/teacher/progress/classes', z.object({ assignmentCode: code }).strict(), 'classes'],
    ['/teacher/progress/students', z.object({ assignmentCode: code, classCode: z.string().regex(/^[A-Za-z0-9_-]{2,32}$/) }).strict(), 'students'],
    ['/teacher/progress/units/:id', z.object({ id: z.string().regex(/^(legacy_)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i) }).strict(), 'detail']
  ];
  for (const [path, schema, method] of routes) router.get(path, async (req, res, next) => {
    try {
      res.set('Cache-Control', 'private, no-store');
      const input = schema.parse(method === 'detail' ? req.params : req.query);
      res.json({ ok: true, ...(await teacher[method](input, headers(req))) });
    } catch (error) { next(error); }
  });
}
