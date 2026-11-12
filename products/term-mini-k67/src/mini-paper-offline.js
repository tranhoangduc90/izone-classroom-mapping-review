import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { findStudentForTermTestSql, insertProtectedListeningAttemptSql } from './sql.js';
import { buildCombinedResult, gradeSection, parseStoredTest } from './term-tests.js';
import { canSubmitWithoutHold, readMiniPaperSubmissionHold, retainMiniPaperSubmission, removeMiniPaperSubmissionHold } from './mini-cbt-journey.js';

const slug = 'mini-test-lesson-5';
const prefix = `/api/term-tests/${slug}`;
const policy = 'mini-k67-paper-offline-v1';
const sections = z.enum(['listening', 'reading']);
const scope = z.object({
  attemptToken: z.uuid(),
  examSessionToken: z.uuid(),
  generation: z.number().int().nonnegative(),
  ownerId: z.uuid()
});
const prepareSchema = scope.extend({
  classCode: z.string().trim().toUpperCase().regex(/^[A-Z0-9._-]{2,32}$/),
  studentRef: z.uuid(),
  mode: z.enum(['lis_first', 'read_first']),
  attemptMode: z.literal('answer_sheet'),
  identityConfirmed: z.literal(true)
}).strict();
const statusSchema = scope.extend({ operationId: z.uuid() }).strict();
const recoveryStatusSchema = statusSchema.extend({ section: sections.optional() }).strict();
const operationSchema = statusSchema.extend({
  section: sections,
  kind: z.enum(['start', 'draft', 'seal']),
  revision: z.number().int().nonnegative(),
  occurredAt: z.iso.datetime(),
  dependency: z.uuid().nullable(),
  payload: z.object({
    answers: z.record(z.string().regex(/^\d{1,2}$/), z.string().max(120)),
    startedAt: z.iso.datetime(),
    deadlineAt: z.null(),
    timeValid: z.boolean(),
    reason: z.literal('manual').optional(),
    audioEnded: z.literal(false).optional(),
    heardSeconds: z.literal(0).optional()
  }).strict()
}).strict();

function problem(code, message, status = 409) {
  return Object.assign(new Error(message), { code, status });
}
function parse(schema, value) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw problem('OFFLINE_INVALID', 'Dữ liệu chưa hợp lệ. Bài vẫn được giữ trên máy.', 400);
  return parsed.data;
}
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const first = mode => mode === 'read_first' ? 'reading' : 'listening';
const other = section => section === 'reading' ? 'listening' : 'reading';

async function transaction(pool, execute) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const result = await execute(db);
    await db.query('COMMIT');
    return result;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
}

