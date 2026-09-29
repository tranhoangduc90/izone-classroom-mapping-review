import { withTransaction } from './db.js';
import { SpeakingHomeworkError } from './speaking-homework.js';

const CTA_TEXT = 'NHẤN VÀO ĐÂY ĐỂ LUYỆN TẬP SPEAKING';
const PAGE_ORIGIN = 'https://tranhoangduc90.github.io';
const PAGE_PATH = '/izone-ai-team-pages/speaking-homework/lesson-3.html';
const LESSON_4_CODE = '67-speaking-chen_diem_giua';

function textRuns(document) {
  const runs = [];
  function walk(content, tabId) {
    for (const element of content || []) {
      for (const part of element.paragraph?.elements || []) {
        if (part.textRun) runs.push({ text: part.textRun.content || '',
          start: part.startIndex, end: part.endIndex,
          url: part.textRun.textStyle?.link?.url || '',
          style: part.textRun.textStyle || {}, tabId });
      }
      for (const row of element.table?.tableRows || []) {
        for (const cell of row.tableCells || []) walk(cell.content, tabId);
      }
    }
  }
  for (const tab of document.tabs || []) {
    walk(tab.documentTab?.body?.content, tab.tabProperties?.tabId);
  }
  return runs;
}

function hasWhiteCtaStyle(style) {
  const color = style?.foregroundColor?.color?.rgbColor;
  return color?.red === 1 && color?.green === 1 && color?.blue === 1
    && style?.underline !== true;
}

export function speakingCopyUrl({ documentId, classCode, assignmentCode }) {
  const page = assignmentCode === LESSON_4_CODE
    ? '/izone-ai-team-pages/speaking-homework/lesson-4.html' : PAGE_PATH;
  const url = new URL(page, PAGE_ORIGIN);
  url.searchParams.set('documentId', documentId);
  url.searchParams.set('class', classCode);
  url.searchParams.set('assignmentCode', assignmentCode);
  return url.href;
}

// Đầu vào: JSON của đúng bản sao Google Docs và thông tin bài Classroom đã ghép.
// Việc chính: tìm duy nhất CTA, sửa hyperlink bằng revision để không đè chỉnh sửa mới.
// Kết quả: kế hoạch ghi hoặc no-op; thiếu CTA/trùng CTA sẽ báo lỗi trong execution.
export function planSpeakingCopyCta({ document, documentId, classCode, assignmentCode }) {
  if (document.documentId !== documentId || !document.revisionId) throw new Error('DOC_IDENTITY_MISMATCH');
  const url = speakingCopyUrl({ documentId, classCode, assignmentCode });
  const matches = textRuns(document).filter(run => run.text.includes(CTA_TEXT));
  if (matches.length !== 1 || matches[0].start == null || !matches[0].tabId) {
    throw new Error('DOC_CTA_AMBIGUOUS');
  }
  const run = matches[0];
  if (run.url === url && hasWhiteCtaStyle(run.style)) return { status: 'already_current', url,
    revisionId: document.revisionId, requests: [] };
  const startIndex = run.start + run.text.indexOf(CTA_TEXT);
  return { status: 'write', url, revisionId: document.revisionId,
    requests: [{ updateTextStyle: {
      range: { startIndex, endIndex: startIndex + CTA_TEXT.length, tabId: run.tabId },
      textStyle: { link: { url }, underline: false, foregroundColor: {
        color: { rgbColor: { red: 1, green: 1, blue: 1 } }
      } }, fields: 'link,foregroundColor,underline'
    } }] };
}

export function verifySpeakingCopyCta({ document, documentId, classCode, assignmentCode }) {
  if (document.documentId !== documentId) return false;
  const url = speakingCopyUrl({ documentId, classCode, assignmentCode });
  const matches = textRuns(document).filter(run => run.text.includes(CTA_TEXT));
  return matches.length === 1 && matches[0].url === url
    && hasWhiteCtaStyle(matches[0].style);
}

