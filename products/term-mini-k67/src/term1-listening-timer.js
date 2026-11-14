import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { audioTransaction } from './audio-incidents.js';
import { AudioRecoveryError } from './audio-recovery.js';
import { findLatestTermTestAttemptForStudentSql, findTermTestListeningSubmissionSql,
  insertProtectedListeningAttemptSql, insertTermTestExamSessionSql, saveTermTestListeningDraftSql, teacherCanReadClass } from './sql.js';
import { gradeSection, parseStoredTest } from './term-tests.js';

const slug = 'term-test-1';
const identity = z.object({ classCode: z.string().regex(/^[A-Z0-9._-]{2,32}$/), studentRef: z.uuid(),
  deviceProof: z.string().regex(/^[a-f0-9]{64}$/) });
const scope = identity.extend({ examSessionToken: z.uuid(), generation: z.number().int().nonnegative() });
const draft = scope.extend({ answers: z.record(z.string().regex(/^(?:[1-9]|[1-3][0-9]|40)$/), z.string().max(120)),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) });
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (code, message, status = 409) => Object.assign(new AudioRecoveryError(code, message), { status });
const unavailable = () => fail('TIMER_ROOM_UNAVAILABLE', 'Lớp chưa có ca Listening dùng đồng hồ chung.', 404);

export function mountTerm1TimerTeacher(app, { pool, assets, authenticate, auth, requireContext, readLimiter, writeLimiter, logEvent, mode }) {
  const path = '/api/term-tests/teacher/term1-listening-room';
  const classId = z.string().regex(/^[1-9]\d{0,17}$/);
  const update = z.discriminatedUnion('action', [
    z.object({ action: z.literal('schedule'), classId, startsAt: z.iso.datetime({ offset: true }) }),
    z.object({ action: z.literal('hold-audio'), classId }),
    z.object({ action: z.literal('finish-audio'), classId })
  ]);
  const handle = (writing) => async (req, res, next) => {
    try {
      res.set('Cache-Control', 'no-store');
      const input = (writing ? update : z.object({ classId })).safeParse(writing ? req.body : req.query);
      if (!input.success) throw fail('TIMER_INVALID', 'Thông tin ca thi chưa hợp lệ.', 400);
      const data = input.data;
      const result = await audioTransaction(pool, async db => {
        const access = (await db.query(`SELECT c.erp_course_class_id FROM mapping.classroom_course_mapping c
          WHERE c.erp_course_class_id=$1 AND ${teacherCanReadClass('$2','$3','c.erp_course_class_id')}`,
        [data.classId, req.reviewer.email, auth.readAuthorization(req)])).rows[0];
        if (!access) throw fail('ACCESS_DENIED', 'Tài khoản chưa có quyền điều hành lớp này.', 403);
        if (!writing) return readTerm1TimerRoom(db, data.classId);
        if (data.action === 'schedule') {
          if (mode !== 'on') throw unavailable();
          const start = new Date(data.startsAt);
          const now = (await db.query('SELECT clock_timestamp() AS now')).rows[0].now;
          if (start < now || start - now > 30 * 86400_000) throw fail('TIMER_START_OUTSIDE_WINDOW', 'Hãy chọn giờ bắt đầu sắp tới trong 30 ngày.');
          const duration = assets.getTiming(slug).listeningTotalSeconds;
          const inserted = await db.query(`INSERT INTO assessment.term1_listening_timer_room(class_id,starts_at,deadline_at)
            VALUES($1,$2,$2::timestamptz+make_interval(secs=>$3)) ON CONFLICT DO NOTHING RETURNING class_id`, [data.classId, start, duration]);
          if (!inserted.rows.length) throw fail('TIMER_ROOM_EXISTS', 'Lớp đã có ca Listening Term Test 1.');
        } else if (data.action === 'hold-audio') {
          const held = await db.query(`UPDATE assessment.term1_listening_timer_room SET audio_held=true
            WHERE class_id=$1 AND deadline_at>clock_timestamp() AND audio_confirmed_at IS NULL RETURNING class_id`, [data.classId]);
          if (!held.rows.length) throw fail('TIMER_ROOM_NOT_RUNNING', 'Không thể giữ ca đã chốt hoặc đã xác nhận phát xong.');
        } else {
          const timing = assets.getTiming(slug);
          const extended = await db.query(`UPDATE assessment.term1_listening_timer_room
            SET deadline_at=greatest(deadline_at,clock_timestamp()+make_interval(secs=>$2)),audio_confirmed_at=clock_timestamp(), audio_held=false
            WHERE class_id=$1 AND audio_confirmed_at IS NULL AND (audio_held OR deadline_at>clock_timestamp())
              AND clock_timestamp()>=starts_at+make_interval(secs=>$3) RETURNING class_id`,
          [data.classId, timing.listeningReviewSeconds, timing.listeningDurationSeconds]);
          if (!extended.rows.length && !(await readTerm1TimerRoom(db,data.classId))?.audio_confirmed_at) {
            throw fail('TIMER_ROOM_NOT_RUNNING', 'Chỉ xác nhận khi audio đã phát đủ thời lượng.');
          }
        }
        return readTerm1TimerRoom(db, data.classId);
      });
      if (writing) logEvent('listening_timer_room_changed', slug, `class:${data.classId}`, { action:data.action, deadlineAt:result.deadline_at });
      res.json({ ok:true, room:result ? { startsAt:result.starts_at, deadlineAt:result.deadline_at, serverNow:result.server_now,
        audioConfirmedAt:result.audio_confirmed_at, audioHeld:result.audio_held } : null });
    } catch (error) { next(error); }
  };
  app.get(path, readLimiter, authenticate, requireContext, handle(false));
  app.post(path, writeLimiter, authenticate, requireContext, handle(true));
}

