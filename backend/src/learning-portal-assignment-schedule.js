import { decorateSchedule } from './learning-schedule-plan.js';

const normalizeTime = value => typeof value === 'string' ? value.replace('T', ' ') : '';
const portalBase = 'https://gateway.izone.edu.vn/portal/v1/course-classes/';

// Portal supplies the ID, start and status. A faulty end time is kept in the
// attendance fingerprint, but does not change the identity or order of a lesson.
export function createPortalAssignmentScheduleReader({ fetchImpl = fetch } = {}) {
  return async classId => {
    if (!/^[1-9]\d{0,17}$/u.test(classId)) throw Error('PORTAL_CLASS_INVALID');
    const response = await fetchImpl(portalBase + classId + '/class-sessions', {
      headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(12000)
    });
    if (!response.ok) throw Error('PORTAL_SCHEDULE_UNAVAILABLE');
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

export const occupiedPortalTargetsSql = `SELECT a.session_number,
  COALESCE(target.portal_session_id::text,binding.target_session_id::text,
    (SELECT item->>'erpSessionId' FROM jsonb_array_elements(plan.session_dates) item
     WHERE item->>'sessionNumber'=a.session_number::text LIMIT 1)) AS portal_session_id
  FROM learning.form_assignment a
  LEFT JOIN learning.form_assignment_portal_target target ON target.assignment_id=a.id
  LEFT JOIN learning.portal_attendance_binding binding ON binding.assignment_id=a.id
  LEFT JOIN learning.class_journey_plan plan ON plan.erp_course_class_id=a.erp_course_class_id
  WHERE a.erp_course_class_id=$1::bigint AND a.status IN ('published','closed')`;
