import test from 'node:test';
import assert from 'node:assert/strict';
import { decorateSchedule, scheduleFingerprint } from '../src/learning-schedule-plan.js';

const row = (id, date, statusCode=0) => ({erpSessionId:id,date,startsAt:date+' 18:30:00',endsAt:date+' 21:00:00',statusCode});
test('ERP số đã chốt theo ID, số mới là đề xuất; đọc không đổi bản chốt', () => {
  const prior=[{sessionNumber:2,erpSessionId:'11',date:'2026-09-17'}];
  const schedule=decorateSchedule('123',{sessions:[row('12','2026-09-21'),row('11','2026-09-17')]},prior);
  assert.equal(schedule.sessions[0].erpSessionNumber,2);
  assert.equal(schedule.sessions[0].numberSource,'teacher_confirmed');
  assert.equal(schedule.sessions[1].numberSource,'proposal');
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