async function lockedSession(db, body) {
  // The session UUID stays stable across the first Listening seal of a legacy-order paper attempt.
  if (body.attemptToken !== body.examSessionToken) throw problem('OFFLINE_SCOPE', 'Phiên bài không khớp.', 403);
  const owner = (await db.query(`SELECT erp_course_class_id,erp_student_contact_id
    FROM assessment.term_test_exam_session WHERE id=$1 AND test_slug=$2`, [body.examSessionToken, slug])).rows[0];
  if (!owner) throw problem('OFFLINE_SCOPE', 'Phiên bài không khớp.', 403);
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${slug}:${owner.erp_course_class_id}:${owner.erp_student_contact_id}`]);
  const session = (await db.query('SELECT * FROM assessment.term_test_exam_session WHERE id=$1 FOR UPDATE', [body.examSessionToken])).rows[0];
  if (!session || session.superseded_at || session.attempt_mode !== 'answer_sheet' || Number(session.generation) !== body.generation) {
    throw problem('OFFLINE_SCOPE', 'Lượt nhập đáp án đã thay đổi. Giữ bản trên máy để đối soát.', 403);
  }
  const attempt = session.attempt_id ? (await db.query(`SELECT * FROM assessment.term_test_attempt
    WHERE id=$1 AND exam_session_id=$2 FOR UPDATE`, [session.attempt_id, session.id])).rows[0] : null;
  if ((session.attempt_id && !attempt) || (attempt && (attempt.test_slug !== slug || attempt.attempt_mode !== 'answer_sheet'
      || attempt.superseded_at || Number(attempt.generation) !== body.generation))) {
    throw problem('OFFLINE_SCOPE', 'Lượt nhập đáp án đã thay đổi. Giữ bản trên máy để đối soát.', 403);
  }
  return { session, attempt };
}

async function runFor(db, sessionId) {
  return (await db.query('SELECT * FROM assessment.mini_k67_paper_offline_run WHERE session_id=$1 FOR UPDATE', [sessionId])).rows[0];
}

function miniPaperOfflineAdvertised(config) {
  return ['on', 'drain'].includes(config.miniPaperOfflineMode);
}

export function offerMiniPaperOffline(config, classCode) {
  return config.miniPaperOfflineMode === 'on'
    && (!config.miniPaperOfflineClasses?.size || config.miniPaperOfflineClasses.has(classCode));
}

export async function guardMiniPaperOfflineWrite(db, config, sessionId, generation) {
  if (!sessionId || !miniPaperOfflineAdvertised(config)) return;
  const run = await runFor(db, sessionId);
  if (run && Number(run.generation) === Number(generation)) {
    throw problem('OFFLINE_CLIENT_REQUIRED', 'Lượt này đang lưu offline. Hãy tiếp tục trên đúng thiết bị và trang đã mở bài.');
  }
}

function permit(secret, run) {
  return createHmac('sha256', secret)
    .update([policy, run.session_id, run.owner_id, run.student_ref, run.generation].join(':')).digest('hex');
}
function verifyPermit(secret, run, scope, supplied) {
  return run && run.owner_id === scope.ownerId && Number(run.generation) === scope.generation
    && typeof supplied === 'string' && /^[0-9a-f]{64}$/.test(supplied)
    && timingSafeEqual(Buffer.from(permit(secret, run), 'hex'), Buffer.from(supplied, 'hex'));
}

function stateOf({ session, attempt }, studentRef, run, secret, recoveryEnabled) {
  const examMode = session.exam_mode || 'lis_first';
  const listeningSubmitted = Boolean(session.listening_submitted_at);
  const readingSubmitted = Boolean(attempt?.reading_submitted_at);
  const completed = Boolean(attempt?.completed_at);
  const initial = first(examMode);
  const done = { listening: listeningSubmitted, reading: readingSubmitted };
  return {
    ok: true, studentRef, studentName: session.student_name_snapshot, className: session.class_name_snapshot,
    attemptToken: session.id, examSessionToken: session.id, nativeAttemptToken: attempt?.id || null,
    generation: Number(session.generation),
    examMode, examDelivery: 'answer_sheet', attemptMode: 'answer_sheet', policy: { timed: false, autoSubmit: false },
    nextSection: !done[initial] ? initial : !done[other(initial)] ? other(initial) : 'result',
    listeningSubmitted, readingSubmitted, completed,
    listeningDraft: session.listening_draft || {}, readingDraft: attempt?.reading_draft || {},
    listeningDraftRevision: Number(session.listening_draft_revision) || 0,
    readingDraftRevision: Number(attempt?.reading_draft_revision) || 0,
    readingStartedAt: attempt?.reading_started_at || null, readingDeadlineAt: null, listeningDeadlineAt: null,
    result: attempt?.combined_result || null, portalSyncStatus: 'not_applicable',
    serverNow: new Date().toISOString(),
    offline: { policy, ownerId: run.owner_id, permit: permit(secret, run), preparedAt: new Date(run.prepared_at).toISOString(),
      ...(recoveryEnabled && run.lr_hold_cohort === true ? { submissionRecoveryVersion: 1 } : {}) }
  };
}

async function definitionFor(db, session) {
  const definition = (await db.query(`SELECT slug AS test_slug,title AS test_title,version AS definition_version,
    listening_band_adjustment,listening_definition,reading_definition FROM assessment.test_definition
    WHERE slug=$1 AND version=$2`, [slug, session.definition_version])).rows[0];
  if (!definition) throw problem('OFFLINE_DEFINITION', 'Chưa tìm thấy đúng phiên bản đề để nhận bài.');
  return parseStoredTest(definition);
}

function validateAnswerKeys(op, test) {
  const allowed = new Set(test[op.section + '_definition'].questions.map(question => String(question.number)));
  if (Object.keys(op.payload.answers).some(key => !allowed.has(key))) {
    throw problem('OFFLINE_ANSWER_KEYS', 'Có ô không thuộc đúng phiên bản đề.', 400);
  }
}

function nativeSection({ session, attempt }, section) {
  return section === 'listening'
    ? { revision: Number(session.listening_draft_revision) || 0, sealed: Boolean(session.listening_submitted_at) }
    : { revision: Number(attempt?.reading_draft_revision) || 0, sealed: Boolean(attempt?.reading_submitted_at) };
}

async function writeSection(db, locked, op, test) {
  const { session, attempt } = locked;
  const { section, kind, revision, payload } = op;
  const isReading = section === 'reading';
  if (isReading && !attempt) throw problem('OFFLINE_ORDER', 'Chưa xác nhận được lượt Reading.');
  const answers = JSON.stringify(payload.answers);
  if (kind === 'start') {
    if (isReading) await db.query(`UPDATE assessment.term_test_attempt
      SET reading_started_at=coalesce(reading_started_at,now()),reading_deadline_at=NULL,updated_at=now()
      WHERE id=$1`, [attempt.id]);
    return;
  }
  const id = isReading ? attempt.id : session.id;
  const table = isReading ? 'term_test_attempt' : 'term_test_exam_session';
  await db.query(`UPDATE assessment.${table} SET ${section}_draft=$2::jsonb,${section}_draft_revision=$3,
    ${section}_draft_updated_at=now(),updated_at=now() WHERE id=$1`, [id, answers, revision]);
  if (kind !== 'seal') return;
  const grade = gradeSection(test[`${section}_definition`], payload.answers, isReading ? 0 : test.listening_band_adjustment);
  if (!attempt) {
    const inserted = await db.query(insertProtectedListeningAttemptSql, [op.operationId, session.id, slug, answers, JSON.stringify(grade)]);
    const nativeId = inserted.rows[0]?.attempt_token;
    if (!nativeId) throw problem('OFFLINE_NATIVE_CONFLICT', 'Chưa thể gắn bài Listening vào đúng lượt.');
    await db.query(`UPDATE assessment.term_test_attempt SET attempt_mode='answer_sheet',exam_delivery='answer_sheet',
      writing_scope='lr_only',generation=$2 WHERE id=$1`, [nativeId, session.generation]);
    return;
  }
  const prior = attempt[`${other(section)}_result`];
  const result = prior ? buildCombinedResult(test, isReading ? prior : grade, isReading ? grade : prior) : null;
  await db.query(`UPDATE assessment.term_test_attempt SET ${section}_answers=$2::jsonb,${section}_result=$3::jsonb,
    ${section}_submitted_at=now(),combined_result=$4::jsonb,
    completed_at=CASE WHEN $4::jsonb IS NOT NULL THEN now() ELSE NULL END,updated_at=now() WHERE id=$1`,
    [attempt.id, answers, JSON.stringify(grade), result ? JSON.stringify(result) : null]);
  if (!isReading) await db.query(`UPDATE assessment.term_test_exam_session SET listening_submitted_at=now(),
    listening_started_at=coalesce(listening_started_at,now()),updated_at=now() WHERE id=$1`, [session.id]);
}

export function mountMiniPaperOffline(app, { pool, config, requireContext, readLimiter, writeLimiter, draftLimiter, observeSubmission }) {
  if (!miniPaperOfflineAdvertised(config)) return;
  const secret = config.termTestSessionSecret;
  const { miniPaperLrHoldHours: hours, miniPaperLrHoldLimit: limit, miniPaperLrHoldClasses: classes } = config;
  const recoveryEnabled = hours > 0 && limit > 0;
  const route = fn => async (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    try {
      if (!secret || secret.length < 32) throw problem('OFFLINE_UNAVAILABLE', 'Chưa thể xác nhận quyền offline.', 503);
      await fn(req, res);
    } catch (error) {
      if (!error.status) return next(error);
      res.status(error.status).json({ ok: false, error: error.code, message: error.message,
        ...(error.held ? { held: error.held } : {}) });
    }
  };
  async function authorized(db, body, req) {
    const locked = await lockedSession(db, body);
    const run = await runFor(db, locked.session.id);
    if (!verifyPermit(secret, run, body, req.get('x-term2-permit'))) {
      throw problem('OFFLINE_SCOPE', 'Quyền gửi bài không khớp lượt.', 403);
    }
    return { ...locked, run };
  }

  app.post(prefix + '/offline/prepare', writeLimiter, requireContext, route(async (req, res) => {
    const body = parse(prepareSchema, req.body);
    const student = await pool.query(findStudentForTermTestSql, [body.classCode, slug, body.studentRef]);
    if (student.rowCount !== 1) throw problem('OFFLINE_SCOPE', 'Không tìm thấy học viên trong lớp này.', 403);
    const response = await transaction(pool, async db => {
      const locked = await lockedSession(db, body);
      const { session, attempt } = locked;
      const selected = student.rows[0];
      if (String(session.erp_course_class_id) !== String(selected.class_id)
        || String(session.erp_student_contact_id) !== String(selected.student_id)
        || Number(session.definition_version) !== Number(selected.definition_version)
        || (session.exam_mode || 'lis_first') !== body.mode) {
        throw problem('OFFLINE_SCOPE', 'Lớp, người học hoặc thứ tự không khớp phiên.', 403);
      }
      let run = await runFor(db, session.id);
      if (!run) {
        if (!offerMiniPaperOffline(config, body.classCode)) {
          throw problem('OFFLINE_NEW_DISABLED', 'Lượt mới tiếp tục bằng chế độ hiện hành.', 503);
        }
        if (session.listening_submitted_at || Number(session.listening_draft_revision) > 0 || attempt?.reading_started_at) {
          throw problem('OFFLINE_LEGACY', 'Lượt đang làm tiếp tục bằng chế độ hiện hành.');
        }
        const enroll = recoveryEnabled && (classes?.has('*') || classes?.has(body.classCode));
        run = (await db.query(`INSERT INTO assessment.mini_k67_paper_offline_run
          (session_id,owner_id,student_ref,generation${enroll ? ',lr_hold_cohort' : ''})
          VALUES($1,$2,$3,$4${enroll ? ',true' : ''}) RETURNING *`,
          [session.id, body.ownerId, body.studentRef, body.generation])).rows[0];
      }
      if (run.owner_id !== body.ownerId || run.student_ref !== body.studentRef || Number(run.generation) !== body.generation) {
        throw problem('OFFLINE_OWNER_CONFLICT', 'Lượt này thuộc thiết bị khác. Hãy giữ nháp và liên hệ giảng viên.');
      }
      return stateOf(locked, body.studentRef, run, secret, recoveryEnabled);
    });
    res.json(response);
  }));

  app.post(prefix + '/offline/status', readLimiter, route(async (req, res) => {
    const body = parse(recoveryStatusSchema, req.body);
    const result = await transaction(pool, async db => {
      const { run } = await authorized(db, body, req);
      const receipt = (await db.query(`SELECT receipt FROM assessment.mini_k67_paper_offline_operation
        WHERE operation_id=$1 AND session_id=$2`, [body.operationId, body.examSessionToken])).rows[0]?.receipt;
      const held = !receipt && body.section && recoveryEnabled && run.lr_hold_cohort === true
        ? await readMiniPaperSubmissionHold(db, body, new Date()) : undefined;
      return { persisted: Boolean(receipt), receipt: receipt || null, ...(held ? { held } : {}) };
    });
    res.json({ ok: true, ...result });
  }));

  app.post(prefix + '/offline/result', readLimiter, route(async (req, res) => {
    const body = parse(scope.strict(), req.body);
    const response = await transaction(pool, async db => {
      const locked = await authorized(db, body, req);
      if (!locked.attempt?.completed_at) throw problem('OFFLINE_PENDING', 'Đang chờ máy chủ nhận đủ hai phần.');
      return stateOf(locked, locked.run.student_ref, locked.run, secret, recoveryEnabled);
    });
    res.json(response);
  }));

  app.post(prefix + '/offline/operation', draftLimiter, route(async (req, res) => {
    const op = parse(operationSchema, req.body);
    const payloadHash = digest(op);
    let held, observation;
    const readPrevious = async (db, session) => {
      const previous = (await db.query(`SELECT session_id,payload_hash,receipt FROM assessment.mini_k67_paper_offline_operation
        WHERE operation_id=$1`, [op.operationId])).rows[0];
      if (previous && (previous.session_id !== session.id || previous.payload_hash !== payloadHash)) {
        throw problem('OFFLINE_OPERATION_CONFLICT', 'Mã gửi đã có nội dung khác. Bài vẫn được giữ trên máy.');
      }
      return previous?.receipt;
    };
    const report = (event, accepted, reason) => {
      if (!observation) return;
      try {
        observeSubmission?.(event, slug, op.examSessionToken, {
          section: op.section, revision: op.revision, accepted, reason, submission: observation
        });
      } catch {}
    };
    const record = () => transaction(pool, async db => {
      const locked = await authorized(db, op, req);
      const { run, session } = locked;
      const previous = await readPrevious(db, session);
      if (previous) return { receipt: previous, replayed: true };
      const state = run.state;
      const item = state[op.section];
      const initial = first(session.exam_mode);
      if (op.section === initial ? op.dependency !== null : !state[initial]?.sealId || state[initial].sealId !== op.dependency) {
        throw problem('OFFLINE_ORDER', 'Chưa nhận đúng phần trước.');
      }
      const native = nativeSection(locked, op.section);
      if (item?.sealId || native.sealed || native.revision !== (item?.revision ?? 0)) {
        throw problem('OFFLINE_NATIVE_CONFLICT', 'Bài trên máy chủ đã thay đổi. Giữ bản trên máy để đối soát.');
      }
      const answerHash = digest(op.payload.answers);
      if (op.kind === 'start') {
        if (item || op.revision !== 0 || Object.keys(op.payload.answers).length) throw problem('OFFLINE_START', 'Mốc bắt đầu không khớp.');
      } else if (!item || op.payload.startedAt !== item.startedAt || op.revision < item.revision
        || (op.revision === item.revision && item.answerHash && item.answerHash !== answerHash)) {
        throw problem('OFFLINE_REVISION', 'Phiên bản bài chưa khớp. Giữ bản trên máy để đối soát.');
      }
      if (op.kind === 'seal' && op.payload.reason !== 'manual') throw problem('PAPER_MANUAL_ONLY', 'Phiếu giấy chỉ nộp khi học viên xác nhận.');
      const test = await definitionFor(db, session);
      validateAnswerKeys(op, test);
      await writeSection(db, locked, op, test);
      const receipt = {
        version: 1, receiptId: randomUUID(), operationId: op.operationId, payloadHash,
        attemptToken: op.attemptToken, examSessionToken: op.examSessionToken, generation: op.generation,
        section: op.section, kind: op.kind, acceptedRevision: op.revision, status: 'accepted',
        serverCommittedAt: new Date().toISOString()
      };
      const updated = { ...state, [op.section]: {
        startedAt: op.payload.startedAt, revision: op.revision,
        answerHash: op.kind === 'start' ? null : answerHash, sealId: op.kind === 'seal' ? op.operationId : null
      } };
      await db.query('UPDATE assessment.mini_k67_paper_offline_run SET state=$2::jsonb WHERE session_id=$1',
        [session.id, JSON.stringify(updated)]);
      await db.query(`INSERT INTO assessment.mini_k67_paper_offline_operation
        (operation_id,session_id,payload_hash,receipt) VALUES($1,$2,$3,$4::jsonb)`,
        [op.operationId, session.id, payloadHash, JSON.stringify(receipt)]);
      if (recoveryEnabled && op.kind==='seal' && run.lr_hold_cohort===true) await removeMiniPaperSubmissionHold(db, op);
      return { receipt, replayed: false };
    });
    let result;
    try {
      if (recoveryEnabled && op.kind === 'seal') {
        try {
          held = await transaction(pool, async db => {
            const { run, session } = await authorized(db, op, req);
            if (run.lr_hold_cohort !== true) return undefined;
            const now = (await db.query('SELECT clock_timestamp() AS now')).rows[0].now;
            observation = {
              operationId: op.operationId, previousOperationId: op.dependency, generation: op.generation,
              startedAtMs: Date.parse(op.payload.startedAt), capturedAtMs: Date.parse(op.occurredAt),
              serverAtMs: new Date(now).getTime(), automatic: false, delivery: 'paper',
              definitionVersion: Number(session.definition_version), policyVersion: policy,
              answeredCount: Object.values(op.payload.answers).filter(Boolean).length
            };
            if (await readPrevious(db, session)) return undefined;
            const test = await definitionFor(db, session);
            validateAnswerKeys(op, test);
            const { ownerId, attemptToken, ...retained } = op;
            return retainMiniPaperSubmission(db, { session, now }, op, retained, payloadHash, { hours, limit });
          });
        } catch (error) {
          if (canSubmitWithoutHold(error)) {
            report('offline_hold_unconfirmed', undefined, error.code);
          } else {
            if (error.status) throw error;
            report('offline_hold_unconfirmed', undefined, 'HOLD_TRANSACTION_UNCONFIRMED');
            throw problem('OFFLINE_HOLD_UNAVAILABLE', 'Chưa lưu được bản đối soát. Hãy giữ bản trên thiết bị.', 503);
          }
        }
      }
      if (held) observation.heldAtMs = held.heldAt;
      result = await record();
    } catch (error) {
      if (error.code === 'OFFLINE_HOLD_UNAVAILABLE') throw error;
      if (!error.status) {
        report('offline_submission_unconfirmed', undefined, 'SUBMISSION_TRANSACTION_UNCONFIRMED');
        if (held) throw problem('OFFLINE_SUBMISSION_UNAVAILABLE', 'Chưa xác nhận được bài nộp. Hãy giữ bản trên thiết bị.', 503);
        throw error;
      }
      report('offline_submission_rejected', false, error.code);
      if (held && error.code !== 'OFFLINE_SCOPE') error.held = held;
      throw error;
    }
    if (observation) observation.receiptId = result.receipt.receiptId;
    report(result.replayed ? 'offline_submission_replayed' : 'submission_completed', true,
      result.replayed ? 'RECEIPT_REPLAYED' : 'RECEIPT_COMMITTED');
    res.json({ ok: true, persisted: true, receipt: result.receipt });
  }));
}