export async function readTerm1TimerRoom(db, classId) {
  return (await db.query(`SELECT *,clock_timestamp() AS server_now
    FROM assessment.term1_listening_timer_room WHERE class_id=$1`, [classId])).rows[0];
}

export async function useSharedTerm1AudioClock(db, token) {
  const session = (await db.query(`SELECT s.*,r.starts_at,r.deadline_at,r.audio_confirmed_at,clock_timestamp() AS server_now
    FROM assessment.term_test_exam_session s JOIN assessment.term1_listening_timer_room r ON r.class_id=s.erp_course_class_id
    WHERE s.id=$1 AND s.test_slug=$2 AND s.superseded_at IS NULL AND s.attempt_mode<>'answer_sheet' FOR UPDATE OF s`, [token, slug])).rows[0];
  if (!session) return false;
  const enrollment = (await db.query(`SELECT device_hash FROM assessment.term1_listening_timer_session WHERE session_id=$1`, [token])).rows[0];
  if (enrollment?.device_hash) throw fail('TIMER_SESSION_REQUIRED', 'Lượt đang làm ở trang Listening không audio.');
  if (session.server_now < session.starts_at) throw fail('TIMER_ROOM_WAITING', 'Ca Listening chưa đến giờ bắt đầu.');
  if (session.server_now >= session.deadline_at && !session.listening_started_at) throw fail('TIMER_ROOM_CLOSED', 'Ca Listening đã hết giờ.');
  await db.query(`INSERT INTO assessment.term1_listening_timer_session(session_id,class_id,submit_id)
    VALUES($1,$2,$3) ON CONFLICT (session_id) DO NOTHING`, [token, session.erp_course_class_id, randomUUID()]);
  return true;
}

export async function sharedTerm1AudioClockState(db, token) {
  const { rows:[row] } = await db.query(`SELECT r.audio_held FROM assessment.term1_listening_timer_session s
    JOIN assessment.term1_listening_timer_room r ON r.class_id=s.class_id WHERE s.session_id=$1 AND s.device_hash IS NULL`, [token]);
  return row ? { listeningSharedClock:true, sharedAudioConfirmed:!row.audio_held } : {};
}

async function lockTimerSession(db, token) {
  const row = (await db.query(`SELECT s.*,t.device_hash,t.submit_id,r.starts_at,r.deadline_at,r.audio_held
    FROM assessment.term1_listening_timer_session t JOIN assessment.term_test_exam_session s ON s.id=t.session_id
    JOIN assessment.term1_listening_timer_room r ON r.class_id=t.class_id
    WHERE s.id=$1 AND s.superseded_at IS NULL AND t.device_hash IS NOT NULL FOR UPDATE OF s`, [token])).rows[0];
  if (!row) return null;
  row.server_now = (await db.query('SELECT clock_timestamp() AS now')).rows[0].now;
  await db.query("SELECT set_config('k67.timer_session',$1,true)", [token]);
  return row;
}

function snapshot(row) {
  return { ok: true, testSlug: slug, examSessionToken: row.id, generation: Number(row.generation),
    studentName: row.student_name_snapshot, examMode: 'lis_first',
    listeningStartedAt: row.listening_started_at, listeningDeadlineAt: row.deadline_at,
    startsAt: row.starts_at, serverNow: row.server_now, listeningSubmitted: Boolean(row.listening_submitted_at),
    waitingForAudio: row.audio_held && row.server_now >= row.deadline_at,
    attemptToken: row.attempt_id, listeningDraft: row.listening_draft, listeningDraftRevision: Number(row.listening_draft_revision) };
}

