import { createHash } from 'node:crypto';

// Nhận lịch ERP, đếm buổi hợp lệ theo ngày/giờ và giữ bản chốt cũ chỉ để đối chiếu.
// Buổi hủy không có số; nguồn mơ hồ không được tự ghép hoặc ghi điểm danh.
export function scheduleFingerprint(classId, sessions) {
  return createHash('sha256').update(JSON.stringify([String(classId),
    sessions.map(s => [s.erpSessionId, s.date, s.startsAt, s.endsAt, s.statusCode])])).digest('hex');
}

export function decorateSchedule(classId, schedule, confirmedDates = []) {
  const ids = new Set(), starts = new Set();
  const confirmed = new Map(confirmedDates.filter(s => s.erpSessionId).map(s => [s.erpSessionId, s.sessionNumber]));
  let ambiguous = false;
  for (const s of schedule.sessions) {
    const validTime = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s.startsAt)
      && Number.isFinite(Date.parse(s.startsAt.replace(' ', 'T') + 'Z'))
      && new Date(s.startsAt.replace(' ', 'T') + 'Z').toISOString().slice(0, 19) === s.startsAt.replace(' ', 'T');
    if (ids.has(s.erpSessionId) || ([0, 1].includes(s.statusCode) && starts.has(s.startsAt))
      || !/^[1-9]\d*$/.test(s.erpSessionId) || ![0, 1, 2].includes(s.statusCode) || !validTime) ambiguous = true;
    ids.add(s.erpSessionId);
    if ([0, 1].includes(s.statusCode)) starts.add(s.startsAt);
  }
  const ordered = [...schedule.sessions].sort((a,b) => a.startsAt.localeCompare(b.startsAt)
    || String(a.erpSessionId).localeCompare(String(b.erpSessionId)));
  let validOrdinal = 0;
  return { ...schedule, fingerprint: scheduleFingerprint(classId, ordered),
    orderSource: 'erp_valid_session_ordinal_v1', ambiguous,
    sessions: ordered.map(s => ({ ...s,
      erpSessionNumber: [0, 1].includes(s.statusCode) ? (++validOrdinal) : null,
      previouslyConfirmedNumber: confirmed.get(s.erpSessionId) || null,
      numberSource: 'erp_valid_session_ordinal',
      proposalEligible: !ambiguous && [0,1].includes(s.statusCode)
    })) };
}
