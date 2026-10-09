// Nhận bản chốt, lịch ERP và đích điểm danh đã giữ. Giữ số buổi theo ID,
// trả thay đổi để GV xác nhận; không tự đổi lịch, bài làm hoặc Portal.
export function reconcileJourneySchedule(view, schedule, confirmedDates = [], bindings = [], previousSchedule = null) {
  const confirmed = new Map(confirmedDates.map(s => [Number(s.sessionNumber), s]));
  const pinned = new Map(bindings.map(b => [Number(b.session_number), b]));
  const byId = new Map(schedule.sessions.map(s => [String(s.erpSessionId), s]));
  const beforeById = new Map((previousSchedule?.sessions || []).map(s=>[String(s.erpSessionId),s]));
  const changes = [];
  const sessions = view.sessions.map(session => {
    const prior = confirmed.get(session.sessionNumber);
    const binding = pinned.get(session.sessionNumber);
    const id = binding ? String(binding.target_session_id) : prior?.erpSessionId;
    const current = id ? byId.get(id) : null;
    const date = prior?.date || session.sessionDate || null;
    let status = 'unconfirmed';
    let reason = null;
    if (id) {
      if (schedule.ambiguous) reason = 'ambiguous';
      else if (!current) reason = 'session_missing';
      else if (binding?.review_required) reason = 'attendance_review';
      else if (current.statusCode === 2) reason = 'cancelled';
      else if (current.date !== date) reason = 'date_changed';
      else if (beforeById.has(id) && (beforeById.get(id).startsAt!==current.startsAt || beforeById.get(id).endsAt!==current.endsAt)) reason='time_changed';
      else if (prior?.erpSessionId && prior.erpSessionId !== id) reason = 'binding_conflict';
      status = reason ? 'needs_review' : 'connected';
      if (reason) changes.push({ sessionNumber: session.sessionNumber, reason,
        before: { date, erpSessionId: id },
        after: current ? { date: current.date, erpSessionId: id, statusCode: current.statusCode,
          startsAt: current.startsAt, endsAt: current.endsAt } : null,
        attendanceFrozen: !!(binding?.write_started || binding?.accepted_at) });
    }
    // Buổi đã chốt luôn giữ ngày và số cho tới khi xác nhận, kể cả nguồn lỗi/hủy.
    return { ...session, previouslyPlannedDate: date, sessionDate: date,
      erpSessionId: id || null, scheduleStatus: status };
  });
  const used = new Set(confirmedDates.map(s => s.erpSessionId).filter(Boolean));
  return { ...view, sessions, scheduleStatus: changes.length || schedule.ambiguous ? 'needs_review' : 'connected',
    scheduleChanges: changes, scheduleFingerprint: schedule.fingerprint,
    scheduleCheckedAt: schedule.scheduleCheckedAt || null,
    unassignedErpSessions: schedule.sessions.filter(s => s.proposalEligible && !used.has(s.erpSessionId))
      .map(s => ({ erpSessionId: s.erpSessionId, date: s.date })) };
}

// Chỉ đọc theo lớp, gộp yêu cầu đồng thời, giới hạn số lớp theo dõi.
// Lỗi không biến thành lịch rỗng và không ghi DB; chu kỳ nền mặc định 5 phút.
export function createScheduleMonitor(reader, { classIds = [], intervalMs = 300000,
  cacheMs = 15000, now = Date.now, timers = globalThis } = {}) {
  if (!reader) return null;
  const cache = new Map(), pending = new Map();
  const watched = [...new Set(classIds.map(String).filter(id => /^[1-9]\d*$/.test(id)))].slice(0, 10);
  async function read(id, { fresh = false } = {}) {
    id = String(id);
    const saved = cache.get(id);
    if (!fresh && saved && now() - saved.at < cacheMs) {
      if (saved.error) throw saved.error;
      return saved.value;
    }
    if (pending.has(id)) return pending.get(id);
    const request = (async () => {
      try {
        const data = await Promise.resolve().then(()=>reader(id));
        if ((data.classId !== undefined && String(data.classId) !== id) || !Array.isArray(data.sessions) || !data.sessions.length)
          throw new Error('ERP_SCHEDULE_INCOMPLETE');
        const value = { ...data, scheduleCheckedAt: new Date(now()).toISOString() };
        cache.set(id, { value, at: now() });
        return value;
      } catch (error) { cache.set(id, { ...saved, error, at: now() }); throw error; }
      finally { pending.delete(id); }
    })();
    pending.set(id, request);
    return request;
  }
  const poll = async () => {
    // Tuần tự để một lần kiểm nền không dồn request ERP.
    for (const id of watched) try { await read(id, { fresh: true }); } catch { /* UI báo lỗi đọc, giữ bản chốt. */ }
  };
  const timer = watched.length ? timers.setInterval(poll, intervalMs) : null;
  timer?.unref?.();
  if (watched.length) void poll();
  read.close = () => { if (timer) timers.clearInterval(timer); };
  read.poll = poll;
  read.status = () => watched.map(id => ({ classId: id, checkedAt: cache.get(id)?.value?.scheduleCheckedAt || null,
    available: !!cache.get(id)?.value && !cache.get(id)?.error }));
  return read;
}
