import { createSpeakingDocsJobs } from './speaking-docs-jobs.js';
import { createSpeakingHomeworkService } from './speaking-homework.js';
import { planSpeakingStatusWrite, verifySpeakingStatusWrite } from './speaking-independent-status.js';

const teacherPage = 'https://tranhoangduc90.github.io/izone-ai-team-pages/speaking-homework/teacher.html';

export function createSpeakingDocsAttemptStore(pool, lane) {
  async function find(eventId, binding) {
    const { rows: [row] } = await pool.query(`SELECT document_id, tab_id, account_role
      FROM speaking_docs_write.attempt WHERE lane=$1 AND event_id=$2`, [lane, eventId]);
    if (!row) return null;
    if (row.document_id !== binding.documentId || row.tab_id !== binding.tabId) throw Error('DOC_IDENTITY_MISMATCH');
    return { accountRole: row.account_role };
  }
  async function record({ input, accountRole, revisionId }) {
    await pool.query(`INSERT INTO speaking_docs_write.attempt(lane,event_id,document_id,tab_id,account_role,revision_id)
      VALUES($1,$2,$3,$4,$5,$6)`, [lane, input.eventId, input.binding.documentId, input.binding.tabId, accountRole, revisionId]);
  }
  async function clear(eventId) {
    await pool.query('DELETE FROM speaking_docs_write.attempt WHERE lane=$1 AND event_id=$2', [lane, eventId]);
  }
  return { find, record, clear };
}

function writer({ execute, accounts, withDocumentLock, attempts, log }, product, eventId, resultVersion, binding, actions) {
  return execute({ product, eventId, resultVersion, binding }, {
    accounts, withDocumentLock, log,
    verifySource: actions.assert,
    async loadCurrentProjection() {
      return { reconciliation: await attempts.find(eventId, binding) };
    },
    assertWriter: actions.assert,
    plan: actions.plan,
    verify: document => Boolean(document.revisionId) && actions.verify(document),
    recordAttempt: attempts.record,
    recordRejection: () => attempts.clear(eventId),
    async recordVerified({ document }) {
      await actions.complete(document);
      await attempts.clear(eventId);
    },
  });
}

export function createNativeHomeworkReceiptWriter({ pool, ...runtime }) {
  const jobs = createSpeakingDocsJobs({ pool });
  const attempts = createSpeakingDocsAttemptStore(pool, 'speaking_homework');
  return async claim => {
    const jobId = claim.job_id;
    const attempt = Number(claim.attempts) + 1;
    if (!Number.isSafeInteger(attempt) || attempt < 1) throw Error('DOC_JOB_NOT_ACTIVE');
    const binding = { documentId: claim.document_id, tabId: 't.0' };
    return writer({ ...runtime, attempts }, 'speaking_homework', jobId, claim.receipt_id, binding, {
      async assert() {
        const job = await jobs.loadJob(jobId);
        if (job.document_id !== claim.document_id || job.receipt_id !== claim.receipt_id || job.student_ref !== claim.student_ref || job.revoked_at) {
          throw Error('DOC_IDENTITY_MISMATCH');
        }
        if (job.status !== 'processing' || job.attempts !== attempt) throw Error('DOC_JOB_NOT_ACTIVE');
      },
      plan: document => jobs.plan({ jobId, document }),
      verify: async document => (await jobs.verify({ jobId, document })).matches,
      complete: document => jobs.verifyAndComplete({ jobId, document, expectedAttempt: attempt }),
    });
  };
}

