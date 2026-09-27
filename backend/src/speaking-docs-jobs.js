import { planSpeakingStatusWrite, verifySpeakingStatusWrite } from './speaking-docs-writer.js';
import { SpeakingHomeworkError } from './speaking-homework.js';

const TEACHER_PAGE = 'https://tranhoangduc90.github.io/izone-ai-team-pages/speaking-homework/teacher.html';

// Dữ liệu vào: job ghi Google Docs đã nhận bởi worker và JSON của Docs API.
// Việc chính: xác minh job/Doc/receipt rồi lập lệnh chỉ sửa ô vàng dưới tiêu đề Speaking.
// Kết quả: kế hoạch có khóa revision, hoặc xác nhận ô đã ghi đúng sau một lần retry.
export function createSpeakingDocsJobs({ pool }) {
  async function loadJob(jobId) {
    const found = await pool.query(`SELECT o.id, o.status, o.kind, r.id AS receipt_id,
        g.document_id
      FROM speaking_homework.outbox o
      JOIN speaking_homework.receipt r ON r.id = o.receipt_id
      JOIN speaking_homework.submission s ON s.id = r.submission_id
      JOIN speaking_homework.access_grant g ON g.id = s.access_grant_id
      WHERE o.id = $1`, [jobId]);
    const job = found.rows[0];
    if (!job || job.kind !== 'write_doc' || !['processing', 'done'].includes(job.status)) {
      throw new SpeakingHomeworkError('DOC_JOB_NOT_ACTIVE', 'Việc ghi Homework chưa ở trạng thái xử lý.', 409);
    }
    return job;
  }

  async function plan({ jobId, document }) {
    const job = await loadJob(jobId);
    if (job.status === 'done') {
      if (!verifySpeakingStatusWrite({ document, documentId: job.document_id,
        linkUrl: `${TEACHER_PAGE}?receipt=${job.receipt_id}` })) {
        throw new SpeakingHomeworkError('DOC_READBACK_MISMATCH', 'Google Docs chưa có đúng biên nhận đã lưu.');
      }
      return { status: 'already_current', requests: [], documentId: job.document_id,
        receiptId: job.receipt_id, revisionId: document.revisionId };
    }
    try {
      const result = planSpeakingStatusWrite({ document, documentId: job.document_id,
        receiptId: job.receipt_id, teacherBaseUrl: TEACHER_PAGE });
      return { ...result, documentId: job.document_id, receiptId: job.receipt_id };
    } catch (error) {
      throw new SpeakingHomeworkError(String(error.message || 'DOC_PLAN_FAILED'),
        'Chưa lập được lệnh ghi đúng ô trạng thái Homework.');
    }
  }

  async function verifyAndComplete({ jobId, document }) {
    const job = await loadJob(jobId);
    const linkUrl = `${TEACHER_PAGE}?receipt=${job.receipt_id}`;
    if (!verifySpeakingStatusWrite({ document, documentId: job.document_id, linkUrl })) {
      throw new SpeakingHomeworkError('DOC_READBACK_MISMATCH',
        'Google Docs chưa có đúng dòng xác nhận và link giảng viên.');
    }
    if (job.status === 'processing') {
      const receipt = `docs:${job.document_id}:${document.revisionId}`;
      await pool.query(`UPDATE speaking_homework.outbox
        SET status = 'done', external_receipt = $2, updated_at = now()
        WHERE id = $1 AND kind = 'write_doc' AND status = 'processing'`, [jobId, receipt]);
    }
    return { status: 'done', documentId: job.document_id, receiptId: job.receipt_id };
  }
  return { plan, verifyAndComplete };
}
