import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  bindSkillGrant, issueSkillGrant, readActiveSkillGrant, readBoundSkillGrant, resolveBoundSkillTarget,
  resolveSkillTargetForOpen, revokeSkillGrant
} from './term1-skill-grant.mjs';

const SLUG = 'term-test-1-k56';
const PATH = '/' + SLUG + '/skill-fallback';
const identity = z.object({ classCode: z.string().trim().toUpperCase().regex(/^[A-Z0-9._-]{2,32}$/),
  studentRef: z.string().uuid(), section: z.literal('reading') });
const issueInput = identity.extend({ oldDeviceStopped: z.boolean().default(false),
  examMode: z.enum(['lis_first', 'read_first']).optional() }).strict();
const revokeInput = identity.extend({ grantId: z.string().uuid() }).strict();
const openInput = identity.extend({ ownerId: z.string().uuid(), activationCode: z.string().max(30).optional() }).strict();
const identifyInput = openInput.omit({ studentRef: true });
const resultInput = z.object({ ownerId: z.string().uuid(), grantId: z.string().uuid() }).strict();

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

export function registerTerm1SkillRoutes(router, {
  authenticate, readTeacherScope, transaction, prepare, load, findStudent, assets, policy,
  limiter, readLimiter, record, allowNew = () => process.env.TERM1_SKILL_FALLBACK_ENABLED === 'true'
}) {
  const mutation = async (event, work) => {
    const { response, attemptId, grantId } = await transaction(work);
    if (attemptId) {
      try {
        const pending = record?.(event, SLUG, attemptId, { section: 'reading', operationId: grantId, phase: 'after_commit' });
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

  const teacherAttempt = async (client, input, req, create) => {
    await readTeacherScope(client, { class: input.classCode, test: SLUG, student: input.studentRef, mode: 'index' }, req);
    const attempt = await prepare(SLUG, { classCode: input.classCode, studentRef: input.studentRef,
      mode: input.examMode ?? 'lis_first', attemptMode: 'cbt' }, create, client);
    if (!attempt) return null;
    assertCbt(attempt);
    if (!/^[1-9]\d*$/.test(String(attempt.student_id))) denied();
    return attempt;
  };

  router.post(PATH + '/manage', readLimiter, authenticate, route(identity.strict(), (input, req) =>
    transaction(async client => {
      const attempt = await teacherAttempt(client, input, req, false);
      const activeGrant = attempt ? await readActiveSkillGrant(client, scopeOf(attempt, input)) : null;
      return { ok: true, issueEnabled: allowNew(), attemptExists: Boolean(attempt),
        examMode: attempt?.exam_mode ?? null, started: Boolean(attempt?.reading_started_at),
        submitted: Boolean(attempt?.reading_submitted_at), activeGrant };
    })));

  router.post(PATH + '/issue', limiter, authenticate, route(issueInput, (input, req) =>
    mutation('term1_skill_grant_issued', async client => {
      if (!allowNew()) fail(503, 'TERM1_SKILL_ISSUE_DISABLED', 'Chưa mở cấp link dự phòng.');
      const attempt = await teacherAttempt(client, input, req, Boolean(input.examMode));
      if (!attempt) fail(409, 'TERM1_SKILL_MODE_REQUIRED', 'Chọn thứ tự của bài chính trước khi cấp link cho lượt mới.');
      if (attempt.reading_submitted_at) fail(409, 'OFFLINE_SECTION_LOCKED', 'Reading đã được nộp.');
      if (attempt.reading_started_at && !input.oldDeviceStopped)
        fail(409, 'TERM1_SKILL_STOP_REQUIRED', 'Xác nhận đã dừng làm Reading ở thiết bị cũ trước khi cấp link.');
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
        response: { ok: true, grantId: grant.id, revokedAt: grant.revoked_at } };
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
      const attempt = await load(client, SLUG, target.attempt_id, false, true);
      assertCbt(attempt);
      const student = await findStudent(client, input);
      if (!student || String(student.class_id) !== attempt.class_id || String(student.student_id) !== attempt.student_id)
        denied();
      if (!target.owner_id && attempt.reading_started_at && !attempt.reading_submitted_at
          && Date.parse(attempt.reading_started_at) >= Date.parse(target.issued_at))
        fail(409, 'TERM1_SKILL_STATE_CHANGED', 'Reading đã bắt đầu sau khi cấp link. Nhờ giảng viên đối soát và cấp lại.');
      const grant = await bindSkillGrant(client, scopeOf(attempt, input), token, input.ownerId, input.activationCode);
      const trace = { attemptId: target.owner_id ? null : attempt.attempt_token, grantId: grant.id };
      if (attempt.reading_submitted_at) return { ...trace, response: { ok: true, grantId: grant.id, section: 'reading', submitted: true } };
      const content = attempt.mini_definition_snapshot?.content ?? await assets.getContent(SLUG);
      const timing = attempt.mini_definition_snapshot?.timing ?? assets.getTiming(SLUG);
      if (!content?.reading || !Number.isSafeInteger(timing?.readingDurationMinutes))
        fail(503, 'TERM1_SKILL_CONTENT_UNAVAILABLE', 'Chưa tải được đề Reading đã ghim.');
      let run = (await client.query('SELECT * FROM assessment.term1_offline_run WHERE attempt_id=$1 FOR UPDATE',
        [attempt.attempt_token])).rows[0];
      if (run && (run.session_id !== attempt.exam_session_token || Number(run.generation) !== Number(attempt.generation)
          || run.policy !== policy)) denied();
      const startedAt = attempt.reading_started_at && new Date(attempt.reading_started_at).toISOString();
      const deadlineAt = attempt.reading_deadline_at && new Date(attempt.reading_deadline_at).toISOString();
      if (startedAt && (!deadlineAt || Date.parse(deadlineAt) !== Date.parse(startedAt) + timing.readingDurationMinutes * 60000))
        fail(409, 'TERM1_SKILL_TIME_REVIEW', 'Giờ Reading đã lưu cần được đối soát trước khi tiếp tục.');
      const revision = Number(attempt.reading_draft_revision) || 0;
      const state = run?.state ?? {};
      if (startedAt && (!state.reading || state.reading.revision < revision)) {
        state.reading = { startedAt, deadlineAt, revision, contentHash: null, sealed: false, operationId: null };
      }
      if (!run) {
        run = (await client.query(`
          INSERT INTO assessment.term1_offline_run
            (attempt_id, session_id, generation, owner_id, policy, prepared_at, state, main_owner_pending)
          VALUES ($1, $2, $3, $4, $5, least(now(), coalesce($6::timestamptz, now())), $7::jsonb, true)
          RETURNING *
        `, [attempt.attempt_token, attempt.exam_session_token, attempt.generation, randomUUID(), policy,
          startedAt ?? null, JSON.stringify(state)])).rows[0];
      } else if (startedAt && (run.state?.reading?.revision ?? -1) < revision) {
        await client.query('UPDATE assessment.term1_offline_run SET state=$2::jsonb WHERE attempt_id=$1',
          [attempt.attempt_token, JSON.stringify(state)]);
      }
      return { ...trace, response: { ok: true, grantId: grant.id, section: 'reading', submitted: false, generation: Number(attempt.generation),
        content: { reading: content.reading }, durationMinutes: timing.readingDurationMinutes, serverNow: attempt.server_now,
        preparedAt: run.prepared_at, startedAt, deadlineAt, draft: attempt.reading_draft ?? {}, revision } };
    })));

  router.post(PATH + '/result', readLimiter, route(resultInput, (input, req) =>
    transaction(async client => {
      const token = req.get('x-term1-skill-grant');
      const target = await resolveBoundSkillTarget(client, token, input.ownerId, input.grantId);
      const attempt = await load(client, SLUG, target.attempt_id, false, true);
      assertCbt(attempt);
      await readBoundSkillGrant(client, attempt, token, input.ownerId, 'reading');
      return { ok: true, section: 'reading', submitted: Boolean(attempt.reading_submitted_at),
        result: attempt.reading_submitted_at ? attempt.reading_result : null };
    })));
}
