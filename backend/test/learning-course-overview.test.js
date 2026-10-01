import test from 'node:test';
import assert from 'node:assert/strict';
import {buildCourseOverview} from '../src/learning-course-overview.js';
test('O01/O02: giữ đủ buổi, Test/gap/tương lai không thành vắng; người trùng tên giữ ID',()=>{
  const overview=buildCourseOverview({classId:'123',className:'Lớp mẫu',capturedAt:'2026-10-01T00:00:00Z',
    plan:{total_sessions:5,test_session_numbers:[3],revision:1,session_dates:[{sessionNumber:5,date:'2026-10-20'}]},
    currentRoster:[{student_ref:'s1',student_name:'Trùng tên'},{student_ref:'s2',student_name:'Trùng tên'}],
    rows:[{assignment_id:'a1',session_number:1,title:'Phiếu',student_ref:'s1',student_name_snapshot:'Trùng tên',submission_id:'sub1',completeness:'complete',
      attendance_status:'self_confirmed',portal_sync:{status:'queued'}},{assignment_id:'a1',session_number:1,title:'Phiếu',student_ref:'s2',student_name_snapshot:'Trùng tên'},
      {assignment_id:'a5',session_number:5,title:'Buổi tới',student_ref:'s1',student_name_snapshot:'Trùng tên'}]});
  assert.equal(overview.totalSessions,5);assert.equal(overview.students.length,2);
  assert.deepEqual(overview.students[0].cells.map(c=>c.status),['complete','no_assignment','test_pending','no_assignment','scheduled']);
  assert.equal(overview.students[1].cells[0].status,'not_submitted');
  assert.equal(overview.students[1].cells[4].status,'not_assigned');
  assert.equal(overview.students[0].cells[0].portalSync.status,'queued');
  assert.equal(overview.counts.complete,1);
});
test('O01: lớp chỉ có kế hoạch chưa có assignment vẫn đủ lịch và roster',()=>{
  const overview=buildCourseOverview({classId:'123',className:'Lớp mẫu',plan:{total_sessions:2,test_session_numbers:[2]},
    currentRoster:[{student_ref:'s1',student_name:'Học viên mẫu'}],rows:[]});
  assert.equal(overview.sessions.length,2);assert.equal(overview.students[0].cells[1].status,'test_pending');
  assert.equal(overview.counts.assignments,0);
});
