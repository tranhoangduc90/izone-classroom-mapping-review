import { createHash } from 'node:crypto';
import { withTransaction } from './db.js';
import { SpeakingHomeworkError } from './speaking-homework.js';

// pg trả TIMESTAMPTZ bằng Date: giữ mili giây khi so watermark/retry.
const instant = value => value instanceof Date ? value.getTime() : Date.parse(value);

const activeMember = `m.status = 'approved' AND m.classroom_user_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM mapping.erp_class_membership_snapshot e
    WHERE e.erp_course_class_id = m.erp_course_class_id
      AND e.erp_student_contact_id = m.erp_student_contact_id
      AND e.source_state = 'active'
      AND lower(trim(coalesce(e.registration_status, ''))) NOT IN ('dropped', 'on_hold'))`;

// Đầu vào: mã bài/lớp và UUID chính thức; bộ nhớ trình duyệt chỉ là gợi ý.
// Việc chính: kiểm lớp 67 đã đối soát, giải quyết duy nhất bài và bản Docs.
// Kết quả: roster hoặc phiên có đích bất biến; thiếu/mơ hồ thì báo rõ, không đoán.
export function createSpeakingCatalog({ pool, service }) {
  // Snapshot đăng ký đầy đủ của các lớp 67 đã duyệt. Dòng mất khỏi nguồn được
  // đánh dấu missing/dropped, không xóa lịch sử và không tự duyệt hồ sơ học viên.
  async function syncMemberships({ sourceObservedAt, classIds, memberships }) {
    const epoch = Date.parse(sourceObservedAt);
    if (!Number.isFinite(epoch) || epoch > Date.now() + 60_000 || epoch < Date.now() - 86_400_000) {
      throw new SpeakingHomeworkError('SCOPE_SNAPSHOT_STALE', 'Snapshot đăng ký chưa có thời gian nguồn hợp lệ.', 409);
    }
    return withTransaction(pool, async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('speaking-memberships:ERP-course-5'))");
      const scope = await client.query(`SELECT s.class_id, s.class_code, s.source_observed_at,
        s.membership_observed_at, s.membership_snapshot_hash
        FROM speaking_homework.class_scope s
        JOIN mapping.classroom_course_mapping c ON c.erp_course_class_id = s.class_id
          AND c.status = 'approved'
        WHERE s.class_id = ANY($1::bigint[]) AND s.active AND s.course_key = '67'
        FOR SHARE OF s`, [classIds]);
      if (scope.rows.length !== classIds.length) throw new SpeakingHomeworkError('CLASS_SCOPE_INVALID', 'Snapshot đăng ký chứa lớp chưa duyệt hoặc ngoài khóa 67.', 403);
      const names = new Map(scope.rows.map(row => [String(row.class_id), row.class_code]));
      if (memberships.some(row => !names.has(String(row.classId)))) throw new SpeakingHomeworkError('CLASS_SCOPE_INVALID', 'Đăng ký không thuộc phạm vi snapshot.', 403);
      // Cùng thời điểm chỉ nhận lại đúng nội dung; retry không phục hồi người đã nghỉ.
      const hashes = new Map(classIds.map(id => [String(id), createHash('sha256')
        .update(JSON.stringify(memberships.filter(row => String(row.classId) === String(id))
          .map(row => [String(row.contactId), row.studentName, row.email || null,
            row.registrationStatus, row.registrationUpdatedAt || null])
          .sort((a, b) => a[0].localeCompare(b[0])))).digest('hex')]));
      for (const row of scope.rows) {
        if (row.membership_observed_at && instant(row.membership_observed_at) === epoch
          && row.membership_snapshot_hash !== hashes.get(String(row.class_id))) {
          throw new SpeakingHomeworkError('SCOPE_SNAPSHOT_STALE', 'Snapshot cùng thời điểm có nội dung khác; không thay quyền đăng ký.', 409);
        }
      }
      const latest = await client.query(`SELECT greatest(max(last_seen_at),
        (SELECT max(membership_observed_at) FROM speaking_homework.class_scope
          WHERE class_id = ANY($1::bigint[]))) AS latest
        FROM mapping.erp_class_membership_snapshot WHERE erp_course_class_id = ANY($1::bigint[])`, [classIds]);
      if (latest.rows[0]?.latest && instant(latest.rows[0].latest) > epoch) {
        throw new SpeakingHomeworkError('SCOPE_SNAPSHOT_STALE', 'Không ghi đè đăng ký bằng snapshot cũ.', 409);
      }
      if (scope.rows.every(row => row.membership_observed_at
        && instant(row.membership_observed_at) === epoch)) {
        return { classes:classIds.length, observed:memberships.length, markedMissing:0,
          sourceObservedAt, alreadyCurrent:true };
      }
      for (const row of memberships) {
        const saved = await client.query(`INSERT INTO mapping.erp_class_membership_snapshot
        (erp_course_class_id, erp_student_contact_id, erp_class_name_snapshot,
          erp_student_name_snapshot, erp_student_email_snapshot, registration_status,
          registration_updated_at, source_state, last_seen_at, missing_since)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8,NULL)
        ON CONFLICT (erp_course_class_id, erp_student_contact_id) DO UPDATE SET
          erp_class_name_snapshot=EXCLUDED.erp_class_name_snapshot,
          erp_student_name_snapshot=EXCLUDED.erp_student_name_snapshot,
          erp_student_email_snapshot=EXCLUDED.erp_student_email_snapshot,
          registration_status=EXCLUDED.registration_status,
          registration_updated_at=EXCLUDED.registration_updated_at,
          source_state='active',last_seen_at=EXCLUDED.last_seen_at,missing_since=NULL
        WHERE mapping.erp_class_membership_snapshot.last_seen_at <= EXCLUDED.last_seen_at
        RETURNING erp_student_contact_id`,
      [row.classId,row.contactId,names.get(String(row.classId)),row.studentName,row.email || null,
        row.registrationStatus,row.registrationUpdatedAt || null,sourceObservedAt]);
        if (saved.rows.length !== 1) throw new SpeakingHomeworkError('SCOPE_SNAPSHOT_STALE',
          'ERP vừa có đăng ký mới hơn; không ghi đè bằng snapshot cũ.', 409);
      }
      const removed = await client.query(`UPDATE mapping.erp_class_membership_snapshot e
        SET source_state='missing',registration_status='dropped',missing_since=coalesce(missing_since,now())
        WHERE e.erp_course_class_id = ANY($1::bigint[]) AND e.last_seen_at < $2
        RETURNING erp_course_class_id`, [classIds,sourceObservedAt]);
      // Watermark ghi cả snapshot không có học viên: sự kiện cũ không phục hồi quyền.
      for (const id of classIds) await client.query(`UPDATE speaking_homework.class_scope
        SET membership_observed_at=$2,membership_snapshot_hash=$3,updated_at=now()
        WHERE class_id=$1`, [id,sourceObservedAt,hashes.get(String(id))]);
      return { classes: classIds.length, observed: memberships.length, markedMissing: removed.rows.length, sourceObservedAt };
    });
  }
  async function syncScope({ sourceObservedAt, classes }) {
    const epoch = Date.parse(sourceObservedAt);
    if (!Number.isFinite(epoch) || epoch > Date.now() + 60_000 || epoch < Date.now() - 86_400_000) {
      throw new SpeakingHomeworkError('SCOPE_SNAPSHOT_STALE', 'Snapshot lớp thiếu độ mới hoặc thời gian không hợp lệ.', 409);
    }
    return withTransaction(pool, async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('speaking-scope:ERP-course-5'))");
      const latest = await client.query(`SELECT max(source_observed_at) AS latest
        FROM speaking_homework.class_scope WHERE source_key = 'erp:course:5'`);
      if (latest.rows[0]?.latest && instant(latest.rows[0].latest) > epoch) {
        throw new SpeakingHomeworkError('SCOPE_SNAPSHOT_STALE', 'Không ghi đè danh mục bằng sự kiện cũ hơn.', 409);
      }
      let enabled = 0;
      for (const row of classes) {
        const mapping = await client.query(`SELECT erp_course_class_id FROM mapping.classroom_course_mapping
          WHERE erp_course_class_id = $1 AND upper(erp_class_name_snapshot) = upper($2)
            AND status = 'approved' AND classroom_course_id IS NOT NULL`, [row.classId, row.classCode]);
        const active = row.active && mapping.rows.length === 1;
        await client.query(`INSERT INTO speaking_homework.class_scope
          (class_id, class_code, course_key, active, source_key, source_observed_at)
          VALUES ($1, upper($2), '67', $3, 'erp:course:5', $4)
          ON CONFLICT (class_id) DO UPDATE SET class_code = EXCLUDED.class_code,
            active = EXCLUDED.active, source_key = EXCLUDED.source_key,
            source_observed_at = EXCLUDED.source_observed_at, verified_at = now(), updated_at = now()`,
        [row.classId, row.classCode, active, sourceObservedAt]);
        if (active) enabled++;
      }
      await client.query(`UPDATE speaking_homework.class_scope SET active = false,
        source_observed_at = $2, updated_at = now()
        WHERE source_key = 'erp:course:5' AND NOT (class_id = ANY($1::bigint[]))`,
      [classes.map(row => row.classId), sourceObservedAt]);
      const closed = await client.query(`UPDATE speaking_homework.assignment a SET status = 'closed'
        FROM speaking_homework.class_scope s WHERE s.class_id = a.class_id
          AND s.source_key = 'erp:course:5' AND NOT s.active AND a.status = 'open'
        RETURNING a.id`);
      return { observed: classes.length, enabled, closedAssignments: closed.rows.length, sourceObservedAt };
    });
  }

  async function assignmentScopes() {
    const found = await pool.query(`SELECT a.course_id, a.course_work_id, a.assignment_code,
      a.opened_at, a.delivery_mode, s.class_code
      FROM speaking_homework.assignment a
      JOIN speaking_homework.class_scope s ON s.class_id = a.class_id AND s.active
      JOIN mapping.classroom_course_mapping c ON c.erp_course_class_id = s.class_id
        AND c.status = 'approved' AND c.classroom_course_id = a.course_id
      WHERE a.status = 'open' AND s.course_key = '67' ORDER BY s.class_code, a.assignment_code`);
    return found.rows;
  }
  async function listClasses({ assignmentCode }) {
    const found = await pool.query(`SELECT s.class_code, s.class_id,
      count(a.id)::int AS assignment_count,
      min(a.status) AS assignment_status,
      bool_or(a.status = 'open' AND EXISTS (
        SELECT 1 FROM speaking_homework.assignment_document d
        WHERE d.assignment_id = a.id AND d.student_ref IS NOT NULL
          AND d.classroom_submission_id IS NOT NULL
          AND (a.delivery_mode = 'direct' OR d.cta_verified_at IS NOT NULL))) AS ready
      FROM speaking_homework.class_scope s
      JOIN mapping.classroom_course_mapping c ON c.erp_course_class_id = s.class_id
        AND c.status = 'approved' AND upper(c.erp_class_name_snapshot) = upper(s.class_code)
      JOIN speaking_homework.assignment_template t ON t.assignment_code = $1 AND t.active
      LEFT JOIN speaking_homework.assignment a ON a.class_id = s.class_id
        AND a.assignment_code = t.assignment_code AND a.status IN ('draft', 'open')
      WHERE s.active AND s.course_key = '67'
      GROUP BY s.class_code, s.class_id ORDER BY s.class_code`, [assignmentCode]);
    return found.rows.map(row => ({ classCode: row.class_code, classRef: String(row.class_id),
      assignmentStatus: row.assignment_count > 1 ? 'ambiguous' : row.assignment_status || 'missing',
      ready: row.assignment_count === 1 && Boolean(row.ready) }));
  }

  async function resolveIdentity({ assignmentCode, studentRef }) {
    const found = await pool.query(`SELECT s.class_code, m.public_id
      FROM mapping.student_mapping_review m
      JOIN speaking_homework.class_scope s ON s.class_id = m.erp_course_class_id
        AND s.active AND s.course_key = '67'
      JOIN mapping.classroom_course_mapping c ON c.erp_course_class_id = s.class_id
        AND c.status = 'approved' AND upper(c.erp_class_name_snapshot) = upper(s.class_code)
      JOIN speaking_homework.assignment_template t ON t.assignment_code = $1 AND t.active
      WHERE m.public_id = $2 AND ${activeMember}`, [assignmentCode, studentRef]);
    if (found.rows.length !== 1) return { status: found.rows.length ? 'ambiguous' : 'missing' };
    return { status: 'unique', classCode: found.rows[0].class_code, studentRef };
  }

  async function selectedAssignment(client, classCode, assignmentCode) {
    const found = await client.query(`SELECT a.*, s.class_code
      FROM speaking_homework.class_scope s
      JOIN mapping.classroom_course_mapping c ON c.erp_course_class_id = s.class_id
        AND c.status = 'approved' AND upper(c.erp_class_name_snapshot) = upper(s.class_code)
      JOIN speaking_homework.assignment_template t ON t.assignment_code = $2 AND t.active
      JOIN speaking_homework.assignment a ON a.class_id = s.class_id
        AND a.assignment_code = t.assignment_code AND a.status IN ('open', 'closed', 'draft')
      WHERE upper(s.class_code) = upper($1) AND s.active AND s.course_key = '67'`,
    [classCode, assignmentCode]);
    const current = found.rows.filter(row => row.status !== 'closed');
    const rows = current.length ? current : found.rows;
    if (rows.length !== 1) throw new SpeakingHomeworkError(rows.length ? 'ASSIGNMENT_AMBIGUOUS' : 'ASSIGNMENT_NOT_FOUND',
      rows.length ? 'Có nhiều bài cùng mã; cần kiểm lại đăng ký Classroom.' : 'Lớp chưa có bài Speaking này sẵn sàng.', 409);
    if (rows[0].status === 'draft') throw new SpeakingHomeworkError('HOMEWORK_DRAFT', 'Bài này đang nháp, chưa nhận bài.', 403);
    return rows[0];
  }

  async function roster({ classCode, assignmentCode, documentId }) {
    if (documentId) {
      // CTA lịch sử vẫn mở phần luyện thêm; startSession kiểm biên nhận và đăng ký.
      return service.openAssignment({ documentId, assignmentCode, classCode });
    }
    const a = await selectedAssignment(pool, classCode, assignmentCode);
    const students = await pool.query(`SELECT m.public_id AS student_ref, m.erp_student_name_snapshot AS name
      FROM mapping.student_mapping_review m WHERE m.erp_course_class_id = $1 AND ${activeMember}
      ORDER BY m.erp_student_name_snapshot, m.public_id`, [a.class_id]);
    const parts = await pool.query(`SELECT part_key, display_title, practice_url, min_questions
      FROM speaking_homework.assignment_part WHERE assignment_id = $1 ORDER BY position`, [a.id]);
    return { title: a.title, classCode: a.class_code, assignmentCode: a.assignment_code,
      students: students.rows, parts: parts.rows, requiredPracticeCount: a.required_practice_count,
      assignmentStatus: a.status, doctorEnabled: Boolean(a.doctor_course_key) };
  }

  async function startSelected({ classCode, assignmentCode, studentRef, documentId }) {
    if (documentId) {
      // CTA cùng lớp có thể chọn khác chủ Docs; docID gốc vẫn là đích ghi.
      await service.openAssignment({ documentId, assignmentCode, classCode });
      return { ...(await service.startSession({ documentId, assignmentCode, studentRef })), documentId };
    } else {
      const a = await selectedAssignment(pool, classCode, assignmentCode);
      const docs = await pool.query(`SELECT document_id FROM speaking_homework.assignment_document
        WHERE assignment_id = $1 AND student_ref = $2 AND classroom_submission_id IS NOT NULL
          AND ($3 = 'direct' OR cta_verified_at IS NOT NULL)`, [a.id, studentRef, a.delivery_mode]);
      if (docs.rows.length !== 1) throw new SpeakingHomeworkError('STUDENT_DOCUMENT_REQUIRED',
        'Chưa tìm được duy nhất file Homework sẵn sàng của học viên. Hãy mở từ file Docs hoặc thử lại sau.', 403);
      documentId = docs.rows[0].document_id;
    }
    const session = await service.startSession({ documentId, assignmentCode, studentRef });
    return { ...session, documentId };
  }

  // Đầu vào: sự kiện Classroom có mã bài đã duyệt; chỉ worker được gọi route này.
  // Việc chính: giữ một instance theo courseWork; sao mẫu các phần và mở đúng bài PUBLISHED.
  // Kết quả: ID registry để đồng bộ Docs; DRAFT/DELETED không bị tự phát hoặc mở.
  async function register({ courseId, courseWorkId, assignmentCode, title, classroomState }) {
    return withTransaction(pool, async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`speaking-register:${courseId}:${assignmentCode}`]);
      const scope = await client.query(`SELECT s.class_id, s.class_code, t.*
        FROM speaking_homework.class_scope s
        JOIN mapping.classroom_course_mapping c ON c.erp_course_class_id = s.class_id
          AND c.status = 'approved' AND upper(c.erp_class_name_snapshot) = upper(s.class_code)
        JOIN speaking_homework.assignment_template t ON t.assignment_code = $2 AND t.active
        WHERE c.classroom_course_id = $1 AND s.active AND s.course_key = '67'`, [courseId, assignmentCode]);
      if (scope.rows.length !== 1) throw new SpeakingHomeworkError('CLASS_SCOPE_INVALID', 'Lớp hoặc mẫu bài chưa được đối soát cho khóa 67.', 403);
      const template = scope.rows[0];
      const old = await client.query(`SELECT * FROM speaking_homework.assignment
        WHERE course_id = $1 AND (course_work_id = $2 OR assignment_code = $3) FOR UPDATE`,
      [courseId, courseWorkId, assignmentCode]);
      const exact = old.rows.find(row => row.course_work_id === courseWorkId && row.assignment_code === assignmentCode);
      if (old.rows.some(row => row.id !== exact?.id)) throw new SpeakingHomeworkError('ASSIGNMENT_BINDING_CONFLICT',
        'Mã bài đã gắn với bài Classroom khác; không tự thay lịch sử.', 409);
      if (exact && String(exact.class_id) !== String(template.class_id)) throw new SpeakingHomeworkError('CLASS_SCOPE_INVALID', 'Lớp registry không khớp Classroom.', 409);
      if (classroomState === 'DELETED' && exact) {
        await client.query("UPDATE speaking_homework.assignment SET status='closed' WHERE id=$1", [exact.id]);
        return {registered:true,status:'closed',assignmentId:exact.id,classCode:template.class_code};
      }
      if (classroomState !== 'PUBLISHED') return { registered: Boolean(exact), status: exact?.status || classroomState.toLowerCase(), assignmentId: exact?.id || null };
      if (exact?.status === 'closed') throw new SpeakingHomeworkError('HOMEWORK_CLOSED', 'Bài đã đóng không được sự kiện tự mở lại.', 409);
      // Registry nháp đã có là bài được giữ lại để thử; discovery không tự phát hành.
      if (exact?.status === 'draft') return { registered:true, assignmentId:exact.id,
        classCode:template.class_code, status:'draft' };
      const inserted = await client.query(`INSERT INTO speaking_homework.assignment
        (class_id, course_id, course_work_id, assignment_code, doctor_course_key, title,
          status, opened_at, required_practice_count, delivery_mode)
        VALUES ($1, $2, $3, $4, $5, $6, 'open', now(), $7, 'docs_cta')
        ON CONFLICT (course_id, course_work_id) DO UPDATE SET status = 'open',
          opened_at = coalesce(speaking_homework.assignment.opened_at, now())
        RETURNING id, status`, [template.class_id, courseId, courseWorkId, assignmentCode,
        template.doctor_course_key, title || template.title, template.required_practice_count]);
      const a = inserted.rows[0];
      for (const p of template.parts) await client.query(`INSERT INTO speaking_homework.assignment_part
        (assignment_id, part_key, display_title, practice_url, min_questions, position)
        VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (assignment_id, part_key) DO NOTHING`,
      [a.id, p.part_key, p.display_title, p.practice_url, p.min_questions, p.position]);
      return { registered: true, assignmentId: a.id, classCode: template.class_code, status: a.status };
    });
  }
  return { listClasses, resolveIdentity, roster, startSelected, register, syncScope, syncMemberships, assignmentScopes };
}
