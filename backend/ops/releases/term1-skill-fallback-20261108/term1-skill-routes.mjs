import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  bindSkillGrant, issueSkillGrant, readActiveSkillGrant, readBoundSkillGrant, resolveBoundSkillTarget,
  resolveSkillTargetForOpen, revokeSkillGrant
} from './term1-skill-grant.mjs';

const SLUG = 'term-test-1-k56';
const PATH = '/' + SLUG + '/skill-fallback';
const identity = z.object({ classCode: z.string().trim().toUpperCase().regex(/^[A-Z0-9._-]{2,32}$/),
  studentRef: z.string().uuid(), section: z.enum(['reading', 'listening', 'writing']) });
const issueInput = identity.extend({ oldDeviceStopped: z.boolean().default(false),
  examMode: z.enum(['lis_first', 'read_first']).optional() }).strict();
const revokeInput = identity.extend({ grantId: z.string().uuid() }).strict();
const identifyInput = identity.omit({ studentRef: true }).extend({ ownerId: z.string().uuid(), activationCode: z.string().max(30).optional() }).strict();
const openInput = identifyInput.extend({ studentRef: z.string().uuid(), audioTransport: z.literal('r2-direct-v1').optional() });
const resultInput = z.object({ ownerId: z.string().uuid(), grantId: z.string().uuid(), section: identity.shape.section.default('reading') }).strict();
const labels = { reading: 'Reading', listening: 'Listening', writing: 'Writing' };
const issueFlags = { reading: 'TERM1_SKILL_FALLBACK_ENABLED', listening: 'TERM1_SKILL_LISTENING_ENABLED', writing: 'TERM1_SKILL_WRITING_ENABLED' };

function fail(status, code, message) {
  throw Object.assign(new Error(message), { status, code });
}
function denied() {
  fail(403, 'TERM1_SKILL_GRANT_DENIED', 'Link hoặc thông tin xác nhận không khớp lượt thi.');
}
function scopeOf(attempt, input) {
  return { attemptId: attempt.attempt_token, sessionId: attempt.exam_session_token,
    generation: Number(attempt.generation), classId: attempt.class_id,
    studentRef: input.studentRef, section: input.section };
}
function assertCbt(attempt) {
  if (!attempt || attempt.test_slug !== SLUG || attempt.attempt_mode !== 'cbt'
      || Number(attempt.generation) !== Number(attempt.session_generation ?? attempt.generation)) denied();
}

function publicWritingGrading(grading) {
  if (!grading) return null;
  const { status, ready, availableAt, readyAt, task2Score, writingScore, taskStates } = grading;
  return { status, ready, availableAt, readyAt, taskStates: taskStates?.task2 ? { task2: taskStates.task2 } : {},
    ...(ready ? { task2Score, writingScore, tasks: (grading.tasks ?? []).filter(task => task.taskNumber === 2)
      .map(({ taskNumber, taskScore, wordCount, completedAt, report, criteria, gradingMethod, reasonCode }) =>
        ({ taskNumber, taskScore, wordCount, completedAt, report, criteria, gradingMethod, reasonCode })) } : { tasks: [] }) };
}

