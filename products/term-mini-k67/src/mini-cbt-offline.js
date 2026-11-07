import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { assertAudioOwner } from './audio-owner.js';
import { audioTransaction } from './audio-incidents.js';
import { insertProtectedListeningAttemptSql } from './sql.js';
import { buildCombinedResult, gradeSection, parseStoredTest } from './term-tests.js';

const slug = 'mini-test-lesson-5';
const prefix = `/api/term-tests/${slug}/cbt-offline`;
const version = 'mini-k67-cbt-seal-v1';
const recoveryMs = 72 * 60 * 60 * 1000;
const clockToleranceMs = 3_000;
const scope = z.object({ examSessionToken: z.uuid(), attemptToken: z.uuid().optional(),
  section: z.enum(['listening', 'reading']), generation: z.number().int().nonnegative(),
  ownerId: z.uuid().optional(), ownerProof: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  ownerEpoch: z.number().int().nonnegative().optional() });
const identity = scope.extend({ classCode: z.string().regex(/^[A-Z0-9._-]{2,32}$/), studentRef: z.uuid() });
const write = scope.extend({ operationId: z.uuid(), capturedAt: z.iso.datetime(), revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  automatic: z.boolean(), answers: z.record(z.string().regex(/^\d{1,2}$/), z.string().max(120)) });
const read = scope.extend({ operationId: z.uuid() });

