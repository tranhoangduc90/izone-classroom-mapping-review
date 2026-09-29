import { createHash, createHmac } from 'node:crypto';
import { withTransaction } from './db.js';
import { buildTeacherClassAccessPredicate } from './teacher-class-access-sql.js';

export class SpeakingHomeworkError extends Error {
  constructor(code, message, httpStatus = 409) {
    super(message);
    this.name = 'SpeakingHomeworkError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

const hash = value => createHash('sha256').update(value, 'utf8').digest('hex');
const cryptoToken = (secret, value) => createHmac('sha256', secret).update(value, 'utf8').digest('base64url');

// Dữ liệu vào: đường dẫn ChatGPT Share do học viên dán.
// Việc chính: chỉ nhận HTTPS và đúng một ID share, bỏ query/hash để đối chiếu trùng.
// Kết quả: URL chuẩn và share ID; sai định dạng trả lỗi cho học viên ngay.
export function parseSpeakingShareUrl(raw) {
  let url;
  try { url = new URL(String(raw || '').trim()); } catch {
    throw new SpeakingHomeworkError('INVALID_SHARE_URL', 'Hãy dán link ChatGPT Share hợp lệ.', 400);
  }
  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split('/').filter(Boolean);
  if (url.protocol === 'https:' && ['chatgpt.com', 'www.chatgpt.com'].includes(host)
    && segments[0] === 's') {
    throw new SpeakingHomeworkError('SINGLE_RESPONSE_SHARE',
      'Đây chỉ là link chia sẻ một phản hồi. Hãy chia sẻ toàn bộ hội thoại để lấy link chatgpt.com/share/…', 400);
  }
  if (url.protocol !== 'https:' || url.port || url.username || url.password
    || !['chatgpt.com', 'www.chatgpt.com'].includes(host)
    || segments.length !== 2 || segments[0] !== 'share' || !/^[a-z0-9-]{16,120}$/i.test(segments[1])) {
    throw new SpeakingHomeworkError('INVALID_SHARE_URL', 'Cần link chatgpt.com/share/…; link /c/ chỉ bạn xem được.', 400);
  }
  return { url: `https://chatgpt.com/share/${segments[1].toLowerCase()}`, shareId: segments[1].toLowerCase() };
}

function rowCount(result) { return result.rowCount ?? result.rows.length; }

export function createSpeakingHomeworkService({ pool, accessSecret = '' }) {
  async function resolveAssignmentDocument(documentId, assignmentCode, classCode = '') {
    const result = await pool.query(`
      SELECT d.document_id, d.student_ref AS bound_student_ref,
        a.id AS assignment_id, a.class_id, a.title, a.assignment_code,
        a.required_practice_count, a.doctor_course_key,
        c.erp_class_name_snapshot AS class_code
      FROM speaking_homework.assignment_document d
      JOIN speaking_homework.assignment a ON a.id = d.assignment_id
      JOIN mapping.classroom_course_mapping c ON c.erp_course_class_id = a.class_id
      WHERE d.document_id = $1 AND a.assignment_code = $2
        AND a.status = 'open' AND c.status = 'approved'
        AND d.cta_verified_at IS NOT NULL`, [documentId, assignmentCode]);
    if (result.rows.length !== 1) {
      throw new SpeakingHomeworkError('ASSIGNMENT_NOT_FOUND', 'File Homework chưa được đăng ký cho bài này.', 404);
    }
    const row = result.rows[0];
    if (classCode && row.class_code.toUpperCase() !== classCode.toUpperCase()) {
      throw new SpeakingHomeworkError('CLASS_MISMATCH', 'Mã lớp trong link không khớp file Homework.', 400);
    }
    return row;
  }

  async function openAssignment({ documentId, assignmentCode, classCode = '' }) {
    const assignment = await resolveAssignmentDocument(documentId, assignmentCode, classCode);
    const roster = await pool.query(`
      SELECT m.public_id AS student_ref, m.erp_student_name_snapshot AS name
      FROM mapping.student_mapping_review m
      WHERE m.erp_course_class_id = $1 AND m.status = 'approved'
        AND m.classroom_user_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM mapping.erp_class_membership_snapshot e
          WHERE e.erp_course_class_id = m.erp_course_class_id
            AND e.erp_student_contact_id = m.erp_student_contact_id
            AND lower(trim(coalesce(e.registration_status, ''))) NOT IN ('dropped', 'on_hold'))
      ORDER BY m.erp_student_name_snapshot, m.public_id`,
    [assignment.class_id]);
    const parts = await pool.query(`SELECT part_key, display_title, practice_url, min_questions
      FROM speaking_homework.assignment_part WHERE assignment_id = $1 ORDER BY position`,
    [assignment.assignment_id]);
    return { title: assignment.title, classCode: assignment.class_code,
      assignmentCode: assignment.assignment_code, students: roster.rows, parts: parts.rows,
      requiredPracticeCount: assignment.required_practice_count, doctorEnabled: Boolean(assignment.doctor_course_key) };
  }

  // Tên được nhớ ở browser chỉ giúp bỏ bước chọn lại; server vẫn kiểm Doc ID và roster.
  async function startSession({ documentId, assignmentCode, studentRef }) {
    if (accessSecret.length < 32) throw new Error('Chưa cấu hình secret cho phiên Speaking Homework.');
    const assignment = await resolveAssignmentDocument(documentId, assignmentCode);
    if (!assignment.bound_student_ref) {
      throw new SpeakingHomeworkError('STUDENT_DOCUMENT_REQUIRED',
        'Hãy mở bản Homework được Classroom tạo riêng cho bạn.', 403);
    }
    const student = await pool.query(`
      SELECT 1 FROM mapping.student_mapping_review m
      WHERE m.public_id = $1 AND m.erp_course_class_id = $2 AND m.status = 'approved'
        AND m.classroom_user_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM mapping.erp_class_membership_snapshot e
          WHERE e.erp_course_class_id = m.erp_course_class_id
            AND e.erp_student_contact_id = m.erp_student_contact_id
            AND lower(trim(coalesce(e.registration_status, ''))) NOT IN ('dropped', 'on_hold'))`,
    [studentRef, assignment.class_id]);
    if (!student.rows.length) {
      throw new SpeakingHomeworkError('STUDENT_NOT_FOUND', 'Học viên không thuộc lớp của bài này.', 403);
    }
    const accessToken = cryptoToken(accessSecret, `${assignment.assignment_id}:${documentId}:${studentRef}`);
    const inserted = await pool.query(`
      INSERT INTO speaking_homework.access_grant
        (assignment_id, student_ref, document_id, token_hash)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (assignment_id, student_ref, document_id) DO NOTHING RETURNING id`,
    [assignment.assignment_id, studentRef, documentId, hash(accessToken)]);
    if (!inserted.rows.length) {
      const existing = await pool.query(`SELECT id, revoked_at, token_hash
        FROM speaking_homework.access_grant
        WHERE assignment_id = $1 AND student_ref = $2 AND document_id = $3`,
      [assignment.assignment_id, studentRef, documentId]);
      if (existing.rows[0]?.revoked_at || existing.rows[0]?.token_hash !== hash(accessToken)) {
        throw new SpeakingHomeworkError('ACCESS_DENIED', 'Phiên của file này đã bị thu hồi.', 403);
      }
    }
    return { accessToken, studentRef, classCode: assignment.class_code };
  }

  async function resolveGrant(accessToken, studentRef, client = pool) {
    const tokenHash = hash(String(accessToken || ''));
    const result = await client.query(`
      SELECT g.id AS grant_id, g.document_id, a.id AS assignment_id, a.class_id,
             a.course_id, a.course_work_id, a.doctor_course_key, a.required_practice_count, a.title,
             m.erp_student_name_snapshot AS student_name
      FROM speaking_homework.access_grant g
      JOIN speaking_homework.assignment_document d
        ON d.document_id = g.document_id AND d.assignment_id = g.assignment_id
      JOIN speaking_homework.assignment a ON a.id = g.assignment_id
      JOIN mapping.student_mapping_review m
        ON m.public_id = g.student_ref AND m.erp_course_class_id = a.class_id
      JOIN mapping.classroom_course_mapping c ON c.erp_course_class_id = a.class_id
      WHERE g.token_hash = $1 AND g.student_ref = $2 AND g.revoked_at IS NULL
        AND a.status = 'open' AND m.status = 'approved' AND c.status = 'approved'
        AND m.classroom_user_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM mapping.erp_class_membership_snapshot e
          WHERE e.erp_course_class_id = a.class_id
            AND e.erp_student_contact_id = m.erp_student_contact_id
            AND lower(trim(coalesce(e.registration_status, ''))) NOT IN ('dropped', 'on_hold')
        )`, [tokenHash, studentRef]);
    if (rowCount(result) !== 1) {
      throw new SpeakingHomeworkError('ACCESS_DENIED', 'Link hoặc hồ sơ học viên không khớp bài này.', 403);
    }
    return result.rows[0];
  }

  async function ensureSubmission(grantId, client = pool) {
    const result = await client.query(`
      INSERT INTO speaking_homework.submission (access_grant_id) VALUES ($1)
      ON CONFLICT (access_grant_id) DO UPDATE SET access_grant_id = EXCLUDED.access_grant_id
      RETURNING id, status, submitted_at`, [grantId]);
    return result.rows[0];
  }

  async function latestLinks(submissionId, client = pool) {
    const result = await client.query(`
      SELECT DISTINCT ON (part) id, part, revision, share_url, share_id, fingerprint,
        check_status, check_code, question_count, typing_warning, voice_confirmed, checked_at
      FROM speaking_homework.submission_link WHERE submission_id = $1
      ORDER BY part, revision DESC`, [submissionId]);
    return result.rows;
  }

  async function open({ accessToken, studentRef }) {
    const grant = await resolveGrant(accessToken, studentRef);
    const submission = await ensureSubmission(grant.grant_id);
    const links = await latestLinks(submission.id);
    const receipt = await pool.query(`SELECT id, created_at FROM speaking_homework.receipt WHERE submission_id = $1`, [submission.id]);
    const parts = await pool.query(`SELECT part_key, display_title, practice_url, min_questions
      FROM speaking_homework.assignment_part WHERE assignment_id = $1 ORDER BY position`,
    [grant.assignment_id]);
    const practice = await pool.query(`SELECT DISTINCT ON (p.slot)
      p.id, p.slot, p.revision, p.share_url, p.exercise_id, p.status,
      p.check_code, p.question_count, p.typing_warning, p.voice_confirmed,
      a.status AS analysis_status
      FROM speaking_homework.practice_link p
      LEFT JOIN speaking_homework.practice_analysis_job a ON a.practice_link_id = p.id
      WHERE p.access_grant_id = $1 ORDER BY p.slot, p.revision DESC`, [grant.grant_id]);
    return {
      assignment: { id: grant.assignment_id, title: grant.title, classId: grant.class_id,
        courseWorkId: grant.course_work_id, documentId: grant.document_id,
        requiredPracticeCount: grant.required_practice_count,
        doctorEnabled: Boolean(grant.doctor_course_key) },
      student: { ref: studentRef, name: grant.student_name },
      status: submission.status, parts: parts.rows, links, practiceLinks: practice.rows,
      receipt: receipt.rows[0] || null
    };
  }

  async function requestCheck({ accessToken, studentRef, part, rawUrl }) {
    const share = parseSpeakingShareUrl(rawUrl);
    return withTransaction(pool, async client => {
      const grant = await resolveGrant(accessToken, studentRef, client);
      const assigned = await client.query(`SELECT 1 FROM speaking_homework.assignment_part
        WHERE assignment_id = $1 AND part_key = $2`, [grant.assignment_id, part]);
      if (!assigned.rows.length) {
        throw new SpeakingHomeworkError('PART_NOT_ASSIGNED', 'Phần luyện này không thuộc bài Homework.', 400);
      }
      const submission = await ensureSubmission(grant.grant_id, client);
      await client.query('SELECT id FROM speaking_homework.submission WHERE id = $1 FOR UPDATE', [submission.id]);
      if (submission.status === 'submitted') {
        throw new SpeakingHomeworkError('ALREADY_SUBMITTED', 'Bài đã có biên nhận nộp.');
      }
      const previous = (await latestLinks(submission.id, client)).find(link => link.part === part);
      if (previous?.share_id === share.shareId && previous.check_status !== 'rejected') {
        return { linkId: previous.id, status: previous.check_status, revision: previous.revision };
      }
      const duplicate = await client.query(`
        SELECT a.title FROM speaking_homework.conversation_claim c
        JOIN speaking_homework.assignment a ON a.id = c.assignment_id
        WHERE c.course_id = $1 AND c.share_id = $2 LIMIT 1`, [grant.course_id, share.shareId]);
      if (duplicate.rows.length) {
        throw new SpeakingHomeworkError('REUSED_CONVERSATION',
          `Hội thoại này đã nộp cho bài ${duplicate.rows[0].title}. Hãy luyện bằng hội thoại mới.`);
      }
      const others = (await latestLinks(submission.id, client)).filter(link => link.part !== part);
      if (others.some(link => link.share_id === share.shareId)) {
        throw new SpeakingHomeworkError('SAME_CONVERSATION', 'Hai phần cần hai hội thoại riêng.');
      }
      const inserted = await client.query(`
        INSERT INTO speaking_homework.submission_link
          (submission_id, part, revision, share_url, share_id)
        VALUES ($1, $2, $3, $4, $5) RETURNING id, revision`,
      [submission.id, part, (previous?.revision || 0) + 1, share.url, share.shareId]);
      await client.query('INSERT INTO speaking_homework.check_job (link_id) VALUES ($1)', [inserted.rows[0].id]);
      return { linkId: inserted.rows[0].id, status: 'pending', revision: inserted.rows[0].revision };
    });
  }

  // Dữ liệu vào: kết quả đọc Share/AI từ worker đã xác thực, gắn đúng checkJobId.
  // Việc chính: áp ngưỡng câu, so dấu vân tay với bài đã nộp trong khóa, lưu bằng chứng.
  // Kết quả: accepted/rejected bền; retry cùng job không ghi đè kết luận.
  async function completeCheck({ checkJobId, fingerprint, questionCount, qualityPassed,
    typingWarning = null, evidence = {} }) {
    return withTransaction(pool, async client => {
      const found = await client.query(`
        SELECT j.id AS job_id, j.status AS job_status, l.id AS link_id, l.part, l.share_id,
          l.check_status, a.course_id, s.id AS submission_id, p.min_questions
        FROM speaking_homework.check_job j
        JOIN speaking_homework.submission_link l ON l.id = j.link_id
        JOIN speaking_homework.submission s ON s.id = l.submission_id
        JOIN speaking_homework.access_grant g ON g.id = s.access_grant_id
        JOIN speaking_homework.assignment a ON a.id = g.assignment_id
        JOIN speaking_homework.assignment_part p
          ON p.assignment_id = a.id AND p.part_key = l.part
        WHERE j.id = $1 FOR UPDATE OF j`, [checkJobId]);
      if (!found.rows.length) throw new SpeakingHomeworkError('CHECK_NOT_FOUND', 'Không tìm thấy lượt kiểm.', 404);
      const row = found.rows[0];
      if (row.job_status === 'done') return { linkId: row.link_id, status: row.check_status };
      if (row.job_status !== 'processing') {
        throw new SpeakingHomeworkError('CHECK_NOT_ACTIVE', 'Lượt kiểm chưa được nhận xử lý.');
      }
      const minimum = Number(row.min_questions);
      let code = !qualityPassed || questionCount < minimum ? 'INSUFFICIENT_PRACTICE' : null;
      if (!code && row.part === 'clarify_1') {
        const covered = new Set(Array.isArray(evidence?.coveredCategories)
          ? evidence.coveredCategories : []);
        if (!['noun', 'verb', 'adjective'].every(category => covered.has(category))) {
          code = 'MISSING_CLARIFICATION_CATEGORY';
        }
      }
      if (!code) {
        const duplicate = await client.query(`
          SELECT 1 FROM speaking_homework.conversation_claim
          WHERE course_id = $1 AND (share_id = $2 OR fingerprint = $3) LIMIT 1`,
        [row.course_id, row.share_id, fingerprint]);
        if (duplicate.rows.length) code = 'REUSED_CONVERSATION';
      }
      const status = code ? 'rejected' : 'accepted';
      await client.query(`
        UPDATE speaking_homework.submission_link
        SET fingerprint = $2, question_count = $3, check_status = $4, check_code = $5,
            typing_warning = $6::jsonb, evidence = $7::jsonb, checked_at = now()
        WHERE id = $1`,
      [row.link_id, fingerprint, questionCount, status, code,
        JSON.stringify(typingWarning), JSON.stringify(evidence)]);
      await client.query(`UPDATE speaking_homework.check_job SET status = 'done', updated_at = now() WHERE id = $1`,
        [checkJobId]);
      return { linkId: row.link_id, status, code };
    });
  }

  async function claimCheckJob() {
    return withTransaction(pool, async client => {
      const found = await client.query(`
        SELECT j.id AS job_id, l.id AS link_id, l.share_url, l.part,
          a.course_id, a.course_work_id, a.class_id, g.student_ref,
          p.min_questions
        FROM speaking_homework.check_job j
        JOIN speaking_homework.submission_link l ON l.id = j.link_id
        JOIN speaking_homework.submission s ON s.id = l.submission_id
        JOIN speaking_homework.access_grant g ON g.id = s.access_grant_id
        JOIN speaking_homework.assignment a ON a.id = g.assignment_id
        JOIN speaking_homework.assignment_part p
          ON p.assignment_id = a.id AND p.part_key = l.part
        WHERE (j.status = 'pending'
          OR (j.status = 'failed' AND j.updated_at < now() - INTERVAL '30 seconds')
          OR (j.status = 'processing' AND j.updated_at < now() - INTERVAL '5 minutes'))
          AND j.attempts < 5
        ORDER BY j.created_at FOR UPDATE OF j SKIP LOCKED LIMIT 1`);
      if (!found.rows.length) return null;
      const job = found.rows[0];
      await client.query(`UPDATE speaking_homework.check_job
        SET status = 'processing', attempts = attempts + 1, updated_at = now() WHERE id = $1`, [job.job_id]);
      return job;
    });
  }

  async function failCheckJob({ checkJobId, errorCode }) {
    return withTransaction(pool, async client => {
      const found = await client.query(`SELECT j.id, j.link_id, j.attempts
        FROM speaking_homework.check_job j
        WHERE j.id = $1 AND j.status = 'processing' FOR UPDATE`, [checkJobId]);
      if (!found.rows.length) {
        throw new SpeakingHomeworkError('CHECK_NOT_FOUND', 'Lượt kiểm không ở trạng thái xử lý.', 404);
      }
      const exhausted = Number(found.rows[0].attempts) >= 5;
      await client.query(`UPDATE speaking_homework.check_job
        SET status = $2, last_error_code = $3, updated_at = now() WHERE id = $1`,
      [checkJobId, exhausted ? 'done' : 'failed', errorCode]);
      if (exhausted) {
        await client.query(`UPDATE speaking_homework.submission_link
          SET check_status = 'rejected', check_code = 'CHECK_SERVICE_UNAVAILABLE', checked_at = now()
          WHERE id = $1`, [found.rows[0].link_id]);
      }
      return { exhausted };
    });
  }

  // Dữ liệu vào: Share không mở được cho người ngoài sau khi đã đọc thử thật.
  // Việc chính: chốt lỗi vĩnh viễn vào đúng link để học viên sửa và xác nhận lại.
  // Kết quả: job kết thúc, phần bài vẫn chưa đạt; lỗi dịch vụ tạm thời dùng failCheckJob.
  async function rejectCheckJob({ checkJobId, checkCode }) {
    if (!['SHARE_UNAVAILABLE', 'SHARE_CONTENT_INVALID'].includes(checkCode)) {
      throw new SpeakingHomeworkError('INVALID_CHECK_CODE', 'Mã lỗi kiểm link chưa hợp lệ.', 400);
    }
    return withTransaction(pool, async client => {
      const found = await client.query(`SELECT j.id AS job_id, j.status, l.id AS link_id
        FROM speaking_homework.check_job j
        JOIN speaking_homework.submission_link l ON l.id = j.link_id
        WHERE j.id = $1 FOR UPDATE OF j`, [checkJobId]);
      if (!found.rows.length) throw new SpeakingHomeworkError('CHECK_NOT_FOUND', 'Không thấy lượt kiểm.', 404);
      if (found.rows[0].status === 'done') return { status: 'rejected', linkId: found.rows[0].link_id };
      if (found.rows[0].status !== 'processing') {
        throw new SpeakingHomeworkError('CHECK_NOT_ACTIVE', 'Lượt kiểm chưa được nhận xử lý.');
      }
      await client.query(`UPDATE speaking_homework.submission_link
        SET check_status = 'rejected', check_code = $2, checked_at = now()
        WHERE id = $1`, [found.rows[0].link_id, checkCode]);
      await client.query(`UPDATE speaking_homework.check_job
        SET status = 'done', updated_at = now() WHERE id = $1`, [checkJobId]);
      return { status: 'rejected', linkId: found.rows[0].link_id };
    });
  }

  // Worker đọc một việc đã có biên nhận. Mất phản hồi sau side effect phải đọc lại đích trước khi báo done.
  async function claimOutboxJob(kind = '') {
    return withTransaction(pool, async client => {
      const found = await client.query(`
        SELECT o.id AS job_id
        FROM speaking_homework.outbox o
        WHERE ($1::text = '' OR o.kind = $1)
          AND (o.status = 'pending'
          OR (o.status = 'failed' AND o.updated_at < now() - INTERVAL '30 seconds')
          OR (o.status = 'processing' AND o.updated_at < now() - INTERVAL '5 minutes'))
          AND o.attempts < 5
        ORDER BY o.created_at FOR UPDATE SKIP LOCKED LIMIT 1`, [kind]);
      if (!found.rows.length) return null;
      const details = await client.query(`
        SELECT o.id AS job_id, o.kind, o.attempts, r.id AS receipt_id,
          g.document_id, g.student_ref, a.class_id, a.course_id, a.course_work_id,
          (SELECT jsonb_object_agg(l.part, jsonb_build_object(
            'url', l.share_url, 'fingerprint', l.fingerprint
          )) FROM speaking_homework.submission_link l
          WHERE l.submission_id = s.id
            AND l.id IN (SELECT DISTINCT ON (part) id
              FROM speaking_homework.submission_link WHERE submission_id = s.id
              ORDER BY part, revision DESC)) AS links
        FROM speaking_homework.outbox o
        JOIN speaking_homework.receipt r ON r.id = o.receipt_id
        JOIN speaking_homework.submission s ON s.id = r.submission_id
        JOIN speaking_homework.access_grant g ON g.id = s.access_grant_id
        JOIN speaking_homework.assignment a ON a.id = g.assignment_id
        WHERE o.id = $1`, [found.rows[0].job_id]);
      const job = details.rows[0];
      await client.query(`UPDATE speaking_homework.outbox
        SET status = 'processing', attempts = attempts + 1, updated_at = now() WHERE id = $1`, [job.job_id]);
      return job;
    });
  }

  async function completeOutboxJob({ jobId, externalReceipt }) {
    const result = await pool.query(`UPDATE speaking_homework.outbox
      SET status = 'done', external_receipt = $2, updated_at = now()
      WHERE id = $1 AND status = 'processing' RETURNING id, status`, [jobId, externalReceipt]);
    if (result.rows.length) return result.rows[0];
    const existing = await pool.query('SELECT status, external_receipt FROM speaking_homework.outbox WHERE id = $1', [jobId]);
    if (existing.rows[0]?.status === 'done' && existing.rows[0].external_receipt === externalReceipt) {
      return existing.rows[0];
    }
    throw new SpeakingHomeworkError('OUTBOX_NOT_ACTIVE', 'Việc này chưa được nhận hoặc biên nhận không khớp.');
  }

  async function failOutboxJob({ jobId, errorCode }) {
    const result = await pool.query(`UPDATE speaking_homework.outbox
      SET status = 'failed', last_error_code = $2, updated_at = now()
      WHERE id = $1 AND status = 'processing' RETURNING id`, [jobId, errorCode]);
    if (!result.rows.length) throw new SpeakingHomeworkError('OUTBOX_NOT_ACTIVE', 'Việc này chưa được nhận.');
  }

  // Dữ liệu vào: một biên nhận có đủ bốn link đã được AI kiểm nội dung.
  // Việc chính: tổng hợp số câu và cảnh báo cho giảng viên, rồi chốt việc trong cùng transaction.
  // Kết quả: bản đánh giá bền, retry cùng job không tạo bản chấm thứ hai.
  async function completeGradeJob(jobId) {
    return withTransaction(pool, async client => {
      const found = await client.query(`SELECT o.status, r.id AS receipt_id,
          s.id AS submission_id, g.assignment_id
        FROM speaking_homework.outbox o
        JOIN speaking_homework.receipt r ON r.id = o.receipt_id
        JOIN speaking_homework.submission s ON s.id = r.submission_id
        JOIN speaking_homework.access_grant g ON g.id = s.access_grant_id
        WHERE o.id = $1 AND o.kind = 'grade_speaking' FOR UPDATE OF o`, [jobId]);
      const job = found.rows[0];
      if (!job) throw new SpeakingHomeworkError('GRADE_JOB_NOT_FOUND', 'Không thấy việc đánh giá.', 404);
      if (job.status === 'done') return { receiptId: job.receipt_id, status: 'done' };
      if (job.status !== 'processing') {
        throw new SpeakingHomeworkError('GRADE_JOB_NOT_ACTIVE', 'Việc đánh giá chưa được nhận xử lý.');
      }
      const links = await latestLinks(job.submission_id, client);
      const required = await client.query(`SELECT COUNT(*)::integer AS count
        FROM speaking_homework.assignment_part WHERE assignment_id = $1`, [job.assignment_id]);
      if (!links.length || links.length !== required.rows[0].count
        || links.some(link => link.check_status !== 'accepted')) {
        throw new SpeakingHomeworkError('GRADE_INCOMPLETE', 'Chưa đủ hội thoại đã kiểm của bài.');
      }
      const counts = Object.fromEntries(links.map(link => [link.part, Number(link.question_count)]));
      const typing = links.filter(link => link.typing_warning).map(link => link.part);
      const confirmed = links.filter(link => link.voice_confirmed).map(link => link.part);
      await client.query(`INSERT INTO speaking_homework.grade_result
        (receipt_id, part_counts, total_questions, typing_warning_parts,
         voice_confirmed_parts, status)
        VALUES ($1, $2::jsonb, $3, $4::jsonb, $5::jsonb, 'meets_requirements')
        ON CONFLICT (receipt_id) DO NOTHING`,
      [job.receipt_id, JSON.stringify(counts), Object.values(counts).reduce((a, b) => a + b, 0),
        JSON.stringify(typing), JSON.stringify(confirmed)]);
      await client.query(`UPDATE speaking_homework.outbox
        SET status = 'done', external_receipt = $2, updated_at = now()
        WHERE id = $1`, [jobId, `grade:${job.receipt_id}`]);
      return { receiptId: job.receipt_id, status: 'done' };
    });
  }

  // Dữ liệu vào: biên nhận đã nộp; việc chính: lấy danh mục đang bật của đúng khóa.
  // Kết quả: danh mục và dấu kiểm phiên bản để ngăn ghi theo danh mục đã thay đổi.
  async function getDoctorCatalog(receiptId) {
    const result = await pool.query(`SELECT e.id, e.title, e.exercise_url
      FROM speaking_homework.receipt r
      JOIN speaking_homework.submission s ON s.id = r.submission_id
      JOIN speaking_homework.access_grant g ON g.id = s.access_grant_id
      JOIN speaking_homework.assignment a ON a.id = g.assignment_id
      JOIN speaking_homework.doctor_exercise e ON e.course_key = a.doctor_course_key
      WHERE r.id = $1 AND s.status = 'submitted' AND e.active = true
      ORDER BY e.id`, [receiptId]);
    if (!result.rows.length) {
      throw new SpeakingHomeworkError('DOCTOR_CATALOG_EMPTY', 'Chưa có danh mục bài luyện cho biên nhận này.');
    }
    return { exercises: result.rows, digest: hash(JSON.stringify(result.rows)) };
  }

  // Dữ liệu vào: các lỗi đã ghép với bài trong danh mục từ đúng bốn hội thoại.
  // Việc chính: kiểm lại danh mục, ghi bằng chứng và đề xuất trong cùng giao dịch.
  // Kết quả: retry không tăng số lần đề xuất; lỗi rollback và được hàng việc thử lại.
  async function completeDoctorJob({ jobId, catalogDigest, matches }) {
    if (!Array.isArray(matches) || matches.length > 80) {
      throw new SpeakingHomeworkError('DOCTOR_RESULT_INVALID', 'Kết quả phân tích bài luyện không hợp lệ.');
    }
    return withTransaction(pool, async client => {
      const found = await client.query(`SELECT o.status, r.id AS receipt_id, r.created_at,
          s.id AS submission_id, g.student_ref, a.class_id, a.doctor_course_key
        FROM speaking_homework.outbox o
        JOIN speaking_homework.receipt r ON r.id = o.receipt_id
        JOIN speaking_homework.submission s ON s.id = r.submission_id
        JOIN speaking_homework.access_grant g ON g.id = s.access_grant_id
        JOIN speaking_homework.assignment a ON a.id = g.assignment_id
        WHERE o.id = $1 AND o.kind = 'doctor_analyze' FOR UPDATE OF o`, [jobId]);
      const job = found.rows[0];
      if (!job) throw new SpeakingHomeworkError('DOCTOR_JOB_NOT_FOUND', 'Không thấy việc phân tích bài luyện.', 404);
      if (job.status === 'done') return { receiptId: job.receipt_id, status: 'done' };
      if (job.status !== 'processing' || !job.doctor_course_key) {
        throw new SpeakingHomeworkError('DOCTOR_JOB_NOT_ACTIVE', 'Việc phân tích bài luyện chưa sẵn sàng.');
      }
      const links = await latestLinks(job.submission_id, client);
      const acceptedParts = new Set(links.filter(link => link.check_status === 'accepted').map(link => link.part));
      if (!links.length || acceptedParts.size !== links.length) {
        throw new SpeakingHomeworkError('DOCTOR_LINKS_INCOMPLETE', 'Các hội thoại chưa được kiểm đủ.');
      }
      const catalog = await client.query(`SELECT id, title, exercise_url
        FROM speaking_homework.doctor_exercise
        WHERE course_key = $1 AND active = true ORDER BY id`, [job.doctor_course_key]);
      if (!catalog.rows.length || hash(JSON.stringify(catalog.rows)) !== catalogDigest) {
        throw new SpeakingHomeworkError('DOCTOR_CATALOG_CHANGED', 'Danh mục bài luyện đã đổi; cần phân tích lại.');
      }
      const allowed = new Set(catalog.rows.map(row => row.id));
      const seen = new Set();
      for (const match of matches) {
        if (!allowed.has(match?.exerciseId)
          || !acceptedParts.has(match?.part)
          || !Number.isInteger(match?.evidenceMessage) || match.evidenceMessage < 1
          || typeof match?.evidenceQuote !== 'string' || match.evidenceQuote.length < 5
          || match.evidenceQuote.length > 160
          || typeof match?.reason !== 'string' || !match.reason.trim() || match.reason.length > 500) {
          throw new SpeakingHomeworkError('DOCTOR_RESULT_INVALID', 'Bằng chứng bài luyện không hợp lệ.');
        }
        seen.add(match.exerciseId);
      }
      await client.query(`INSERT INTO speaking_homework.doctor_analysis
        (receipt_id, catalog_digest, matches) VALUES ($1, $2, $3::jsonb)`,
      [job.receipt_id, catalogDigest, JSON.stringify(matches)]);
      for (const exerciseId of seen) {
        await client.query(`INSERT INTO speaking_homework.doctor_recommendation
          (class_id, student_ref, exercise_id) VALUES ($1, $2, $3)
          ON CONFLICT (class_id, student_ref, exercise_id) DO NOTHING`,
        [job.class_id, job.student_ref, exerciseId]);
        const rec = await client.query(`SELECT id, recommendation_count, proposed_at, last_practiced_at
          FROM speaking_homework.doctor_recommendation
          WHERE class_id = $1 AND student_ref = $2 AND exercise_id = $3 FOR UPDATE`,
        [job.class_id, job.student_ref, exerciseId]);
        const sourceKey = `doctor:receipt:${job.receipt_id}:exercise:${exerciseId}`;
        const event = await client.query(`INSERT INTO speaking_homework.doctor_event
          (source_key, recommendation_id, kind, occurred_at)
          VALUES ($1, $2, 'recommendation', $3) ON CONFLICT (source_key) DO NOTHING RETURNING id`,
        [sourceKey, rec.rows[0].id, job.created_at]);
        if (!event.rows.length) continue;
        const previous = rec.rows[0];
        const reopen = Number(previous.recommendation_count) === 0 || (
          previous.proposed_at && previous.last_practiced_at
          && new Date(previous.last_practiced_at).getTime()
            - new Date(previous.proposed_at).getTime() > 5 * 86400000
        );
        await client.query(`UPDATE speaking_homework.doctor_recommendation
          SET recommendation_count = recommendation_count + 1,
            waiting = CASE WHEN $2 THEN true ELSE waiting END,
            proposed_at = CASE WHEN $2 THEN $3 ELSE proposed_at END
          WHERE id = $1`, [previous.id, Boolean(reopen), job.created_at]);
      }
      await client.query(`UPDATE speaking_homework.outbox
        SET status = 'done', external_receipt = $2, updated_at = now()
        WHERE id = $1`, [jobId, `doctor:${job.receipt_id}`]);
      return { receiptId: job.receipt_id, status: 'done', exerciseCount: seen.size };
    });
  }

  async function finish({ accessToken, studentRef, voiceConfirmedParts = [] }) {
    return withTransaction(pool, async client => {
      const grant = await resolveGrant(accessToken, studentRef, client);
      const submission = await ensureSubmission(grant.grant_id, client);
      await client.query('SELECT id FROM speaking_homework.submission WHERE id = $1 FOR UPDATE', [submission.id]);
      if (submission.status === 'submitted') {
        const receipt = await client.query('SELECT id, created_at FROM speaking_homework.receipt WHERE submission_id = $1', [submission.id]);
        return receipt.rows[0];
      }
      const links = await latestLinks(submission.id, client);
      const required = await client.query(`SELECT part_key FROM speaking_homework.assignment_part
        WHERE assignment_id = $1 ORDER BY position`, [grant.assignment_id]);
      if (!required.rows.length || links.length !== required.rows.length
        || required.rows.some(part => !links.some(link => link.part === part.part_key))
        || links.some(link => link.check_status !== 'accepted')) {
        throw new SpeakingHomeworkError('ALL_LINKS_REQUIRED', 'Cần xác nhận đạt đủ các link của bài này.');
      }
      if (Number(grant.required_practice_count) > 0) {
        const practice = await client.query(`SELECT DISTINCT ON (slot)
          slot, status, exercise_id, share_id, fingerprint
          FROM speaking_homework.practice_link WHERE access_grant_id = $1
          ORDER BY slot, revision DESC`, [grant.grant_id]);
        const requiredPractice = practice.rows.filter(row =>
          row.slot >= 1 && row.slot <= Number(grant.required_practice_count));
        if (requiredPractice.length !== Number(grant.required_practice_count)
          || requiredPractice.some(row => row.status !== 'accepted')
          || new Set(requiredPractice.map(row => row.exercise_id)).size !== requiredPractice.length
          || new Set(requiredPractice.map(row => row.share_id)).size !== requiredPractice.length) {
          throw new SpeakingHomeworkError('PRACTICE_LINKS_REQUIRED',
            'Cần xác nhận đạt hai bài bổ trợ khác nhau trước khi nộp Homework.');
        }
      }
      if (new Set(links.map(link => link.share_id)).size !== links.length
        || new Set(links.map(link => link.fingerprint)).size !== links.length) {
        throw new SpeakingHomeworkError('SAME_CONVERSATION', 'Mỗi phần cần một hội thoại riêng.');
      }
      for (const link of links) {
        if (link.typing_warning && !voiceConfirmedParts.includes(link.part)) {
          throw new SpeakingHomeworkError('VOICE_CONFIRMATION_REQUIRED',
            'Hãy xem cảnh báo và xác nhận bạn đã luyện bằng giọng nói.');
        }
      }
      for (const link of links) {
        const claim = await client.query(`
          INSERT INTO speaking_homework.conversation_claim
            (course_id, share_id, fingerprint, source_kind, source_id, assignment_id)
          VALUES ($1, $2, $3, 'homework', $4, $5)
          ON CONFLICT DO NOTHING RETURNING id`,
        [grant.course_id, link.share_id, link.fingerprint, link.id, grant.assignment_id]);
        if (!claim.rows.length) {
          throw new SpeakingHomeworkError('REUSED_CONVERSATION',
            'Hội thoại đã được nộp cho một bài khác trong khóa. Hãy luyện bằng hội thoại mới.');
        }
        if (link.typing_warning) {
          await client.query('UPDATE speaking_homework.submission_link SET voice_confirmed = true WHERE id = $1', [link.id]);
        }
      }
      await client.query(`UPDATE speaking_homework.submission
        SET status = 'submitted', submitted_at = now() WHERE id = $1`, [submission.id]);
      const receipt = await client.query(`
        INSERT INTO speaking_homework.receipt (submission_id) VALUES ($1)
        RETURNING id, created_at`, [submission.id]);
      const kinds = grant.doctor_course_key
        ? ['write_doc', 'grade_speaking', 'doctor_analyze']
        : ['write_doc', 'grade_speaking'];
      for (const kind of kinds) {
        await client.query('INSERT INTO speaking_homework.outbox (receipt_id, kind) VALUES ($1, $2)',
          [receipt.rows[0].id, kind]);
      }
      // Tín hiệu nằm trong cùng transaction; PostgreSQL chỉ phát sau commit.
      // Mất tín hiệu không làm mất việc vì hàng vẫn được lưu và quét bù.
      if (kinds.includes('write_doc')) {
        await client.query("SELECT pg_notify('speaking_homework_write_doc_ready', '')");
      }
      return receipt.rows[0];
    });
  }

  // Dữ liệu vào: khóa nguồn duy nhất từ n8n, học viên và bài trong danh mục.
  // Việc chính: khóa một hàng, bỏ retry trùng, cập nhật đúng luật Lark hiện hành.
  // Kết quả: số lần đề xuất/luyện và Chờ luyện nhất quán; lỗi thì rollback cả event.
  async function recordDoctorEvent({ sourceKey, kind, classId, studentRef, exerciseId, occurredAt }) {
    return withTransaction(pool, async client => {
      const existing = await client.query('SELECT id FROM speaking_homework.doctor_event WHERE source_key = $1', [sourceKey]);
      if (existing.rows.length) return { duplicate: true };
      if (kind === 'recommendation') {
        await client.query(`INSERT INTO speaking_homework.doctor_recommendation
          (class_id, student_ref, exercise_id) VALUES ($1, $2, $3)
          ON CONFLICT (class_id, student_ref, exercise_id) DO NOTHING`,
        [classId, studentRef, exerciseId]);
      }
      const found = await client.query(`SELECT id, recommendation_count, proposed_at, last_practiced_at
        FROM speaking_homework.doctor_recommendation
        WHERE class_id = $1 AND student_ref = $2 AND exercise_id = $3 FOR UPDATE`,
      [classId, studentRef, exerciseId]);
      if (!found.rows.length) throw new SpeakingHomeworkError('RECOMMENDATION_NOT_FOUND', 'Bài này chưa được đề xuất.');
      const rec = found.rows[0];
      const event = await client.query(`INSERT INTO speaking_homework.doctor_event
        (source_key, recommendation_id, kind, occurred_at) VALUES ($1, $2, $3, $4)
        ON CONFLICT (source_key) DO NOTHING RETURNING id`,
      [sourceKey, rec.id, kind, occurredAt]);
      if (!event.rows.length) return { duplicate: true };
      if (kind === 'practice') {
        await client.query(`UPDATE speaking_homework.doctor_recommendation
          SET practice_count = practice_count + 1, last_practiced_at = $2, waiting = false WHERE id = $1`,
        [rec.id, occurredAt]);
      } else {
        // Lark chỉ mở lại nếu lần luyện trước cách Timestamp đề xuất hơn 5 ngày.
        const reopen = Number(rec.recommendation_count) === 0 || (
          rec.proposed_at && rec.last_practiced_at
          && new Date(rec.last_practiced_at).getTime() - new Date(rec.proposed_at).getTime() > 5 * 86400000
        );
        await client.query(`UPDATE speaking_homework.doctor_recommendation
          SET recommendation_count = recommendation_count + 1,
              waiting = CASE WHEN $2 THEN true ELSE waiting END,
              proposed_at = CASE WHEN $2 THEN $3 ELSE proposed_at END
          WHERE id = $1`, [rec.id, Boolean(reopen), occurredAt]);
      }
      return { duplicate: false };
    });
  }

  async function listDoctor({ accessToken, studentRef }) {
    const grant = await resolveGrant(accessToken, studentRef);
    const result = await pool.query(`
      SELECT r.exercise_id, e.title, e.exercise_url, r.recommendation_count,
        r.practice_count, r.waiting, r.proposed_at, r.last_practiced_at
      FROM speaking_homework.doctor_recommendation r
      JOIN speaking_homework.doctor_exercise e ON e.id = r.exercise_id
      WHERE r.class_id = $1 AND r.student_ref = $2 AND e.active = true
        AND e.course_key = $3
      ORDER BY r.waiting DESC, r.recommendation_count DESC, e.title, e.id`,
    [grant.class_id, studentRef, grant.doctor_course_key]);
    const needed = result.rows.filter(row => row.waiting);
    return { needed: needed.slice(0, 5), neededCount: needed.length,
      allNeeded: needed, practiced: result.rows.filter(row => !row.waiting) };
  }

  async function requestPracticeCheck({ accessToken, studentRef, slot, exerciseId, rawUrl }) {
    const share = parseSpeakingShareUrl(rawUrl);
    return withTransaction(pool, async client => {
      const grant = await resolveGrant(accessToken, studentRef, client);
      await client.query('SELECT id FROM speaking_homework.access_grant WHERE id = $1 FOR UPDATE', [grant.grant_id]);
      if (!grant.doctor_course_key) {
        throw new SpeakingHomeworkError('DOCTOR_NOT_READY', 'Bài luyện bổ trợ chưa được mở cho bài này.');
      }
      const exercise = await client.query(`SELECT 1 FROM speaking_homework.doctor_exercise e
        JOIN speaking_homework.doctor_recommendation r ON r.exercise_id = e.id
        WHERE e.id = $1 AND e.course_key = $2 AND e.active = true
          AND r.class_id = $3 AND r.student_ref = $4`,
      [exerciseId, grant.doctor_course_key, grant.class_id, studentRef]);
      if (!exercise.rows.length) {
        throw new SpeakingHomeworkError('EXERCISE_NOT_ASSIGNED', 'Bài luyện này chưa có trong danh sách của bạn.');
      }
      const duplicate = await client.query(`SELECT a.title FROM speaking_homework.conversation_claim c
        JOIN speaking_homework.assignment a ON a.id = c.assignment_id
        WHERE c.course_id = $1 AND c.share_id = $2 LIMIT 1`, [grant.course_id, share.shareId]);
      if (duplicate.rows.length) {
        throw new SpeakingHomeworkError('REUSED_CONVERSATION',
          `Hội thoại đã được nộp cho bài ${duplicate.rows[0].title}. Hãy luyện bằng hội thoại mới.`);
      }
      const latest = await client.query(`SELECT DISTINCT ON (slot)
        id, slot, revision, share_id, exercise_id, status
        FROM speaking_homework.practice_link WHERE access_grant_id = $1
        ORDER BY slot, revision DESC`, [grant.grant_id]);
      const submitted = await client.query(`SELECT status FROM speaking_homework.submission
        WHERE access_grant_id = $1`, [grant.grant_id]);
      if (slot === null) {
        if (submitted.rows[0]?.status !== 'submitted') {
          throw new SpeakingHomeworkError('EXTRA_AFTER_HOMEWORK',
            'Hãy hoàn tất hai bài bổ trợ bắt buộc trước khi nộp bài luyện thêm.');
        }
        const prior = latest.rows.find(row => row.share_id === share.shareId);
        if (prior) return { linkId: prior.id, status: prior.status, revision: prior.revision, slot: prior.slot };
        slot = Math.max(2, ...latest.rows.map(row => Number(row.slot))) + 1;
      } else if (submitted.rows[0]?.status === 'submitted') {
        throw new SpeakingHomeworkError('HOMEWORK_ALREADY_SUBMITTED',
          'Homework đã nộp. Hãy dùng ô Luyện thêm để ghi lượt mới.');
      }
      if (latest.rows.some(row => row.slot !== slot && row.share_id === share.shareId)) {
        throw new SpeakingHomeworkError('SAME_CONVERSATION', 'Mỗi bài luyện cần một hội thoại riêng.');
      }
      if (slot <= Number(grant.required_practice_count)
        && latest.rows.some(row => row.slot !== slot && row.slot <= Number(grant.required_practice_count)
          && row.exercise_id === exerciseId && row.status === 'accepted')) {
        throw new SpeakingHomeworkError('SAME_EXERCISE',
          'Hai bài bổ trợ bắt buộc cần chọn hai bài tập khác nhau.');
      }
      const previous = latest.rows.find(row => row.slot === slot);
      if (previous?.share_id === share.shareId && previous.status !== 'rejected') {
        return { linkId: previous.id, status: previous.status, revision: previous.revision };
      }
      const inserted = await client.query(`INSERT INTO speaking_homework.practice_link
        (access_grant_id, slot, revision, share_url, share_id, exercise_id)
        VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, revision`,
      [grant.grant_id, slot, (previous?.revision || 0) + 1, share.url, share.shareId, exerciseId]);
      await client.query('INSERT INTO speaking_homework.practice_check_job (practice_link_id) VALUES ($1)',
        [inserted.rows[0].id]);
      return { linkId: inserted.rows[0].id, status: 'pending', revision: inserted.rows[0].revision, slot };
    });
  }

  async function claimPracticeCheckJob() {
    return withTransaction(pool, async client => {
      const found = await client.query(`SELECT j.id AS job_id, p.share_url, p.exercise_id, p.slot,
          e.title AS exercise_title
        FROM speaking_homework.practice_check_job j
        JOIN speaking_homework.practice_link p ON p.id = j.practice_link_id
        JOIN speaking_homework.doctor_exercise e ON e.id = p.exercise_id
        WHERE (j.status IN ('pending', 'failed')
          OR (j.status = 'processing' AND j.updated_at < now() - INTERVAL '5 minutes'))
          AND j.attempts < 5
        ORDER BY j.created_at FOR UPDATE OF j SKIP LOCKED LIMIT 1`);
      if (!found.rows.length) return null;
      await client.query(`UPDATE speaking_homework.practice_check_job
        SET status = 'processing', attempts = attempts + 1, updated_at = now() WHERE id = $1`,
      [found.rows[0].job_id]);
      return found.rows[0];
    });
  }

  async function completePracticeCheck({ checkJobId, fingerprint, questionCount,
    qualityPassed, matchedExerciseId, typingWarning = null }) {
    const outcome = await withTransaction(pool, async client => {
      const found = await client.query(`SELECT j.status AS job_status, p.id AS link_id,
        p.status, p.share_id, p.exercise_id, p.fingerprint, p.checked_at,
        g.student_ref, a.class_id, a.course_id, a.id AS assignment_id
        FROM speaking_homework.practice_check_job j
        JOIN speaking_homework.practice_link p ON p.id = j.practice_link_id
        JOIN speaking_homework.access_grant g ON g.id = p.access_grant_id
        JOIN speaking_homework.assignment a ON a.id = g.assignment_id
        WHERE j.id = $1 FOR UPDATE OF j`, [checkJobId]);
      if (!found.rows.length) throw new SpeakingHomeworkError('CHECK_NOT_FOUND', 'Không tìm thấy lượt kiểm.', 404);
      const row = found.rows[0];
      if (row.job_status === 'done') return { ...row, alreadyDone: true };
      if (row.job_status !== 'processing') {
        throw new SpeakingHomeworkError('CHECK_NOT_ACTIVE', 'Lượt kiểm chưa được nhận xử lý.');
      }
      let code = !qualityPassed || questionCount < 1 ? 'INSUFFICIENT_PRACTICE' : null;
      if (!code && matchedExerciseId !== row.exercise_id) code = 'EXERCISE_MISMATCH';
      if (!code) {
        const existing = await client.query(`SELECT 1 FROM speaking_homework.conversation_claim
          WHERE course_id = $1 AND (share_id = $2 OR fingerprint = $3) LIMIT 1`,
        [row.course_id, row.share_id, fingerprint]);
        if (existing.rows.length) code = 'REUSED_CONVERSATION';
      }
      let status = code ? 'rejected' : (typingWarning ? 'needs_voice_confirmation' : 'accepted');
      if (status === 'accepted') {
        const claim = await client.query(`INSERT INTO speaking_homework.conversation_claim
          (course_id, share_id, fingerprint, source_kind, source_id, assignment_id)
          VALUES ($1, $2, $3, 'practice', $4, $5) ON CONFLICT DO NOTHING RETURNING id`,
        [row.course_id, row.share_id, fingerprint, row.link_id, row.assignment_id]);
        if (!claim.rows.length) { status = 'rejected'; code = 'REUSED_CONVERSATION'; }
      }
      await client.query(`UPDATE speaking_homework.practice_link
        SET fingerprint = $2, question_count = $3, status = $4, check_code = $5,
          typing_warning = $6::jsonb, checked_at = now() WHERE id = $1`,
      [row.link_id, fingerprint, questionCount, status, code, JSON.stringify(typingWarning)]);
      await client.query(`UPDATE speaking_homework.practice_check_job
        SET status = 'done', updated_at = now() WHERE id = $1`, [checkJobId]);
      if (status === 'accepted') {
        await client.query(`INSERT INTO speaking_homework.practice_analysis_job
          (practice_link_id) VALUES ($1) ON CONFLICT DO NOTHING`, [row.link_id]);
      }
      return { ...row, status, check_code: code, alreadyDone: false };
    });
    if (outcome.status === 'accepted') {
      await recordDoctorEvent({ sourceKey: `practice:${outcome.link_id}`, kind: 'practice',
        classId: String(outcome.class_id), studentRef: outcome.student_ref,
        exerciseId: outcome.exercise_id, occurredAt: new Date().toISOString() });
    }
    return { linkId: outcome.link_id, status: outcome.status, code: outcome.check_code };
  }

  async function confirmPracticeVoice({ accessToken, studentRef, linkId }) {
    const outcome = await withTransaction(pool, async client => {
      const grant = await resolveGrant(accessToken, studentRef, client);
      const found = await client.query(`SELECT p.* FROM speaking_homework.practice_link p
        WHERE p.id = $1 AND p.access_grant_id = $2 FOR UPDATE`, [linkId, grant.grant_id]);
      if (!found.rows.length) throw new SpeakingHomeworkError('PRACTICE_NOT_FOUND', 'Không thấy bài luyện này.', 404);
      const row = found.rows[0];
      if (row.status === 'accepted') return { row, grant };
      if (row.status !== 'needs_voice_confirmation') {
        throw new SpeakingHomeworkError('VOICE_CONFIRMATION_NOT_READY', 'Chưa có cảnh báo cần xác nhận.');
      }
      const latest = await client.query(`SELECT id FROM speaking_homework.practice_link
        WHERE access_grant_id = $1 AND slot = $2 ORDER BY revision DESC LIMIT 1`,
      [grant.grant_id, row.slot]);
      if (latest.rows[0]?.id !== row.id) {
        throw new SpeakingHomeworkError('PRACTICE_SUPERSEDED', 'Link này đã được thay bằng link mới hơn.');
      }
      const claim = await client.query(`INSERT INTO speaking_homework.conversation_claim
        (course_id, share_id, fingerprint, source_kind, source_id, assignment_id)
        VALUES ($1, $2, $3, 'practice', $4, $5) ON CONFLICT DO NOTHING RETURNING id`,
      [grant.course_id, row.share_id, row.fingerprint, row.id, grant.assignment_id]);
      if (!claim.rows.length) throw new SpeakingHomeworkError('REUSED_CONVERSATION',
        'Hội thoại đã được nộp cho bài khác. Hãy luyện bằng hội thoại mới.');
      await client.query(`UPDATE speaking_homework.practice_link
        SET status = 'accepted', voice_confirmed = true WHERE id = $1`, [row.id]);
      await client.query(`INSERT INTO speaking_homework.practice_analysis_job
        (practice_link_id) VALUES ($1) ON CONFLICT DO NOTHING`, [row.id]);
      return { row, grant };
    });
    await recordDoctorEvent({ sourceKey: `practice:${outcome.row.id}`, kind: 'practice',
      classId: String(outcome.grant.class_id), studentRef,
      exerciseId: outcome.row.exercise_id, occurredAt: new Date().toISOString() });
    return { linkId, status: 'accepted' };
  }

  // Dữ liệu vào: job kiểm bài bổ trợ đã gặp lỗi mạng/AI.
  // Việc chính: giữ job để thử lại sau; link học viên vẫn còn trong database.
  // Kết quả: trạng thái failed có mã lỗi, không tạo biên nhận sai.
  async function rejectPracticeCheckJob({ checkJobId, checkCode = 'SHARE_UNAVAILABLE' }) {
    return withTransaction(pool, async client => {
      const found = await client.query(`SELECT j.status, p.id AS link_id
        FROM speaking_homework.practice_check_job j
        JOIN speaking_homework.practice_link p ON p.id = j.practice_link_id
        WHERE j.id = $1 FOR UPDATE OF j`, [checkJobId]);
      if (!found.rows.length) throw new SpeakingHomeworkError('CHECK_NOT_FOUND', 'Không thấy lượt kiểm.', 404);
      if (found.rows[0].status === 'done') return { linkId: found.rows[0].link_id, status: 'rejected' };
      await client.query(`UPDATE speaking_homework.practice_link
        SET status = 'rejected', check_code = $2, checked_at = now()
        WHERE id = $1`, [found.rows[0].link_id, checkCode]);
      await client.query(`UPDATE speaking_homework.practice_check_job
        SET status = 'done', updated_at = now() WHERE id = $1`, [checkJobId]);
      return { linkId: found.rows[0].link_id, status: 'rejected' };
    });
  }

  async function failPracticeCheckJob({ checkJobId, errorCode }) {
    await pool.query(`UPDATE speaking_homework.practice_check_job
      SET status = 'failed', last_error_code = $2, updated_at = now()
      WHERE id = $1 AND status = 'processing'`, [checkJobId, errorCode]);
  }

  async function claimPracticeAnalysisJob() {
    return withTransaction(pool, async client => {
      const found = await client.query(`SELECT j.id AS job_id, p.id AS link_id,
        p.share_url, p.fingerprint, p.exercise_id, a.doctor_course_key,
        a.class_id, g.student_ref
        FROM speaking_homework.practice_analysis_job j
        JOIN speaking_homework.practice_link p ON p.id = j.practice_link_id
        JOIN speaking_homework.access_grant g ON g.id = p.access_grant_id
        JOIN speaking_homework.assignment a ON a.id = g.assignment_id
        WHERE p.status = 'accepted' AND (
          j.status = 'pending'
          OR (j.status = 'failed' AND j.updated_at < now() - INTERVAL '30 seconds')
          OR (j.status = 'processing' AND j.updated_at < now() - INTERVAL '5 minutes'))
          AND j.attempts < 5
        ORDER BY j.created_at FOR UPDATE OF j SKIP LOCKED LIMIT 1`);
      if (!found.rows.length) return null;
      await client.query(`UPDATE speaking_homework.practice_analysis_job
        SET status = 'processing', attempts = attempts + 1, updated_at = now()
        WHERE id = $1`, [found.rows[0].job_id]);
      return found.rows[0];
    });
  }

  async function getPracticeDoctorCatalog(linkId) {
    const found = await pool.query(`SELECT e.id, e.title, e.exercise_url
      FROM speaking_homework.practice_link p
      JOIN speaking_homework.access_grant g ON g.id = p.access_grant_id
      JOIN speaking_homework.assignment a ON a.id = g.assignment_id
      JOIN speaking_homework.doctor_exercise e
        ON e.course_key = a.doctor_course_key AND e.active = true
      WHERE p.id = $1 AND p.status = 'accepted' ORDER BY e.id`, [linkId]);
    if (!found.rows.length) throw new SpeakingHomeworkError('DOCTOR_CATALOG_EMPTY',
      'Chưa có danh mục bài luyện cho hội thoại này.');
    return { exercises: found.rows, digest: hash(JSON.stringify(found.rows)) };
  }

  // Dữ liệu vào: lỗi có dẫn chứng của một bài bổ trợ đã được nhận.
  // Việc chính: kiểm dấu danh mục, ghi phân tích và cộng đề xuất đúng học viên một lần.
  // Kết quả: danh sách ưu tiên đổi ngay khi job hoàn tất; retry không cộng trùng.
  async function completePracticeAnalysisJob({ jobId, catalogDigest, matches }) {
    if (!Array.isArray(matches) || matches.length > 5) {
      throw new SpeakingHomeworkError('DOCTOR_RESULT_INVALID', 'Phân tích bài bổ trợ không hợp lệ.');
    }
    return withTransaction(pool, async client => {
      const found = await client.query(`SELECT j.status, p.id AS link_id, p.status AS link_status,
        p.exercise_id, g.student_ref, a.class_id, a.doctor_course_key, j.created_at
        FROM speaking_homework.practice_analysis_job j
        JOIN speaking_homework.practice_link p ON p.id = j.practice_link_id
        JOIN speaking_homework.access_grant g ON g.id = p.access_grant_id
        JOIN speaking_homework.assignment a ON a.id = g.assignment_id
        WHERE j.id = $1 FOR UPDATE OF j`, [jobId]);
      const job = found.rows[0];
      if (!job) throw new SpeakingHomeworkError('DOCTOR_JOB_NOT_FOUND', 'Không thấy lượt phân tích.', 404);
      if (job.status === 'done') return { linkId: job.link_id, status: 'done' };
      if (job.status !== 'processing' || job.link_status !== 'accepted') {
        throw new SpeakingHomeworkError('DOCTOR_JOB_NOT_ACTIVE', 'Lượt phân tích chưa sẵn sàng.');
      }
      const catalog = await client.query(`SELECT id, title, exercise_url
        FROM speaking_homework.doctor_exercise
        WHERE course_key = $1 AND active = true ORDER BY id`, [job.doctor_course_key]);
      if (hash(JSON.stringify(catalog.rows)) !== catalogDigest) {
        throw new SpeakingHomeworkError('DOCTOR_CATALOG_CHANGED', 'Danh mục đã thay đổi; cần thử lại.');
      }
      const allowed = new Set(catalog.rows.map(row => row.id));
      const unique = new Set();
      for (const match of matches) {
        if (!allowed.has(match?.exerciseId)
          || !Number.isInteger(match?.evidenceMessage) || match.evidenceMessage < 1
          || typeof match?.evidenceQuote !== 'string' || match.evidenceQuote.length < 5
          || typeof match?.reason !== 'string' || !match.reason.trim()) {
          throw new SpeakingHomeworkError('DOCTOR_RESULT_INVALID', 'Dẫn chứng lỗi chưa hợp lệ.');
        }
        unique.add(match.exerciseId);
      }
      await client.query(`INSERT INTO speaking_homework.practice_analysis
        (practice_link_id, catalog_digest, matches) VALUES ($1, $2, $3::jsonb)
        ON CONFLICT (practice_link_id) DO NOTHING`,
      [job.link_id, catalogDigest, JSON.stringify(matches)]);
      for (const exerciseId of unique) {
        await client.query(`INSERT INTO speaking_homework.doctor_recommendation
          (class_id, student_ref, exercise_id) VALUES ($1, $2, $3)
          ON CONFLICT (class_id, student_ref, exercise_id) DO NOTHING`,
        [job.class_id, job.student_ref, exerciseId]);
        const rec = await client.query(`SELECT id, recommendation_count, proposed_at, last_practiced_at
          FROM speaking_homework.doctor_recommendation
          WHERE class_id = $1 AND student_ref = $2 AND exercise_id = $3 FOR UPDATE`,
        [job.class_id, job.student_ref, exerciseId]);
        const sourceKey = `doctor:practice:${job.link_id}:exercise:${exerciseId}`;
        const event = await client.query(`INSERT INTO speaking_homework.doctor_event
          (source_key, recommendation_id, kind, occurred_at)
          VALUES ($1, $2, 'recommendation', $3)
          ON CONFLICT (source_key) DO NOTHING RETURNING id`,
        [sourceKey, rec.rows[0].id, job.created_at]);
        if (!event.rows.length) continue;
        const previous = rec.rows[0];
        const reopen = Number(previous.recommendation_count) === 0 || (
          previous.proposed_at && previous.last_practiced_at
          && new Date(previous.last_practiced_at).getTime()
            - new Date(previous.proposed_at).getTime() > 5 * 86400000);
        await client.query(`UPDATE speaking_homework.doctor_recommendation
          SET recommendation_count = recommendation_count + 1,
            waiting = CASE WHEN $2 THEN true ELSE waiting END,
            proposed_at = CASE WHEN $2 THEN $3 ELSE proposed_at END
          WHERE id = $1`, [previous.id, Boolean(reopen), job.created_at]);
      }
      await client.query(`UPDATE speaking_homework.practice_analysis_job
        SET status = 'done', updated_at = now() WHERE id = $1`, [jobId]);
      return { linkId: job.link_id, status: 'done', exerciseCount: unique.size };
    });
  }

  async function failPracticeAnalysisJob({ jobId, errorCode }) {
    await pool.query(`UPDATE speaking_homework.practice_analysis_job
      SET status = 'failed', last_error_code = $2, updated_at = now()
      WHERE id = $1 AND status = 'processing'`, [jobId, errorCode]);
  }

  async function getTeacherReceipt({ receiptId, email, canAccessAllClasses = false }) {
    const allowed = buildTeacherClassAccessPredicate({
      reviewerEmailSql: '$2', classIdSql: 'a.class_id'
    });
    const result = await pool.query(`
      SELECT r.id AS receipt_id, r.created_at, s.submitted_at,
        a.title, a.class_id, a.course_id, a.course_work_id,
        c.erp_class_name_snapshot AS class_code,
        m.erp_student_name_snapshot AS student_name,
        g.document_id,
        (SELECT jsonb_object_agg(l.part, jsonb_build_object(
          'url', l.share_url, 'questionCount', l.question_count,
          'typingWarning', l.typing_warning, 'voiceConfirmed', l.voice_confirmed,
          'evidence', l.evidence, 'checkedAt', l.checked_at
        )) FROM speaking_homework.submission_link l
        WHERE l.submission_id = s.id AND l.id IN (
          SELECT DISTINCT ON (part) id FROM speaking_homework.submission_link
          WHERE submission_id = s.id ORDER BY part, revision DESC
        )) AS links,
        (SELECT jsonb_agg(jsonb_build_object(
          'slot', p.slot, 'exerciseTitle', e.title, 'url', p.share_url,
          'status', p.status, 'analysisStatus', aj.status,
          'voiceConfirmed', p.voice_confirmed, 'typingWarning', p.typing_warning
        ) ORDER BY p.slot) FROM speaking_homework.practice_link p
        JOIN speaking_homework.doctor_exercise e ON e.id = p.exercise_id
        LEFT JOIN speaking_homework.practice_analysis_job aj ON aj.practice_link_id = p.id
        WHERE p.access_grant_id = g.id AND p.id IN (
          SELECT DISTINCT ON (slot) id FROM speaking_homework.practice_link
          WHERE access_grant_id = g.id ORDER BY slot, revision DESC
        )) AS practice_links,
        (SELECT jsonb_object_agg(o.kind, jsonb_build_object(
          'status', o.status, 'externalReceipt', o.external_receipt
        )) FROM speaking_homework.outbox o WHERE o.receipt_id = r.id) AS processing,
        (SELECT jsonb_build_object('partCounts', grade.part_counts,
          'totalQuestions', grade.total_questions,
          'typingWarningParts', grade.typing_warning_parts,
          'voiceConfirmedParts', grade.voice_confirmed_parts,
          'status', grade.status)
          FROM speaking_homework.grade_result grade
          WHERE grade.receipt_id = r.id) AS grade_summary
      FROM speaking_homework.receipt r
      JOIN speaking_homework.submission s ON s.id = r.submission_id
      JOIN speaking_homework.access_grant g ON g.id = s.access_grant_id
      JOIN speaking_homework.assignment a ON a.id = g.assignment_id
      JOIN mapping.classroom_course_mapping c ON c.erp_course_class_id = a.class_id
      JOIN mapping.student_mapping_review m
        ON m.public_id = g.student_ref AND m.erp_course_class_id = a.class_id
      WHERE r.id = $1 AND ($3::boolean = true OR ${allowed})`,
    [receiptId, email, Boolean(canAccessAllClasses)]);
    if (!result.rows.length) {
      throw new SpeakingHomeworkError('RECEIPT_NOT_FOUND', 'Không thấy bài hoặc bạn chưa được cấp quyền xem.', 404);
    }
    return result.rows[0];
  }

  return { openAssignment, startSession, open, requestCheck, claimCheckJob, completeCheck, failCheckJob,
    rejectCheckJob,
    claimOutboxJob, completeOutboxJob, failOutboxJob, completeGradeJob,
    getDoctorCatalog, completeDoctorJob,
    finish, recordDoctorEvent, listDoctor, requestPracticeCheck, claimPracticeCheckJob,
    completePracticeCheck, confirmPracticeVoice, failPracticeCheckJob, rejectPracticeCheckJob,
    claimPracticeAnalysisJob, getPracticeDoctorCatalog, completePracticeAnalysisJob,
    failPracticeAnalysisJob, getTeacherReceipt, resolveGrant };
}