export function createSpeakingClassroomCopies({ pool }) {
  async function assignment(client, courseId, courseWorkId) {
    const result = await client.query(`SELECT a.id, a.assignment_code,
      c.erp_class_name_snapshot AS class_code, a.class_id
      FROM speaking_homework.assignment a
      JOIN mapping.classroom_course_mapping c ON c.erp_course_class_id = a.class_id
      WHERE a.course_id = $1 AND a.course_work_id = $2
        AND a.status IN ('draft', 'open') AND c.status = 'approved'`,
    [courseId, courseWorkId]);
    if (result.rows.length !== 1) throw new SpeakingHomeworkError('ASSIGNMENT_NOT_FOUND',
      'Không tìm thấy bài Classroom đã duyệt.', 404);
    return result.rows[0];
  }

  // Đầu vào: snapshot đầy đủ của đúng bài Classroom, kèm ID bản sao từ attachment.
  // Việc chính: đối chiếu userId với mapping được duyệt rồi ghép một file cho một học viên.
  // Kết quả: danh sách file còn cần cập nhật CTA; mọi xung đột danh tính đều rollback.
  async function sync({ courseId, courseWorkId, submissions }) {
    return withTransaction(pool, async client => {
      const a = await assignment(client, courseId, courseWorkId);
      const pending = [];
      for (const item of submissions) {
        if (!item.documentId) continue;
        const mapped = await client.query(`SELECT m.public_id AS student_ref
          FROM mapping.student_mapping_review m
          WHERE m.erp_course_class_id = $1 AND m.classroom_user_id = $2
            AND m.status = 'approved'
            AND EXISTS (SELECT 1 FROM mapping.erp_class_membership_snapshot e
              WHERE e.erp_course_class_id = m.erp_course_class_id
                AND e.erp_student_contact_id = m.erp_student_contact_id
                AND lower(trim(coalesce(e.registration_status, ''))) NOT IN ('dropped', 'on_hold'))`,
        [a.class_id, item.userId]);
        if (mapped.rows.length !== 1) throw new SpeakingHomeworkError('STUDENT_MAPPING_INVALID',
          'Học viên Classroom chưa ghép duy nhất với lớp.', 409);
        const studentRef = mapped.rows[0].student_ref;
        const inserted = await client.query(`INSERT INTO speaking_homework.assignment_document
          (assignment_id, document_id, student_ref, classroom_submission_id)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (document_id) DO UPDATE SET document_id = EXCLUDED.document_id
          WHERE speaking_homework.assignment_document.assignment_id = EXCLUDED.assignment_id
            AND speaking_homework.assignment_document.student_ref = EXCLUDED.student_ref
            AND speaking_homework.assignment_document.classroom_submission_id = EXCLUDED.classroom_submission_id
          RETURNING cta_verified_at`,
        [a.id, item.documentId, studentRef, item.id]);
        if (inserted.rows.length !== 1) throw new SpeakingHomeworkError('DOCUMENT_BINDING_CONFLICT',
          'Bản sao Google Docs đã được ghép với bài hoặc học viên khác.', 409);
        if (!inserted.rows[0].cta_verified_at) pending.push({ documentId: item.documentId,
          classroomSubmissionId: item.id, classCode: a.class_code,
          assignmentCode: a.assignment_code });
      }
      return { pending, bound: submissions.filter(item => item.documentId).length };
    });
  }

  async function plan({ documentId, document }) {
    const result = await pool.query(`SELECT d.document_id, d.classroom_submission_id,
      a.assignment_code, c.erp_class_name_snapshot AS class_code
      FROM speaking_homework.assignment_document d
      JOIN speaking_homework.assignment a ON a.id = d.assignment_id
      JOIN mapping.classroom_course_mapping c ON c.erp_course_class_id = a.class_id
      WHERE d.document_id = $1 AND d.student_ref IS NOT NULL
        AND d.classroom_submission_id IS NOT NULL
        AND a.status IN ('draft', 'open') AND c.status = 'approved'`, [documentId]);
    if (result.rows.length !== 1) throw new SpeakingHomeworkError('DOCUMENT_NOT_BOUND',
      'File chưa được đối chiếu với Classroom.', 404);
    const plan = planSpeakingCopyCta({ document, documentId,
      classCode: result.rows[0].class_code,
      assignmentCode: result.rows[0].assignment_code });
    return { ...plan, documentId };
  }

  async function verify({ documentId, document }) {
    return withTransaction(pool, async client => {
      const result = await client.query(`SELECT d.id, d.cta_verified_at,
        a.assignment_code, c.erp_class_name_snapshot AS class_code
        FROM speaking_homework.assignment_document d
        JOIN speaking_homework.assignment a ON a.id = d.assignment_id
        JOIN mapping.classroom_course_mapping c ON c.erp_course_class_id = a.class_id
        WHERE d.document_id = $1 AND d.student_ref IS NOT NULL
          AND d.classroom_submission_id IS NOT NULL
          AND a.status IN ('draft', 'open') AND c.status = 'approved'
        FOR UPDATE OF d`, [documentId]);
      if (result.rows.length !== 1) throw new SpeakingHomeworkError('DOCUMENT_NOT_BOUND',
        'File chưa được đối chiếu với Classroom.', 404);
      const row = result.rows[0];
      if (!verifySpeakingCopyCta({ document, documentId,
        classCode: row.class_code, assignmentCode: row.assignment_code })) {
        throw new SpeakingHomeworkError('DOC_CTA_NOT_VERIFIED',
          'Link trong file Homework chưa trỏ đúng bản sao.', 409);
      }
      if (!row.cta_verified_at) await client.query(`UPDATE speaking_homework.assignment_document
        SET cta_verified_at = now() WHERE id = $1`, [row.id]);
      return { documentId, verified: true, alreadyVerified: Boolean(row.cta_verified_at) };
    });
  }
  return { sync, plan, verify };
}