export function registerTerm1SkillRoutes(router, {
  authenticate, readTeacherScope, transaction, prepare, load, findStudent, assets, policy,
  limiter, readLimiter, record, issueAudio, readWriting, allowNew = section => process.env[issueFlags[section]] === 'true'
}) {
  const mutation = async (event, work) => {
    const { response, attemptId, grantId } = await transaction(work);
    if (attemptId) {
      try {
        const pending = record?.(event, SLUG, attemptId, { section: response.section, operationId: grantId, phase: 'after_commit' });
        if (pending?.catch) void pending.catch(() => {});
      } catch { /* Một sự kiện log lỗi không được làm hỏng thao tác đã commit. */ }
    }
    return response;
  };
  const route = (schema, handler) => async (req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: 'TERM1_SKILL_INVALID' });
    try {
      res.json(await handler(parsed.data, req));
    } catch (error) {
      if (!error.status && !error.httpStatus) return next(error);
      res.status(error.status ?? error.httpStatus).json({ ok: false, error: error.code, message: error.message });
    }
  };

  async function lockListeningSession(client, attempt, section) {
    if (section !== 'listening') return attempt;
    await client.query('SELECT id FROM assessment.term_test_exam_session WHERE id=$1 FOR UPDATE', [attempt.exam_session_token]);
    return load(client, SLUG, attempt.attempt_token, false, true);
  }

  const teacherAttempt = async (client, input, req, create) => {
    await readTeacherScope(client, { class: input.classCode, test: SLUG, student: input.studentRef, mode: 'index' }, req);
    const attempt = await prepare(SLUG, { classCode: input.classCode, studentRef: input.studentRef,
      mode: input.examMode ?? 'lis_first', attemptMode: 'cbt' }, create, client);
    if (!attempt) return null;
    assertCbt(attempt);
    if (!/^[1-9]\d*$/.test(String(attempt.student_id))) denied();
    return lockListeningSession(client, attempt, input.section);
  };

  router.post(PATH + '/manage', readLimiter, authenticate, route(identity.strict(), (input, req) =>
    transaction(async client => {
      const attempt = await teacherAttempt(client, input, req, false);
      const activeGrant = attempt ? await readActiveSkillGrant(client, scopeOf(attempt, input)) : null;
      return { ok: true, issueEnabled: allowNew(input.section), attemptExists: Boolean(attempt),
        examMode: attempt?.exam_mode ?? null, started: Boolean(attempt?.[input.section + '_started_at']),
        submitted: Boolean(attempt?.[input.section + '_submitted_at']), activeGrant };
    })));

  router.post(PATH + '/issue', limiter, authenticate, route(issueInput, (input, req) =>
    mutation('term1_skill_grant_issued', async client => {
      if (!allowNew(input.section)) fail(503, 'TERM1_SKILL_ISSUE_DISABLED', 'Chưa mở cấp link dự phòng.');
      const attempt = await teacherAttempt(client, input, req, Boolean(input.examMode));
      if (!attempt) fail(409, 'TERM1_SKILL_MODE_REQUIRED', 'Chọn thứ tự của bài chính trước khi cấp link cho lượt mới.');
      if (attempt[input.section + '_submitted_at']) fail(409, 'OFFLINE_SECTION_LOCKED', labels[input.section] + ' đã được nộp.');
      if (attempt[input.section + '_started_at'] && !input.oldDeviceStopped)
        fail(409, 'TERM1_SKILL_STOP_REQUIRED', 'Xác nhận đã dừng làm ' + labels[input.section] + ' ở thiết bị cũ trước khi cấp link.');
      if (input.section === 'listening' && attempt.listening_started_at && !(Number(attempt.listening_audio_checkpoint_seconds) > 0))
        fail(409, 'TERM1_SKILL_AUDIO_CHECKPOINT_REQUIRED', 'Chưa có mốc nghe đã xác nhận để chuyển thiết bị. Giữ bài trên thiết bị đang làm.');
      const { grant, token, activationCode } = await issueSkillGrant(client, scopeOf(attempt, input));
      return { attemptId: attempt.attempt_token, grantId: grant.id, response: {
        ok: true, grantId: grant.id, section: grant.section, expiresAt: grant.expires_at, token, activationCode } };
    })));

  router.post(PATH + '/revoke', limiter, authenticate, route(revokeInput, (input, req) =>
    mutation('term1_skill_grant_revoked', async client => {
      const attempt = await teacherAttempt(client, input, req, false);
      if (!attempt) denied();
      const grant = await revokeSkillGrant(client, scopeOf(attempt, input), input.grantId);
      return { attemptId: attempt.attempt_token, grantId: grant.id,
        response: { ok: true, section: input.section, grantId: grant.id, revokedAt: grant.revoked_at } };
    })));

  router.post(PATH + '/identify', limiter, route(identifyInput, (input, req) =>
    transaction(async client => {
      const target = await resolveSkillTargetForOpen(client, req.get('x-term1-skill-grant'), input.ownerId, input.activationCode);
      if (target.section !== input.section) denied();
      const attempt = await load(client, SLUG, target.attempt_id, false, true);
      assertCbt(attempt);
      const student = await findStudent(client, { ...input, studentRef: target.student_ref });
      if (!student || String(student.class_id) !== attempt.class_id || String(student.student_id) !== attempt.student_id) denied();
      return { ok: true, studentRef: target.student_ref, studentName: attempt.student_name, classCode: input.classCode };
    })));

  router.post(PATH + '/open', limiter, route(openInput, (input, req) =>
    mutation('term1_skill_grant_bound', async client => {
      const token = req.get('x-term1-skill-grant');
      const target = await resolveSkillTargetForOpen(client, token, input.ownerId, input.activationCode);
      const section = input.section;
      if (target.section !== section) denied();
      const attempt = await lockListeningSession(client, await load(client, SLUG, target.attempt_id, false, true), section);
      assertCbt(attempt);
      const student = await findStudent(client, input);
      if (!student || String(student.class_id) !== attempt.class_id || String(student.student_id) !== attempt.student_id)
        denied();
      if (!target.owner_id && attempt[section + '_started_at'] && !attempt[section + '_submitted_at']
          && new Date(attempt[section + '_started_at']).getTime() >= new Date(target.issued_at).getTime())
        fail(409, 'TERM1_SKILL_STATE_CHANGED', labels[section] + ' đã bắt đầu sau khi cấp link. Nhờ giảng viên đối soát và cấp lại.');
      const grant = await bindSkillGrant(client, scopeOf(attempt, input), token, input.ownerId, input.activationCode);
      const trace = { attemptId: target.owner_id ? null : attempt.attempt_token, grantId: grant.id };
      const submitted = Boolean(attempt[section + '_submitted_at']);
      if (submitted && section !== 'writing') return { ...trace, response: { ok: true, grantId: grant.id, section, submitted } };
      const content = attempt.mini_definition_snapshot?.content ?? await assets.getContent(SLUG);
      const timing = attempt.mini_definition_snapshot?.timing ?? assets.getTiming(SLUG);
      const isListening = section === 'listening';
      const isWriting = section === 'writing';
      const duration = isListening ? timing?.listeningDurationSeconds : timing?.[section + 'DurationMinutes'];
      if (!content?.[section] || !Number.isSafeInteger(duration) || duration <= 0
          || (isListening && (!Number.isSafeInteger(timing.listeningReviewSeconds) || timing.listeningReviewSeconds < 0))
          || (isWriting && !content.writing.tasks?.some(task => task.id === 'task2')))
        fail(503, 'TERM1_SKILL_CONTENT_UNAVAILABLE', 'Chưa tải được đề ' + labels[section] + ' đã ghim.');
      const scopedContent = { [section]: isWriting ? { totalMinutes: duration,
        tasks: content.writing.tasks.filter(task => task.id === 'task2') } : content[section] };
      const draft = isWriting ? { task2: String(attempt.writing_task_2 ?? '') } : attempt[section + '_draft'] ?? {};
      if (submitted) return { ...trace, response: { ok: true, grantId: grant.id, section, submitted,
        generation: Number(attempt.generation), content: scopedContent, durationMinutes: duration, draft, serverNow: attempt.server_now } };
      let run = (await client.query('SELECT * FROM assessment.term1_offline_run WHERE attempt_id=$1 FOR UPDATE',
        [attempt.attempt_token])).rows[0];
      if (run && (run.session_id !== attempt.exam_session_token || Number(run.generation) !== Number(attempt.generation)
          || run.policy !== policy)) denied();
      const started = attempt[section + '_started_at'], deadline = attempt[section + '_deadline_at'];
      const startedAt = started ? new Date(started).toISOString() : null;
      const deadlineAt = !isListening && deadline ? new Date(deadline).toISOString() : null;
      if (!isListening && startedAt && (!deadlineAt || Date.parse(deadlineAt) !== Date.parse(startedAt) + duration * 60000))
        fail(409, 'TERM1_SKILL_TIME_REVIEW', 'Giờ ' + labels[section] + ' đã lưu cần được đối soát trước khi tiếp tục.');
      const position = isListening ? Number(attempt.listening_audio_checkpoint_seconds) || 0 : 0;
      if (isListening && startedAt && !target.owner_id && !(position > 0 && position < duration - 2))
        fail(409, 'TERM1_SKILL_AUDIO_CHECKPOINT_REQUIRED', 'Chưa có mốc nghe có thể chuyển an toàn. Giữ bài đã lưu và báo giảng viên đối soát.');
      const revision = Number(attempt[section + '_draft_revision']) || 0;
      const state = run?.state ?? {};
      const needsSeed = startedAt && (!state[section] || state[section].revision < revision);
      if (needsSeed) {
        state[section] = { startedAt, deadlineAt, revision, contentHash: null, sealed: false, operationId: null };
      }
      if (!run) {
        run = (await client.query(`
          INSERT INTO assessment.term1_offline_run
            (attempt_id, session_id, generation, owner_id, policy, prepared_at, state, main_owner_pending)
          VALUES ($1, $2, $3, $4, $5, least(now(), coalesce($6::timestamptz, now())), $7::jsonb, true)
          RETURNING *
        `, [attempt.attempt_token, attempt.exam_session_token, attempt.generation, randomUUID(), policy,
          startedAt ?? null, JSON.stringify(state)])).rows[0];
      } else if (needsSeed) {
        await client.query('UPDATE assessment.term1_offline_run SET state=$2::jsonb WHERE attempt_id=$1',
          [attempt.attempt_token, JSON.stringify(state)]);
      }
      const audioDownload = isListening ? issueAudio?.(attempt, input.audioTransport) : undefined;
      return { ...trace, response: { ok: true, grantId: grant.id, section, submitted: false, generation: Number(attempt.generation),
        content: scopedContent, ...(isListening ? { durationSeconds: duration, reviewSeconds: timing.listeningReviewSeconds, position, audioDownload } : { durationMinutes: duration }),
        serverNow: attempt.server_now, preparedAt: run.prepared_at, startedAt, deadlineAt, draft, revision } };
    })));

  router.post(PATH + '/result', readLimiter, route(resultInput, (input, req) =>
    transaction(async client => {
      const token = req.get('x-term1-skill-grant');
      const target = await resolveBoundSkillTarget(client, token, input.ownerId, input.grantId);
      const attempt = await load(client, SLUG, target.attempt_id, false, true);
      assertCbt(attempt);
      await readBoundSkillGrant(client, attempt, token, input.ownerId, input.section);
      const submitted = Boolean(attempt[input.section + '_submitted_at']);
      if (input.section === 'writing') return { ok: true, section: 'writing', submitted,
        writing: submitted ? { submitted: true, task2: String(attempt.writing_task_2 ?? ''),
          grading: publicWritingGrading(await readWriting?.(client, attempt)) } : null };
      return { ok: true, section: input.section, submitted, result: submitted ? attempt[input.section + '_result'] : null };
    })));
}
