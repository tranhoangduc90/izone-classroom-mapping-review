import { createHash } from 'node:crypto';

// Nhận lịch ERP và bản chốt, trả nhãn/thứ tự đề xuất cùng dấu kiểm phiên bản nguồn.
// Không lưu kế hoạch: số chưa được giảng viên chốt luôn mang nhãn dự kiến.
export function scheduleFingerprint(classId, sessions) {
  return createHash('sha256').update(JSON.stringify([String(classId),
    sessions.map(s => [s.erpSessionId, s.date, s.startsAt, s.endsAt, s.statusCode])])).digest('hex');
}

export function decorateSchedule(classId, schedule, confirmedDates = []) {
  const ids = new Set(), dates = new Set();
  const confirmed = new Map(confirmedDates.filter(s => s.erpSessionId).map(s => [s.erpSessionId, s.sessionNumber]));
  let ambiguous = false;
  for (const s of schedule.sessions) {
    if (ids.has(s.erpSessionId) || dates.has(s.date)) ambiguous = true;
    ids.add(s.erpSessionId); dates.add(s.date);
  }
  const ordered = [...schedule.sessions].sort((a,b) => a.startsAt.localeCompare(b.startsAt)
    || (BigInt(a.erpSessionId) < BigInt(b.erpSessionId) ? -1 : BigInt(a.erpSessionId) > BigInt(b.erpSessionId) ? 1 : 0));
  return { ...schedule, fingerprint: scheduleFingerprint(classId, ordered),
    orderSource: 'erp_chronological_teacher_confirmation', ambiguous,
    sessions: ordered.map((s, i) => ({ ...s,
      erpSessionNumber: confirmed.get(s.erpSessionId) || i + 1,
      numberSource: confirmed.has(s.erpSessionId) ? 'teacher_confirmed' : 'proposal',
      proposalEligible: !ambiguous && [0,1].includes(s.statusCode)
    })) };
}
