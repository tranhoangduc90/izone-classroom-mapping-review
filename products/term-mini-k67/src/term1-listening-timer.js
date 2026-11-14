import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { audioTransaction } from './audio-incidents.js';
import { AudioRecoveryError } from './audio-recovery.js';
import { findLatestTermTestAttemptForStudentSql, findTermTestListeningSubmissionSql,
  insertProtectedListeningAttemptSql, insertTermTestExamSessionSql, saveTermTestListeningDraftSql } from './sql.js';
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

export async function readTerm1TimerRoom(db, classId) {
  return (await db.query(`SELECT *,clock_timestamp() AS server_now
    FROM assessment.term1_listening_timer_room WHERE class_id=$1`, [classId])).rows[0];
}

export async function useSharedTerm1AudioClock(db, token) {
  const session = (await db.query(`SELECT s.*,r.starts_at,r.deadline_at,clock_timestamp() AS server_now
    FROM assessment.term_test_exam_session s JOIN assessment.term1_listening_timer_room r ON r.class_id=s.erp_course_class_id
    WHERE s.id=$1 AND s.test_slug=$2 AND s.superseded_at IS NULL AND s.attempt_mode<>'answer_sheet' FOR UPDATE OF s`, [token, slug])).rows[0];
  if (!session) return;
  const enrollment = (await db.query(`SELECT device_hash FROM assessment.term1_listening_timer_session WHERE session_id=$1`, [token])).rows[0];
  if (enrollment?.device_hash) throw fail('TIMER_SESSION_REQUIRED', 'Lượt đang làm ở trang Listening không audio.');
  if (session.server_now < session.starts_at) throw fail('TIMER_ROOM_WAITING', 'Ca Listening chưa đến giờ bắt đầu.');
  if (session.server_now >= session.deadline_at && !session.listening_started_at) throw fail('TIMER_ROOM_CLOSED', 'Ca Listening đã hết giờ.');
  await db.query(`INSERT INTO assessment.term1_listening_timer_session(session_id,class_id,submit_id)
    VALUES($1,$2,$3) ON CONFLICT (session_id) DO NOTHING`, [token, session.erp_course_class_id, randomUUID()]);
}

async function lockTimerSession(db, token) {
  const row = (await db.query(`SELECT s.*,t.device_hash,t.submit_id,r.starts_at,r.deadline_at
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
    attemptToken: row.attempt_id, listeningDraft: row.listening_draft, listeningDraftRevision: Number(row.listening_draft_revision) };
}

async function seal(db, row, incoming) {
  if (row.listening_submitted_at) return { ...snapshot(row), completed: false };
  if (!row.listening_started_at) throw fail('TIMER_NOT_STARTED', 'Chưa mở phần Listening.');
  const timedOut = row.server_now >= row.deadline_at;
  if (!timedOut && !incoming) return null;
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

  app.post(prefix + '/start', requireContext, writeLimiter, route(scope, async (input, student) => {
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

  app.post(prefix + '/status', requireContext, readLimiter, route(scope, (input, student) => withSession(input, student, (_db, row) => snapshot(row))));
  app.post(prefix + '/draft', requireContext, draftLimiter, route(draft, (input, student) => withSession(input, student, async (db, row) => {
    if (row.listening_submitted_at || !row.listening_started_at || row.server_now >= row.deadline_at) {
      throw fail('LISTENING_LOCKED', 'Listening đã hết giờ hoặc đã được thu bài.');
    }
    const saved = (await db.query(saveTermTestListeningDraftSql, [row.id, slug, JSON.stringify(input.answers), input.revision])).rows[0];
    if (!saved) throw fail('LISTENING_LOCKED', 'Bản lưu chưa được máy chủ nhận.');
    return { ok: true, accepted: saved.accepted, revision: Number(saved.listening_draft_revision),
      draft: saved.listening_draft, deadlineAt: row.deadline_at, serverNow: row.server_now };
  })));
  app.post(prefix + '/submit', requireContext, writeLimiter, route(draft, async (input, student) =>
    receipt(await withSession(input, student, (db, row) => seal(db, row, input)), logEvent)));
}

export async function closeExpiredTerm1TimerSessions(pool, logEvent) {
  const { rows } = await pool.query(`SELECT s.id FROM assessment.term1_listening_timer_session t
    JOIN assessment.term_test_exam_session s ON s.id=t.session_id
    JOIN assessment.term1_listening_timer_room r ON r.class_id=t.class_id
    WHERE t.device_hash IS NOT NULL AND s.listening_started_at IS NOT NULL AND s.listening_submitted_at IS NULL
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