function fail(code, message, status = 409) { return Object.assign(new Error(message), { code, status }); }
function parsed(schema, input) {
  const checked = schema.safeParse(input);
  if (!checked.success) throw fail('OFFLINE_INVALID', 'Yêu cầu đồng bộ chưa hợp lệ.', 400);
  return checked.data;
}
const asTime = value => value ? new Date(value).getTime() : NaN;
const asISO = value => new Date(value).toISOString();
const clean = ({ ownerProof, ownerId, ownerEpoch, ...data }) => data;
const answerOrder = answers => Object.fromEntries(Object.entries(answers).sort(([a], [b]) => a.localeCompare(b)));
const nonBlank = answers => answerOrder(Object.fromEntries(Object.entries(answers).filter(([, value]) => value.trim())));
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function locked(db, body, { statusOnly = false } = {}) {
  const owner = (await db.query(`SELECT erp_course_class_id,erp_student_contact_id FROM assessment.term_test_exam_session
    WHERE id=$1 AND test_slug=$2`, [body.examSessionToken, slug])).rows[0];
  if (!owner) throw fail('OFFLINE_SCOPE', 'Lượt thi đã thay đổi. Bản trên máy vẫn được giữ.', 403);
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${slug}:${owner.erp_course_class_id}:${owner.erp_student_contact_id}`]);
  const session = (await db.query(`SELECT * FROM assessment.term_test_exam_session
    WHERE id=$1 AND test_slug=$2 FOR UPDATE`, [body.examSessionToken, slug])).rows[0];
  if (!session || session.superseded_at || !['legacy', 'cbt'].includes(session.attempt_mode)
      || Number(session.generation) !== body.generation) throw fail('OFFLINE_SCOPE', 'Lượt thi đã thay đổi. Bản trên máy vẫn được giữ.', 403);
  const attempt = session.attempt_id ? (await db.query(`SELECT * FROM assessment.term_test_attempt WHERE id=$1 AND exam_session_id=$2 FOR UPDATE`,
    [session.attempt_id, session.id])).rows[0] : null;
  if ((session.attempt_id && !attempt) || (body.attemptToken && body.attemptToken !== attempt?.id)
      || (attempt && (attempt.superseded_at || Number(attempt.generation) !== body.generation))) {
    throw fail('OFFLINE_SCOPE', 'Không khớp lượt thi đang lưu.', 403);
  }
  const listening = body.section === 'listening';
  session.server_now = (await db.query('SELECT clock_timestamp() AS server_now')).rows[0].server_now;
  const record = listening ? session : attempt;
  const start = asTime(record?.[`${body.section}_started_at`]);
  const deadline = asTime(record?.[`${body.section}_deadline_at`]);
  const sealed = Boolean(record?.[`${body.section}_submitted_at`]);
  if (listening && !statusOnly) assertAudioOwner(session, body);
  if (!Number.isFinite(start) || !Number.isFinite(deadline)
      || (listening && session.exam_mode === 'read_first' && !attempt?.reading_submitted_at)
      || (!listening && session.exam_mode !== 'read_first' && !session.listening_submitted_at)) {
    throw fail('OFFLINE_NOT_STARTED', 'Hãy bắt đầu phần này khi có kết nối.');
  }
  return { session, attempt, record, start, deadline, sealed, listening };
}

function grantFor(secret, body, state) {
  const owner = state.listening ? [state.session.audio_owner_id, state.session.audio_owner_proof_hash].join(':') : state.attempt.id;
  return createHmac('sha256', secret).update([version, state.session.id, body.generation, body.section,
    state.session.erp_student_contact_id, state.session.erp_course_class_id, state.session.definition_version,
    state.start, owner].join(':')).digest('hex');
}

function permitted(req, secret, body, state) {
  const permit = req.get('x-term2-permit');
  if (!permit || !/^[0-9a-f]{64}$/.test(permit) || !timingSafeEqual(Buffer.from(permit, 'hex'), Buffer.from(grantFor(secret, body, state), 'hex'))) {
    throw fail('OFFLINE_SCOPE', 'Quyền đồng bộ không khớp lượt thi.', 403);
  }
  if (asTime(state.session.server_now) > state.start + recoveryMs) throw fail('OFFLINE_REVIEW_REQUIRED', 'Đã qua thời hạn đồng bộ. Hãy tải bài để giảng viên đối soát.');
}

async function storedSeal(db, body) {
  return (await db.query(`SELECT operation_id,payload_hash,receipt FROM assessment.mini_k67_cbt_offline_seal
    WHERE session_id=$1 AND section=$2`, [body.examSessionToken, body.section])).rows[0];
}

async function seal(db, state, body) {
  const { session, attempt, record, start, deadline, listening } = state;
  const observed = Date.parse(body.capturedAt);
  const serverNow = asTime(session.server_now);
  if (observed < start - clockToleranceMs || observed > Math.min(serverNow + clockToleranceMs, deadline + clockToleranceMs)
      || (body.automatic && (observed < deadline || serverNow < deadline))) {
    throw fail('OFFLINE_REVIEW_REQUIRED', 'Mốc chốt trên máy chưa khớp giờ thi. Bài vẫn được giữ để đối soát.');
  }
  if (listening && (session.listening_audio_incident_id || (body.automatic && !session.listening_eof_at))) {
    throw fail('AUDIO_END_NOT_CONFIRMED', 'Chưa xác nhận đã phát hết audio. Bài vẫn được giữ.');
  }
  const definition = (await db.query(`SELECT slug AS test_slug,title AS test_title,version AS definition_version,
    listening_band_adjustment,listening_definition,reading_definition FROM assessment.test_definition
    WHERE slug=$1 AND version=$2`, [slug, session.definition_version])).rows[0];
  if (!definition) throw fail('OFFLINE_DEFINITION', 'Chưa tìm thấy đúng phiên bản đề.');
  const test = parseStoredTest(definition);
  const allowed = new Set(test[body.section + '_definition'].questions.map(question => String(question.number)));
  if (Object.keys(body.answers).some(key => !allowed.has(key))) throw fail('OFFLINE_INVALID', 'Có đáp án không thuộc phiên bản đề.', 400);
  const currentRevision = Number(record[`${body.section}_draft_revision`]) || 0;
  const currentDraft = record[`${body.section}_draft`] || {};
  if (body.revision < currentRevision || (body.revision === currentRevision
      && hash(nonBlank(body.answers)) !== hash(nonBlank(currentDraft)))) {
    throw fail('OFFLINE_REVISION', 'Bản trên máy chủ có phiên bản khác. Giữ bài để đối soát.');
  }
  const grade = gradeSection(test[body.section + '_definition'], body.answers, listening ? test.listening_band_adjustment : 0);
  const answers = JSON.stringify(body.answers);
  const table = listening ? 'term_test_exam_session' : 'term_test_attempt';
  await db.query(`UPDATE assessment.${table} SET ${body.section}_draft=$2::jsonb,${body.section}_draft_revision=$3,
    ${body.section}_draft_updated_at=now(),updated_at=now() WHERE id=$1`, [record.id, answers, body.revision]);
  if (!attempt) {
    const inserted = (await db.query(insertProtectedListeningAttemptSql,
      [body.operationId, session.id, slug, answers, JSON.stringify(grade)])).rows[0];
    if (!inserted) throw fail('OFFLINE_SCOPE', 'Không thể gắn bài vào đúng lượt.');
    if (Number(session.generation) > 0) await db.query('UPDATE assessment.term_test_attempt SET generation=$2 WHERE id=$1', [inserted.attempt_token, session.generation]);
    return { attemptToken: inserted.attempt_token, completed: false, nextSection: 'reading' };
  }
  const prior = attempt[listening ? 'reading_result' : 'listening_result'];
  const combined = prior ? buildCombinedResult(test, listening ? grade : prior, listening ? prior : grade) : null;
  await db.query(`UPDATE assessment.term_test_attempt SET ${body.section}_answers=$2::jsonb,${body.section}_result=$3::jsonb,
    ${body.section}_submitted_at=now(),combined_result=$4::jsonb,
    completed_at=CASE WHEN $4::jsonb IS NOT NULL THEN now() ELSE NULL END,updated_at=now() WHERE id=$1`,
  [attempt.id, answers, JSON.stringify(grade), combined ? JSON.stringify(combined) : null]);
  if (listening) await db.query('UPDATE assessment.term_test_exam_session SET listening_submitted_at=now(),updated_at=now() WHERE id=$1', [session.id]);
  return { attemptToken: attempt.id, completed: Boolean(combined), nextSection: combined ? 'result' : 'listening' };
}

export function mountMiniCbtOffline(app, { pool, config, requireContext, readStudent, readLimiter, writeLimiter }) {
  if (!['on', 'drain'].includes(config.miniCbtOfflineMode)) return;
  const secret = config.termTestSessionSecret;
  const route = handler => async (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    try {
      if (typeof secret !== 'string' || secret.length < 32) throw fail('OFFLINE_UNAVAILABLE', 'Chưa cấp được quyền đồng bộ.', 503);
      res.json(await handler(req));
    } catch (error) {
      if (!error.status) return next(error);
      res.status(error.status).json({ ok: false, error: error.code, message: error.message });
    }
  };
  app.post(prefix + '/grant', readLimiter, requireContext, route(async req => {
    const body = parsed(identity, req.body);
    if (config.miniCbtOfflineMode !== 'on') throw fail('OFFLINE_NEW_DISABLED', 'Tạm dừng cấp quyền mới.', 503);
    const learner = (await readStudent(req, body.classCode, slug, body.studentRef)).rows[0];
    if (!learner) throw fail('OFFLINE_SCOPE', 'Không khớp lớp và học viên.', 403);
    return audioTransaction(pool, async db => {
      const state = await locked(db, body);
      if (String(learner.class_id) !== String(state.session.erp_course_class_id)
          || String(learner.student_id) !== String(state.session.erp_student_contact_id) || state.sealed) {
        throw fail('OFFLINE_SCOPE', 'Không khớp lượt thi đang làm.', 403);
      }
      if (asTime(state.session.server_now) > state.deadline) throw fail('OFFLINE_NEW_DISABLED', 'Phần thi đã hết giờ cấp quyền mới.');
      return { ok: true, version, section: body.section, examSessionToken: state.session.id, generation: body.generation,
        startedAt: asISO(state.start), deadlineAt: asISO(state.deadline), serverNow: asISO(state.session.server_now), permit: grantFor(secret, body, state) };
    });
  }));
  app.post(prefix + '/status', readLimiter, route(async req => {
    const body = parsed(read, req.body);
    return audioTransaction(pool, async db => {
      permitted(req, secret, body, await locked(db, body, { statusOnly: true }));
      const saved = await storedSeal(db, body);
      if (saved && saved.operation_id !== body.operationId) throw fail('OFFLINE_ALREADY_SEALED', 'Phần thi đã được nộp bằng mã khác.');
      return { ok: true, persisted: Boolean(saved), receipt: saved?.receipt || null };
    });
  }));
  app.post(prefix + '/seal', writeLimiter, route(async req => {
    const body = parsed(write, req.body);
    const payloadHash = hash({ ...clean(body), answers: answerOrder(body.answers) });
    return audioTransaction(pool, async db => {
      const state = await locked(db, body);
      permitted(req, secret, body, state);
      const saved = await storedSeal(db, body);
      if (saved) {
        if (saved.operation_id !== body.operationId || saved.payload_hash !== payloadHash) throw fail('OFFLINE_CONFLICT', 'Phần thi đã nhận nội dung khác.');
        return { ok: true, persisted: true, receipt: saved.receipt };
      }
      if (state.sealed) throw fail('OFFLINE_ALREADY_SEALED', 'Phần thi đã được nộp trước khi đồng bộ.');
      const result = await seal(db, state, body);
      const receipt = { version, payloadHash, examSessionToken: body.examSessionToken, operationId: body.operationId,
        section: body.section, revision: body.revision, generation: body.generation, studentName: state.session.student_name_snapshot,
        examMode: state.session.exam_mode, listeningSubmitted: state.listening || Boolean(state.session.listening_submitted_at),
        readingSubmitted: !state.listening || Boolean(state.attempt?.reading_submitted_at), ...result };
      await db.query(`INSERT INTO assessment.mini_k67_cbt_offline_seal (session_id,section,operation_id,payload_hash,receipt)
        VALUES ($1,$2,$3,$4,$5::jsonb)`, [body.examSessionToken, body.section, body.operationId, payloadHash, JSON.stringify(receipt)]);
      return { ok: true, persisted: true, receipt };
    });
  }));
}
