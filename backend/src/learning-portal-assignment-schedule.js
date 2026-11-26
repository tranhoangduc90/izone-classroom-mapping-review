import { readFile } from 'node:fs/promises';
import { decorateSchedule } from './learning-schedule-plan.js';

const normalizeTime = value => typeof value === 'string' ? value.replace('T', ' ') : '';
const portalBase = 'https://gateway.izone.edu.vn/portal/v1/course-classes/';
const tokenUrl = 'https://accounts.izone.edu.vn/realms/izone/protocol/openid-connect/token';
const tokenErrors = new Set(['invalid_grant', 'invalid_client', 'unauthorized_client', 'unsupported_grant_type']);
const jwtPattern = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;
const unavailable = () => Error('PORTAL_SCHEDULE_UNAVAILABLE');

function logFailure(logger, operation, reason, response, classId) {
  const requestId = ['x-request-id', 'x-correlation-id', 'cf-ray']
    .map(name => response?.headers.get(name))
    .find(value => value && /^[A-Za-z0-9-]{1,100}$/u.test(value));
  logger?.warn?.(JSON.stringify({ type: 'progress_log_read', operation, status: 'failed',
    classId, httpStatus: response?.status, requestId, reason }));
}

function createPortalTokenReader({ credentialsFile, fetchImpl, logger }) {
  let saved;
  let pending;
  let nextAttemptAt = 0;

  async function signIn() {
    let credentials;
    try {
      credentials = JSON.parse(await readFile(credentialsFile, 'utf8'));
    } catch {
      logFailure(logger, 'portal_schedule_token', 'credentials_unreadable');
      throw unavailable();
    }
    const { username, password, clientId = 'lms' } = credentials ?? {};
    if (![username, password, clientId].every(value => typeof value === 'string' && value.trim())) {
      logFailure(logger, 'portal_schedule_token', 'credentials_invalid');
      throw unavailable();
    }
    let response;
    try {
      response = await fetchImpl(tokenUrl, {
        method: 'POST', headers: { Accept: 'application/json' },
        body: new URLSearchParams({ grant_type: 'password', client_id: clientId, username, password }),
        redirect: 'error', signal: AbortSignal.timeout(8000)
      });
    } catch {
      logFailure(logger, 'portal_schedule_token', 'request_failed');
      throw unavailable();
    }
    const payload = await response.json().catch(() => null);
    const token = payload?.access_token;
    if (!response.ok || typeof token !== 'string' || !jwtPattern.test(token)) {
      const reason = response.ok ? 'invalid_token_response'
        : tokenErrors.has(payload?.error) ? payload.error : 'upstream_http_error';
      logFailure(logger, 'portal_schedule_token', reason, response);
      throw unavailable();
    }
    const lifetimeMs = typeof payload.expires_in === 'number' && Number.isFinite(payload.expires_in)
      ? Math.max(0, payload.expires_in * 1000) : 0;
    saved = { token, validUntil: Date.now() + lifetimeMs - Math.min(30000, lifetimeMs / 2) };
    return token;
  }

  return {
    async get() {
      if (saved?.validUntil > Date.now()) return saved.token;
      if (!credentialsFile || nextAttemptAt > Date.now()) throw unavailable();
      if (!pending) {
        pending = signIn().catch(error => {
          nextAttemptAt = Date.now() + 60000;
          throw error;
        }).finally(() => { pending = undefined; });
      }
      return pending;
    },
    invalidate(token) {
      if (saved?.token === token) saved = undefined;
    }
  };
}

// Portal supplies the ID, start and status. A faulty end time is kept in the
// attendance fingerprint, but does not change the identity or order of a lesson.
export function createPortalAssignmentScheduleReader({ credentialsFile, fetchImpl = fetch, logger } = {}) {
  const auth = createPortalTokenReader({ credentialsFile, fetchImpl, logger });
  return async classId => {
    if (!/^[1-9]\d{0,17}$/u.test(classId)) throw Error('PORTAL_CLASS_INVALID');
    const token = await auth.get();
    let response;
    try {
      response = await fetchImpl(portalBase + classId + '/class-sessions', {
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
        redirect: 'error', signal: AbortSignal.timeout(12000)
      });
    } catch {
      logFailure(logger, 'portal_schedule_read', 'request_failed', undefined, classId);
      throw unavailable();
    }
    if (!response.ok) {
      if (response.status === 401) auth.invalidate(token);
      logFailure(logger, 'portal_schedule_read', 'upstream_http_error', response, classId);
      throw unavailable();
    }
    const payload = await response.json();
    const rows = Array.isArray(payload) ? payload : payload?.data;
    if (!Array.isArray(rows) || rows.length > 200 || rows.some(row => String(row?.course_class_id) !== classId)) {
      throw Error('PORTAL_SCHEDULE_CLASS_MISMATCH');
    }
    const sessions = rows.map(row => {
      const startsAt = normalizeTime(row.session_start_datetime);
      const status = row.status;
      return { erpSessionId: String(row.class_session_id), startsAt, endsAt: normalizeTime(row.session_end_datetime),
        date: startsAt.slice(0, 10), statusCode: status == null || status === '' ? null : Number(status) };
    });
    return { classId, sessions };
  };
}

export function assignmentPortalSchedule(classId, raw) {
  const schedule = decorateSchedule(classId, raw);
  // Attendance uses the Portal response order as the tie-breaker for equal starts.
  const attendanceRows=[...raw.sessions].sort((a,b)=>a.startsAt.localeCompare(b.startsAt));
  return { ...schedule, attendanceFingerprint: JSON.stringify([classId,
    attendanceRows.map(row => [row.erpSessionId, row.startsAt, row.endsAt, row.statusCode])]) };
}

