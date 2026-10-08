import test from 'node:test';
import assert from 'node:assert/strict';
import { decorateSchedule, scheduleFingerprint } from '../src/learning-schedule-plan.js';

const row = (id, date, statusCode=0) => ({erpSessionId:id,date,startsAt:date+' 18:30:00',endsAt:date+' 21:00:00',statusCode});
test('số buổi theo lịch hợp lệ, bản chốt cũ chỉ giữ để đối chiếu lịch sử', () => {
  const prior=[{sessionNumber:2,erpSessionId:'11',date:'2026-09-17'}];
  const schedule=decorateSchedule('123',{sessions:[row('12','2026-09-21'),row('11','2026-09-17')]},prior);
  assert.equal(schedule.sessions[0].erpSessionNumber,1);
  assert.equal(schedule.sessions[0].previouslyConfirmedNumber,2);
  assert.equal(schedule.sessions[0].numberSource,'erp_valid_session_ordinal');
  assert.equal(schedule.sessions[1].numberSource,'erp_valid_session_ordinal');
  assert.deepEqual(prior,[{sessionNumber:2,erpSessionId:'11',date:'2026-09-17'}]);
  assert.notEqual(schedule.fingerprint,scheduleFingerprint('124',schedule.sessions));
  assert.notEqual(schedule.fingerprint,scheduleFingerprint('123',[row('11','2026-09-18'),row('12','2026-09-21')]));
});
test('ngày/ID trùng hoặc trạng thái chưa hiểu không được ghép tự động', () => {
  const duplicates=decorateSchedule('123',{sessions:[row('11','2026-09-17'),row('12','2026-09-17')]});
  assert.equal(duplicates.ambiguous,true);
  assert.ok(duplicates.sessions.every(s=>!s.proposalEligible));
  const unknown=decorateSchedule('123',{sessions:[row('11','2026-09-17',9)]});
  assert.equal(unknown.sessions[0].proposalEligible,false);
});

test('IC2305 bỏ buổi 01/10 đã hủy: buổi hợp lệ 05/10 mang số 6', () => {
  const schedule = decorateSchedule('1294', { sessions: [
    row('35816', '2026-10-01', 2), row('35817', '2026-10-05', 0),
    row('35811', '2026-09-14', 1), row('35812', '2026-09-17', 1),
    row('35813', '2026-09-21', 1), row('35814', '2026-09-24', 1),
    row('35815', '2026-09-28', 1)
  ] });
  assert.equal(schedule.sessions.find(s => s.erpSessionId === '35817').erpSessionNumber, 6);
  assert.equal(schedule.sessions.find(s => s.erpSessionId === '35816').proposalEligible, false);
});