async function seal(db, row, incoming) {
  if (row.listening_submitted_at) return { ...snapshot(row), completed: false };
  if (!row.listening_started_at) throw fail('TIMER_NOT_STARTED', 'Chưa mở phần Listening.');
  const timedOut = !row.audio_held && row.server_now >= row.deadline_at;
  if (!timedOut && !incoming) return null;
  if (!timedOut && row.server_now >= row.deadline_at) throw fail('TIMER_AUDIO_FINISH_PENDING', 'Đang chờ giảng viên xác nhận audio đã phát xong.');
  const session = (await db.query(findTermTestListeningSubmissionSql, [row.id, slug])).rows[0];
  const test = parseStoredTest({ ...session, test_slug: slug, definition_version: session.version });
  const useIncoming = !timedOut && incoming.revision >= Number(row.listening_draft_revision);
  const answers = useIncoming ? incoming.answers : row.listening_draft;
  const result = gradeSection(test.listening_definition, answers, test.listening_band_adjustment);
  const attempt = (await db.query(insertProtectedListeningAttemptSql,
    [row.submit_id, row.id, slug, JSON.stringify(answers), JSON.stringify(result)])).rows[0];
  if (!attempt) throw fail('TIMER_ATTEMPT_CONFLICT', 'Lượt đã thay đổi. Hãy kiểm tra bài đã lưu.');
  return { ...snapshot({ ...row, listening_submitted_at: attempt.listening_submitted_at, attempt_id: attempt.attempt_token }),
    completed: false, timedOut, submittedAt: attempt.listening_submitted_at,
    event: { section: 'listening', source: 'timer', timedOut, deadlineAt: row.deadline_at,
      revision: useIncoming ? incoming.revision : Number(row.listening_draft_revision), answeredCount: result.answered } };
}

function receipt(response, logEvent) {
  const { event, ...data } = response;
  if (event) logEvent('submission_completed', slug, data.examSessionToken, event);
  return data;
}

