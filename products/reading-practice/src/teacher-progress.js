import { CODE, fail, hash } from './domain.js';

// Đọc bản học viên đã lưu, độc lập với đường mở bài/đồng hồ/nộp bài.
// Mỗi sản phẩm giữ module và quyền dữ liệu riêng; không gọi AI, Docs hoặc audio.
export function createTeacherProgress({ pool, context }) {
  const schema = 'reading_practice';
  async function authorize(classId, identity) {
    if (!await context.teacher(classId, identity.email, identity.google_subject)) {
      fail('ACCESS_DENIED', 'Tài khoản này chưa có quyền lớp.', 403);
    }
  }
  async function classes(input, identity) {
    const list = await context.classes();
    const permitted = [];
    for (const row of list) if (await context.teacher(row.id, identity.email, identity.google_subject)) permitted.push(row);
    if (!permitted.length) fail('ACCESS_DENIED', 'Tài khoản chưa được cấp lớp nào cho bài này.', 403);
    return { code: input.code || CODE, classes: permitted.map(row => ({ classId: String(row.id), classCode: row.classCode })) };
  }
  async function students({ classId, code = CODE }, identity) {
    await authorize(classId, identity);
    const roster = await context.roster(classId);
    const rows = (await pool.query(`SELECT b.id,b.student_ref,a.id AS assignment_id,a.class_code,c.version,
      w.updated_at AS saved_at,
      w.state #>> '{attempts,-1,id}' AS attempt_id,
      w.state #>> '{attempts,-1,status}' AS attempt_status,
      w.state #>> '{attempts,-1,completedAt}' AS completed_at,
      (SELECT count(*)::int FROM jsonb_each(COALESCE(w.state #> '{attempts,-1,draft,answers}','{}'::jsonb)) answer
        WHERE answer.value NOT IN ('""'::jsonb,'null'::jsonb,'[]'::jsonb)) AS answered
      FROM ${schema}.binding b JOIN ${schema}.assignment a ON a.id=b.assignment_id
      JOIN ${schema}.content c ON c.id=a.content_id LEFT JOIN ${schema}.work w ON w.binding_id=b.id
      WHERE a.class_id=$1 AND c.code=$2 ORDER BY c.version,b.id`, [classId, code])).rows;
    const people = new Map(roster.map(row => [row.studentRef, { studentRef: row.studentRef, name: row.name, active: true, units: [] }]));
    for (const row of rows) {
      // Người không còn trong roster vẫn có lịch sử của đúng lớp, không đổi chủ bài cũ.
      if (!people.has(row.student_ref)) people.set(row.student_ref, { studentRef: row.student_ref,
        name: 'Học viên không còn trong danh sách đang học', active: false, units: [] });
      people.get(row.student_ref).units.push({ id: row.id, assignmentId: row.assignment_id, version: row.version,
        status: row.attempt_status || 'not_started', attemptId: row.attempt_id, savedAt: row.saved_at,
        completedAt: row.completed_at, answered: Number(row.answered || 0) });
    }
    return { code, class: { classId, classCode: rows[0]?.class_code || classId }, students: [...people.values()] };
  }
  async function detail({ id }, identity) {
    const row = (await pool.query(`SELECT b.id,b.student_ref,b.document_id,b.tab_id,
      a.class_id,a.class_code,a.id AS assignment_id,c.code,c.version,c.definition,
      ARRAY(SELECT jsonb_object_keys(c.answer_key)) AS question_ids,w.state,w.updated_at
      FROM ${schema}.binding b JOIN ${schema}.assignment a ON a.id=b.assignment_id
      JOIN ${schema}.content c ON c.id=a.content_id LEFT JOIN ${schema}.work w ON w.binding_id=b.id WHERE b.id=$1`, [id])).rows[0];
    if (!row) fail('RESULT_NOT_FOUND', 'Không tìm thấy bài được giao.', 404);
    await authorize(row.class_id, identity);
    const member = await context.student(row.class_id, row.student_ref);
    const definition = structuredClone(row.definition);
    // Trang giảng viên chỉ nhận câu hỏi; không tạo đường tải âm thanh khi xem nháp.
    delete definition.audio;
    const attempts = (row.state?.attempts || []).map(attempt => ({ id: attempt.id, no: attempt.no,
      status: attempt.status, startedAt: attempt.startedAt, completedAt: attempt.completedAt || null,
      submissionId: attempt.submissionId || null, usedMs: attempt.usedMs, phase: attempt.phase,
      answers: structuredClone(attempt.draft?.answers || {}), notes: attempt.draft?.notes || '',
      flags: structuredClone(attempt.draft?.flags || []), annotations: structuredClone(attempt.draft?.annotations || []),
      ...(attempt.status === 'submitted' ? { finalScore: attempt.finalScore, result: attempt.result } : {}) }));
    return { id: row.id, code: row.code, version: row.version, assignmentId: row.assignment_id,
      student: { studentRef: row.student_ref, name: member?.name || 'Học viên không còn trong danh sách đang học', classCode: row.class_code },
      savedAt: row.updated_at, definition, questionIds: row.question_ids, attempts,
      documentUrl: row.document_id ? `https://docs.google.com/document/d/${row.document_id}/edit?tab=${encodeURIComponent(row.tab_id)}` : null };
  }
  async function entry({ entryToken, documentId, code }, identity) {
    const rows = (await pool.query(`SELECT b.id,b.student_ref,a.class_id,c.code
      FROM ${schema}.binding b JOIN ${schema}.assignment a ON a.id=b.assignment_id
      JOIN ${schema}.content c ON c.id=a.content_id WHERE ${entryToken?'b.entry_hash=$1':"c.code=$2 AND (b.document_id=$1 OR b.owner_proof->'homework'->>'documentId'=$1)"}`, entryToken?[hash(entryToken)]:[documentId,code])).rows;
    if(rows.length!==1)fail('RESULT_NOT_FOUND','Link bài chưa có duy nhất chủ đã đăng ký.',404);
    const row=rows[0];
    if (!row) fail('RESULT_NOT_FOUND', 'Link bài chưa hợp lệ.', 404);
    await authorize(row.class_id, identity);
    return { id: row.id, studentRef: row.student_ref, classId: row.class_id, code: row.code };
  }
  return { classes, students, detail, entry };
}

export function mountTeacherProgress(app, { service, teacherSessions, z, wrap }) {
  const code = z.string().regex(/^[a-zA-Z0-9_-]{3,100}$/);
  const routes = [
    ['get', '/api/teacher/progress/classes', z.object({ code: code.optional() }).strict(), 'classes'],
    ['get', '/api/teacher/progress/students', z.object({ code: code.optional(), classId: z.string().regex(/^-?\d{1,19}$/) }).strict(), 'students'],
    ['get', '/api/teacher/progress/units/:id', z.object({ id: z.uuid() }).strict(), 'detail'],
    ['post', '/api/teacher/progress/entry', z.union([z.object({ entryToken: z.string().regex(/^[\w-]{43}$/) }).strict(), z.object({ documentId:z.string().regex(/^[\w-]{20,150}$/),code }).strict()]), 'entry']
  ];
  for (const [method, path, schema, action] of routes) app[method](path, wrap(async (req, res) => {
    const identity = await teacherSessions.read(req);
    const input = schema.parse(action === 'detail' ? req.params : method === 'get' ? req.query : req.body);
    const result = await service[action](input, identity);
    await teacherSessions.refresh(req, res, identity);
    res.set('Cache-Control', 'private, no-store');res.json(result);
  }));
}
