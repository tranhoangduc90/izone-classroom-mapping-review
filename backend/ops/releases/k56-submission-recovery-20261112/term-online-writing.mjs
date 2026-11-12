import { z } from 'zod';
import { saveK56TermWritingSql } from './k56-term-writing-draft.js';

const text = z.string().max(12_000);
const requestSchema = z.object({
  attemptToken: z.string().uuid(),
  baseRevision: z.number().int().nonnegative().safe().nullable(),
  task1: text,
  task2: text,
  outline: text,
  recovery: z.record(z.unknown())
}).strict();

const reviewCodes = {
  revision_conflict: 'WRITING_REVISION_CONFLICT',
  deadline_expired: 'WRITING_DEADLINE_EXPIRED',
  client_update_required: 'WRITING_CLIENT_UPDATE_REQUIRED',
  already_submitted: 'SUBMISSION_DIFFERENT_CANONICAL'
};

export function registerTermOnlineWriting(router, {
  limiter, route, recovery, transaction, assets, record, failure,
  onWriting, readWritingResponse, serializeWriting, notifyWriting
}) {
  router.post('/:testSlug/writing/finalize', limiter, route(async (req, res) => {
    const slug = req.params.testSlug;
    const parsed = requestSchema.safeParse(req.body);
    if (!parsed.success) throw failure('INVALID_WRITING', 'Bản chốt Writing không hợp lệ.', 400);
    const { attemptToken, baseRevision, task1, task2, outline } = parsed.data;
    const retained = await recovery.retain(req, slug, 'writing', {
      attemptToken, draftRevision: baseRevision, writing: { task1, task2, outline }
    });
    const { proof, meta } = retained;
    const saved = await transaction(async client => {
      const a = await recovery.admit(client, slug, proof, 'writing', true);
      const response = await recovery.finishIfReplayed(client, a, retained);
      if (response) return { receipt: response, row: a, writing: (await readWritingResponse(client, a)).writing };
      const timing = a.mini_definition_snapshot?.timing || assets?.getTiming(slug);
      if (!Number.isFinite(timing?.writingDurationMinutes) || timing.writingDurationMinutes <= 0) {
        throw failure('DEFINITION_CHANGED', 'Chưa xác minh được thời gian của đề Writing.', 409);
      }
      const { rows: [row] } = await client.query(saveK56TermWritingSql, [
        attemptToken, task1, task2, 'submit', timing.writingDurationMinutes, baseRevision, outline
      ]);
      if (!row) return { review: 'WRITING_ATTEMPT_NOT_READY', reason: 'previous_section_missing' };
      const grading = row.writing_submitted_at && !a.writing_submitted_at
        ? await onWriting(row, client, { qualifiedOnline: true })
        : null;
      if (row.writing_accepted !== true || !row.writing_submitted_at) {
        return { row, grading, review: reviewCodes[row.writing_reason] || 'WRITING_SUBMISSION_REVIEW',
          reason: row.writing_reason, canonicalCommitted: Boolean(row.writing_submitted_at && !a.writing_submitted_at) };
      }
      const result = await recovery.finish(client, { ...a, ...row }, retained);
      if (!result.receipt) return { row, grading, review: result.review, reason: row.writing_reason };
      const { rows: jobs } = grading ? await client.query(`SELECT j.id::text AS job_id, r.id::text AS run_id, r.task_number
        FROM assessment.term_test_writing_grading_job j JOIN assessment.term_test_writing_grading_run r ON r.id=j.run_id
        WHERE r.attempt_id=$1 AND r.grading_version=$2 AND j.job_type='dispatch'`,
      [attemptToken, grading.version]) : { rows: [] };
      if (jobs.length) await client.query(`UPDATE assessment.term_online_submission_hold SET writing_grading_run_id=$4
        WHERE attempt_id=$1 AND generation=$2 AND operation_id=$3 AND receipt IS NOT NULL`,
      [attemptToken, proof.generation, proof.operationId, jobs[0].run_id]);
      return { ...result, row, jobs, writing: serializeWriting(row, grading), canonicalCommitted: !a.writing_submitted_at };
    }).catch(error => {
      const status = error.status || error.httpStatus;
      record('offline_request_failed', slug, attemptToken, { ...meta, phase: 'commit',
        errorCode: status ? error.code : 'OFFLINE_SUBMISSION_UNAVAILABLE' });
      const response = failure(status ? error.code : 'OFFLINE_SUBMISSION_UNAVAILABLE',
        status ? error.message : 'Chưa xác nhận được bài nộp. Hãy giữ bản trên thiết bị.', status || 503);
      if (![401, 403, 404].includes(response.status)) response.held = retained.held;
      throw response;
    });
    if (saved.canonicalCommitted) {
      try { notifyWriting?.(); } catch {}
    }
    if (saved.review) {
      record('offline_request_failed', slug, attemptToken, { ...meta, phase: 'after_commit',
        errorCode: saved.review, reason: saved.reason, submitted: Boolean(saved.row?.writing_submitted_at) });
      return res.status(409).json({ ok: false, error: saved.review, held: retained.held,
        message: 'Máy chủ đã giữ bản chốt để đối soát. Bản này chưa có biên nhận nộp.' });
    }
    record('offline_operation_committed', slug, attemptToken, { ...meta, phase: 'after_commit',
      receiptId: saved.receipt.receiptId, accepted: true, replayed: !saved.canonicalCommitted });
    for (const job of saved.jobs || []) record('job_queued', slug, attemptToken, {
      ...meta, phase: 'after_commit', receiptId: saved.receipt.receiptId, jobId: job.job_id, task: Number(job.task_number)
    });
    res.set('Cache-Control', 'no-store, private').json({
      ok: true, attemptToken, receipt: saved.receipt, writing: { ...saved.writing, accepted: true }
    });
  }));
}