export function mountTerm1ListeningTimer(app, { pool, assets, readStudent, requireContext, writeLimiter, draftLimiter, readLimiter, logEvent, mode }) {
  const prefix = `/api/term-tests/${slug}/listening-timer`;
  const route = (schema, handler) => async (req, res, next) => {
    try {
      res.set('Cache-Control', 'no-store');
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) throw fail('TIMER_INVALID', 'Thông tin lượt Listening chưa hợp lệ.', 400);
      const input = parsed.data;
      const student = (await readStudent(req, input.classCode, slug, input.studentRef)).rows[0];
      if (!student || student.temporary || Number(student.student_id) <= 0) throw unavailable();
      res.json(await handler(input, student));
    } catch (error) { next(error); }
  };

  app.post(prefix + '/prepare', requireContext, writeLimiter, route(identity, async (input, student) => audioTransaction(pool, async db => {
    const room = await readTerm1TimerRoom(db, student.class_id);
    if (!room) throw unavailable();
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${slug}:${student.class_id}:${student.student_id}`]);
    const ids = [slug, student.definition_version, student.class_id];
    const previous = (await db.query(findLatestTermTestAttemptForStudentSql, [...ids, student.student_id])).rows[0];
    if (previous) return { ok: true, listeningSubmitted: true, attemptToken: previous.attempt_token };
    if (room.server_now >= room.deadline_at) throw fail('TIMER_ROOM_CLOSED', 'Ca Listening đã hết giờ.');
    const prepared = (await db.query(insertTermTestExamSessionSql, [...ids, student.class_name, student.student_id, student.student_name, 0])).rows[0];
    if (!prepared || prepared.attempt_token || prepared.attempt_mode === 'answer_sheet') throw unavailable();
    const current = (await db.query('SELECT * FROM assessment.term_test_exam_session WHERE id=$1 FOR UPDATE', [prepared.exam_session_token])).rows[0];
    const existing = await lockTimerSession(db, prepared.exam_session_token);
    if (existing) {
      if (existing.device_hash !== hash(input.deviceProof)) throw fail('TIMER_OWNER_CHANGED', 'Hãy mở lại trên thiết bị đang làm bài.');
      return snapshot(existing);
    }
    if (mode !== 'on') throw unavailable();
    const enrolled = (await db.query(`SELECT 1 FROM assessment.term1_listening_timer_session WHERE session_id=$1`, [current.id])).rows[0];
    if (enrolled) throw fail('TIMER_AUDIO_ACTIVE', 'Lượt đang làm ở trang có audio.');
    const journeyTable = (await db.query("SELECT to_regclass('assessment.term_k67_cbt_journey') AS name")).rows[0].name;
    if (journeyTable && (await db.query('SELECT 1 FROM assessment.term_k67_cbt_journey WHERE session_id=$1', [current.id])).rows.length) {
      throw fail('TIMER_AUDIO_ACTIVE', 'Lượt đã mở ở trang có audio. Hãy tiếp tục ở trang đó.');
    }
    if (current.listening_started_at || current.audio_owner_id || current.exam_mode !== 'lis_first') throw fail('TIMER_AUDIO_ACTIVE', 'Lượt đang làm ở trang có audio.');
    await db.query(`INSERT INTO assessment.term1_listening_timer_session(session_id,class_id,device_hash,submit_id)
      VALUES($1,$2,$3,$4)`, [prepared.exam_session_token, student.class_id, hash(input.deviceProof), randomUUID()]);
    return snapshot(await lockTimerSession(db, prepared.exam_session_token));
  })));

  const withSession = (input, student, run) => audioTransaction(pool, async db => {
    const row = await lockTimerSession(db, input.examSessionToken);
    if (!row || row.device_hash !== hash(input.deviceProof) || Number(row.generation) !== input.generation
      || String(row.erp_course_class_id) !== String(student.class_id) || String(row.erp_student_contact_id) !== String(student.student_id)) {
      throw fail('TIMER_OWNER_CHANGED', 'Lượt Listening không thuộc thiết bị hoặc học viên này.', 403);
    }
    return run(db, row);
  });

  app.post(prefix + '/start', writeLimiter, route(scope, async (input, student) => {
    const result = await withSession(input, student, async (db, row) => {
      if (row.listening_submitted_at) return snapshot(row);
      if (row.server_now < row.starts_at) throw fail('TIMER_ROOM_WAITING', 'Ca Listening chưa đến giờ bắt đầu.');
      if (row.server_now >= row.deadline_at) throw fail('TIMER_ROOM_CLOSED', 'Ca Listening đã hết giờ.');
      if (!row.listening_started_at) {
        await db.query(`UPDATE assessment.term_test_exam_session SET listening_started_at=$2,listening_deadline_at=$3,
          updated_at=clock_timestamp() WHERE id=$1`, [row.id, row.starts_at, row.deadline_at]);
        row.listening_started_at = row.starts_at;
      }
      return snapshot(row);
    });
    if (result.listeningSubmitted) return result;
    const content = await assets.getContent(slug);
    return { ...result, content: { baseTestSlug: slug, title: content.title, variant: content.variant, listening: content.listening } };
  }));

  app.post(prefix + '/status', readLimiter, route(scope, (input, student) => withSession(input, student, (_db, row) => snapshot(row))));
  app.post(prefix + '/draft', draftLimiter, route(draft, (input, student) => withSession(input, student, async (db, row) => {
    if (row.listening_submitted_at || !row.listening_started_at || row.server_now >= row.deadline_at) {
      throw fail('LISTENING_LOCKED', 'Listening đã hết giờ hoặc đã được thu bài.');
    }
    const saved = (await db.query(saveTermTestListeningDraftSql, [row.id, slug, JSON.stringify(input.answers), input.revision])).rows[0];
    if (!saved) throw fail('LISTENING_LOCKED', 'Bản lưu chưa được máy chủ nhận.');
    return { ok: true, accepted: saved.accepted, revision: Number(saved.listening_draft_revision),
      draft: saved.listening_draft, deadlineAt: row.deadline_at, serverNow: row.server_now };
  })));
  app.post(prefix + '/submit', writeLimiter, route(draft, async (input, student) =>
    receipt(await withSession(input, student, (db, row) => seal(db, row, input)), logEvent)));
}

export async function closeExpiredTerm1TimerSessions(pool, logEvent) {
  const { rows } = await pool.query(`SELECT s.id FROM assessment.term1_listening_timer_session t
    JOIN assessment.term_test_exam_session s ON s.id=t.session_id
    JOIN assessment.term1_listening_timer_room r ON r.class_id=t.class_id
    WHERE t.device_hash IS NOT NULL AND NOT r.audio_held AND s.listening_started_at IS NOT NULL AND s.listening_submitted_at IS NULL
      AND s.superseded_at IS NULL AND r.deadline_at<=clock_timestamp() ORDER BY r.deadline_at,s.id LIMIT 40`);
  for (const { id } of rows) {
    try {
      const closed = await audioTransaction(pool, async db => {
        const row = await lockTimerSession(db, id);
        return row && await seal(db, row);
      });
      if (closed) receipt(closed, logEvent);
    } catch (error) {
      logEvent('timer_auto_submit_failed', slug, id, { code: error.code || 'TIMER_AUTO_SUBMIT_FAILED' });
    }
  }
}

export function startTerm1TimerSweep(closeExpired, onError) {
  let running;
  const tick = () => {
    running ??= closeExpired().catch(onError).finally(() => { running = undefined; });
  };
  tick();
  const interval = setInterval(tick, 500).unref();
  return () => {
    clearInterval(interval);
    return running;
  };
}