export function portalAssignmentTargets(schedule) {
  return schedule.sessions.filter(row => row.proposalEligible && row.erpSessionNumber <= 100);
}

export function isPortalAssignmentOccupied(rows, slot, portalFirst = false) {
  return rows.some(row => row.portal_session_id === slot.erpSessionId
    || ((!portalFirst || !row.portal_session_id) && Number(row.session_number) === slot.erpSessionNumber));
}

// Keep persisted session numbers unique for existing detail, comments and attendance lookups.
export function portalAssignmentStorageNumber(slot, reserved) {
  const blocked = new Set(reserved.filter(row => row.portal_session_id !== slot.erpSessionId || row.fixed)
    .map(row => Number(row.session_number)));
  const planned = reserved.find(row => row.portal_session_id === slot.erpSessionId && !row.fixed);
  for (const candidate of [Number(planned?.session_number), slot.erpSessionNumber]) {
    if (candidate >= 1 && candidate <= 100 && !blocked.has(candidate)) return candidate;
  }
  // Put a displaced lookup number at the end of the supported range so later lessons can use their usual numbers.
  for (let candidate = 100; candidate >= 1; candidate--) if (!blocked.has(candidate)) return candidate;
  return null;
}

export function portalCalendar(schedule) {
  return {version:schedule.fingerprint,checkedAt:schedule.scheduleCheckedAt,refreshInMs:schedule.scheduleRefreshInMs,
    stale:schedule.scheduleStale===true,entries:schedule.sessions.map(slot=>({
      id:slot.erpSessionId,sessionNumber:slot.proposalEligible?slot.erpSessionNumber:null,startsAt:slot.startsAt,
      date:slot.date,status:slot.statusCode===2?'cancelled':slot.proposalEligible?'active':'needs_review'
    }))};
}

export function projectPortalJourney(view, schedule, planDates, booked, today) {
  const byId = new Map(schedule.sessions.map(slot => [slot.erpSessionId,slot]));
  const bookedByNumber = new Map(booked.map(item => [Number(item.session_number),item.portal_session_id]));
  const planByNumber = new Map(planDates.map(item => [item.sessionNumber,item.erpSessionId]));
  const linked = new Set();
  const sessions = view.sessions.map(session => {
    const id = bookedByNumber.get(session.sessionNumber) || planByNumber.get(session.sessionNumber);
    if (!id) return {...session,sessionDate:null,scheduleStatus:'needs_review'};
    const latest = byId.get(id);
    const confirmed = latest && !schedule.ambiguous && latest.proposalEligible;
    const cancelled = latest?.statusCode === 2;
    // Keep action keys scoped to the stored lesson, including when its current Portal number has changed.
    linked.add(id);
    return { ...session, erpSessionId:id, portalSessionNumber:confirmed?latest.erpSessionNumber:null,
      sessionDate:latest?.date||session.sessionDate, sessionStartTime:latest?.startsAt.slice(11)||session.sessionStartTime,
      future:!cancelled&&Boolean(latest?.date && latest.date>today),
      scheduleStatus:cancelled?'cancelled':!confirmed?'needs_review':schedule.scheduleStale?'temporarily_unavailable':'connected' };
  });
  const calendar=portalCalendar(schedule);
  calendar.entries=calendar.entries.map(entry=>({...entry,linked:linked.has(entry.id)}));
  const total=calendar.entries.filter(entry=>entry.status==='active').length;
  const activeSummary=schedule.ambiguous?{}:{
    ...(view.totalSessions===undefined?{}:{totalSessions:total,planOutdated:false}),
    ...(view.summary?{summary:{...view.summary,totalSessions:total},
      coverage:{...view.coverage,schedule:'portal',plannedSessions:total,planOutdated:false}}:{})
  };
  return { ...view,...activeSummary,sessions,scheduleStatus:schedule.scheduleStale?'temporarily_unavailable':schedule.ambiguous?'needs_review':'connected',
    portalSchedule:calendar };
}

export const reservedPortalStorageNumbersSql = `SELECT session_number,NULL::text AS portal_session_id,true AS fixed
  FROM learning.form_assignment WHERE erp_course_class_id=$1::bigint
  UNION ALL SELECT (item->>'sessionNumber')::integer,item->>'erpSessionId',false
    FROM learning.class_journey_plan plan, LATERAL jsonb_array_elements(plan.session_dates) item
    WHERE plan.erp_course_class_id=$1::bigint
  UNION ALL SELECT session_number,NULL,true FROM learning.student_session_comment
    WHERE erp_course_class_id=$1::bigint
  UNION ALL SELECT session_number,NULL,true FROM learning.teacher_session_comment_draft
    WHERE erp_course_class_id=$1::bigint`;

export const occupiedPortalTargetsSql = `SELECT a.session_number,
  COALESCE(target.portal_session_id::text,binding.target_session_id::text,
    (SELECT item->>'erpSessionId' FROM jsonb_array_elements(plan.session_dates) item
     WHERE item->>'sessionNumber'=a.session_number::text LIMIT 1)) AS portal_session_id
  FROM learning.form_assignment a
  LEFT JOIN learning.form_assignment_portal_target target ON target.assignment_id=a.id
  LEFT JOIN learning.portal_attendance_binding binding ON binding.assignment_id=a.id
  LEFT JOIN learning.class_journey_plan plan ON plan.erp_course_class_id=a.erp_course_class_id
  WHERE a.erp_course_class_id=$1::bigint AND a.status IN ('published','closed')`;
