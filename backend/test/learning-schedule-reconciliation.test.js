import test from 'node:test';
import assert from 'node:assert/strict';
import {decorateSchedule} from '../src/learning-schedule-plan.js';
import {reconcileJourneySchedule,createScheduleMonitor} from '../src/learning-schedule-reconciliation.js';
const row=(id,date,statusCode=0)=>({erpSessionId:id,date,startsAt:date+' 18:30:00',endsAt:date+' 21:00:00',statusCode});
const prior=[{sessionNumber:8,date:'2026-10-12',erpSessionId:'35819'}];
const view={sessions:[{sessionNumber:8,sessionDate:'2026-10-12',sessionKind:'lesson'}]};
test('ID không trượt khi thêm buổi trước; cùng ngày khác giờ vẫn là hai mốc',()=>{
 const schedule=decorateSchedule('1294',{sessions:[row('35818','2026-10-08'),row('35819','2026-10-12')]});
 const out=reconcileJourneySchedule(view,schedule,prior);
 assert.equal(out.sessions[0].erpSessionId,'35819');assert.equal(out.sessions[0].sessionDate,'2026-10-12');
 assert.equal(out.scheduleChanges.length,0);assert.equal(out.unassignedErpSessions.length,1);
});
for(const [name,sessions,reason] of [['hủy',[row('35819','2026-10-12',2)],'cancelled'],['dòng bị thay',[row('90000','2026-10-19')],'session_missing'],
 ['chưa rõ trạng thái',[row('35819','2026-10-12',3)],'ambiguous'],['trùng nguồn',[row('35819','2026-10-12'),row('35819','2026-10-12')],'ambiguous']])
 test(name+': giữ mốc, không tự ghép dòng mới',()=>{
  const out=reconcileJourneySchedule(view,decorateSchedule('1294',{sessions}),prior);
  assert.equal(out.sessions[0].sessionDate,'2026-10-12');assert.equal(out.scheduleChanges[0].reason,reason);
 });
test('đích đã nhận bài không đổi sang ID kế hoạch mới',()=>{
 const out=reconcileJourneySchedule(view,decorateSchedule('1294',{sessions:[row('90000','2026-10-19')]}),
  [{...prior[0],erpSessionId:'90000'}],[{session_number:8,target_session_id:'35819',accepted_at:'2026-10-12T12:00:00Z'}]);
 assert.equal(out.sessions[0].erpSessionId,'35819');assert.equal(out.scheduleChanges[0].attendanceFrozen,true);
});
test('18 request gộp một lần ERP; cache lỗi không báo thành công; đọc lại phục hồi',async()=>{
 let calls=0,time=0,fail=false;
 const monitor=createScheduleMonitor(async()=>{calls++;await Promise.resolve();if(fail)throw Error('offline');return {sessions:[row('35819','2026-10-12')]};},{now:()=>time});
 await Promise.all(Array.from({length:18},()=>monitor('1294')));assert.equal(calls,1);
 fail=true;time=16000;await assert.rejects(()=>monitor('1294'),/offline/);
 await assert.rejects(()=>monitor('1294'),/offline/);assert.equal(calls,2);
 fail=false;await monitor('1294',{fresh:true});assert.equal(calls,3);
});
test('kiểm nền giới hạn theo lớp, cả khi không mở dashboard, không gọi lớp khác',async()=>{
 let tick,closed=false;const calls=[];
 const monitor=createScheduleMonitor(async id=>{calls.push(id);return {sessions:[row('35819','2026-10-12')]};},
 {classIds:['1294','1294','invalid'],timers:{setInterval(fn,ms){assert.equal(ms,300000);tick=fn;return {unref(){}};},clearInterval(){closed=true;}}});
 await monitor('1294');assert.deepEqual(calls,['1294']);await tick();assert.deepEqual(calls,['1294','1294']);
 assert.equal(monitor.status()[0].available,true);monitor.close();assert.equal(closed,true);
});