export function createNativeIndependentReceiptWriter({ pool, ...runtime }) {
  const attempts = createSpeakingDocsAttemptStore(pool, 'speaking_independent');
  return async (service, claim) => {
    const binding = { documentId: claim.u.document_id, tabId: claim.u.tab_id };
    const jobId = claim.job_id;
    const linkUrl = teacherPage + '?receipt=' + claim.receipt_id + '&system=independent';
    const assertBinding = async (db, job) => {
      const { rows: [unit] } = await db.query(`SELECT u.id,u.document_id,u.tab_id,u.revoked_at,u.profile_id,r.id AS receipt_id
        FROM speaking_independent.work_unit u JOIN speaking_independent.receipt r ON r.work_unit_id=u.id WHERE u.id=$1`, [job.work_unit_id]);
      if (job.kind !== 'write_doc' || !unit || unit.revoked_at || unit.id !== claim.u.id ||
        unit.document_id !== binding.documentId || unit.tab_id !== binding.tabId ||
        unit.receipt_id !== claim.receipt_id || unit.profile_id !== claim.u.profile_id) throw Error('DOC_IDENTITY_MISMATCH');
    };
    const verify = document => verifySpeakingStatusWrite({ document, ...binding, linkUrl });
    return writer({ ...runtime, attempts }, 'speaking_independent', jobId, claim.receipt_id, binding, {
      assert: () => service.mutateJob(claim, assertBinding),
      plan(document) {
        const plan = planSpeakingStatusWrite({ document, ...binding, receiptId: claim.receipt_id, teacherBaseUrl: teacherPage });
        for (const item of plan.requests) {
          if (item.updateTextStyle?.textStyle?.link) item.updateTextStyle.textStyle.link.url = linkUrl;
        }
        return plan;
      },
      verify,
      complete: document => service.mutateJob(claim, async (db, job) => {
        await assertBinding(db, job);
        if (!verify(document)) throw Error('DOC_READBACK_MISMATCH');
        await db.query("UPDATE speaking_independent.job SET status='done',result=$2,lease_until=NULL WHERE id=$1",
          [jobId, JSON.stringify({ documentId: binding.documentId, revisionId: document.revisionId })]);
      }),
    });
  };
}

export function startNativeHomeworkReceiptWorker({ pool, runtime, idleMs = 10_000 }) {
  if (!runtime) return { async stop() {} };
  const service = createSpeakingHomeworkService({ pool, nativeDocsScope: runtime.scope });
  const write = createNativeHomeworkReceiptWriter({ pool, ...runtime });
  let timer;
  let running;
  let stopped = false;
  let pending = false;
  let retryNotBefore = 0;
  function schedule(ms) {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(() => { running = run(); }, Math.max(ms, retryNotBefore - Date.now())).unref();
  }
  async function run() {
    let delay = idleMs;
    let phase = 'claim';
    const started = performance.now();
    try {
      const job = await service.claimOutboxJob('write_doc', 'native');
      if (!job) return;
      delay = 500;
      let errorCode;
      try {
        const result = await write(job);
        if (!result.readback) errorCode = 'DOC_NEEDS_RECONCILIATION';
      } catch (error) {
        const value = error.code || error.message;
        errorCode = /^DOC_[A-Z0-9_]{1,80}$/.test(value || '') ? value : 'DOC_WRITE_FAILED';
        runtime.log({ stage: 'homework_receipt_worker', reason: 'DOC_WRITE_FAILED', phase: 'write', errorCode,
          httpStatus: Number.isInteger(error.status) && error.status>=400 && error.status<=599 ? error.status : undefined });
      }
      phase = 'record_failure';
      if (errorCode) await service.failOutboxJob({ jobId: job.job_id, errorCode, expectedAttempt: Number(job.attempts) + 1 });
    } catch (error) {
      const value = error?.code ?? error?.cause?.code;
      const sqlState = typeof value === 'string' && /^[0-9A-Z]{5}$/.test(value) ? value : undefined;
      const retryableDatabase = sqlState?.startsWith('08') || ['57014','55P03','57P01','53300'].includes(sqlState)
        || ['ECONNRESET','ECONNREFUSED','ETIMEDOUT'].includes(value);
      if (retryableDatabase) retryNotBefore = Date.now() + Math.min(60_000, idleMs * (1 + Math.random()));
      runtime.log({ stage: 'homework_receipt_worker', reason: 'DOC_WORKER_RETRY', phase, sqlState,
        durationMs: Math.round(performance.now() - started), retryAfterMs: Math.max(0, Math.ceil(retryNotBefore - Date.now())) });
    } finally {
      running = null;
      schedule(pending ? 0 : delay);
      pending = false;
    }
  }
  schedule(0);
  return {
    wake() { if (running) pending = true; else schedule(0); },
    async stop() { stopped = true; clearTimeout(timer); await running; },
  };
}
