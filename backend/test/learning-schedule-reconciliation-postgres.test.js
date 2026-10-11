// PostgreSQL riêng, nhiều connection và role ứng dụng thật; không dùng database lớp thật.
import test from 'node:test';import assert from 'node:assert/strict';import crypto from 'node:crypto';
import {postgresFixture} from './learning-postgres-fixture.js';
import {createLearningService} from '../src/learning-service.js';
import {createAttendanceBindingStore} from '../src/learning-attendance-binding.js';
import {claimLearningJobs} from '../src/learning-outbox.js';
const reviewer={email:'teacher@example.test',canAccessAllClasses:false};
const row=date=>({erpSessionId:'35819',date,startsAt:date+' 18:30:00',endsAt:date+' 21:00:00',statusCode:0});
async function setup(){
 const f=await postgresFixture({asApplication:true});
 let rows=[row('2026-10-12')];
 const reader=async()=>({sessions:rows});
 const service=createLearningService({pool:f.clockPool,erpScheduleReader:reader});
 const plan=await service.saveTeacherJourneyPlan({classId:'2139',totalSessions:3,testSessionNumbers:[],
  sessionDates:[{sessionNumber:3,date:'2026-10-12',erpSessionId:'35819'}],expectedRevision:0,reviewer});
 const published=await service.publishReflectionForm({reviewer,title:'Phiếu dời lịch giả',courseCode:'56',classId:'2139',sessionNumber:3,
  opensAt:null,closesAt:null,items:[{libraryItemId:'10000000-0000-4000-8000-000000000001',checkpoint:1,required:true}]});
 const assignment=await service.getPublicAssignment(published.publicToken);
 const movedInput=async()=>({classId:'2139',totalSessions:3,testSessionNumbers:[],sessionDates:[{sessionNumber:3,date:rows[0].date,erpSessionId:'35819'}],
  expectedRevision:plan.revision,expectedScheduleFingerprint:(await service.getTeacherErpSchedule({classId:'2139',reviewer})).fingerprint,operationId:crypto.randomUUID(),reviewer});
 return {...f,service,published,assignment,reader,movedInput,setRows(value){rows=value;},startInput:{publicToken:published.publicToken,
  studentRef:assignment.roster[0].studentRef,identityConfirmed:true,clientIdempotencyKey:crypto.randomUUID()}};
}
test('S07/S08: role ứng dụng, hai GV xác nhận cùng lúc chỉ một revision/audit',async()=>{
 const f=await setup();try{
  f.setRows([row('2026-10-19')]);const input=await f.movedInput();
  const other={...input,operationId:crypto.randomUUID()};
  const results=await Promise.allSettled([f.service.saveTeacherJourneyPlan(input),f.service.saveTeacherJourneyPlan(other)]);
  assert.equal(results.filter(r=>r.status==='fulfilled'&&!r.value.replayed).length,1);
  assert.equal((await f.pool.query('SELECT revision FROM learning.class_journey_plan')).rows[0].revision,2);
  assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM learning.journey_plan_change')).rows[0].n,1);
  const winner=results[0].status==='fulfilled'?input:other;
  assert.equal((await f.service.saveTeacherJourneyPlan(winner)).revision,2);
 }finally{await f.close();}
});
test('S09: audit lỗi rollback cả kế hoạch và cửa sổ nộp',async()=>{
 const f=await setup();try{
  await f.pool.query(`UPDATE learning.form_assignment SET opens_at='2026-10-12T11:25:00Z',closes_at='2026-10-12T15:00:00Z' WHERE id=$1::uuid`,[f.published.assignmentId]);
  f.setRows([row('2026-10-19')]);const input=await f.movedInput();
  const pool={query:f.clockPool.query,async connect(){const c=await f.clockPool.connect();return {release:c.release,query(sql,args){if(sql.includes('INSERT INTO learning.journey_plan_change'))throw Error('AUDIT_FIXTURE_FAILURE');return c.query(sql,args);}};}};
  await assert.rejects(()=>createLearningService({pool,erpScheduleReader:f.reader}).saveTeacherJourneyPlan(input),/AUDIT_FIXTURE_FAILURE/);
  assert.equal((await f.pool.query('SELECT revision FROM learning.class_journey_plan')).rows[0].revision,1);
  assert.equal((await f.pool.query('SELECT opens_at FROM learning.form_assignment')).rows[0].opens_at.toISOString(),'2026-10-12T11:25:00.000Z');
  const applied=await f.service.saveTeacherJourneyPlan(input);assert.equal(applied.revision,2);
  assert.equal((await f.pool.query('SELECT opens_at FROM learning.form_assignment')).rows[0].opens_at.toISOString(),'2026-10-19T11:25:00.000Z');
 }finally{await f.close();}
});
test('S10: start giữ khóa phiếu, đổi lịch đến sau không vượt kiểm usage',async()=>{
 const f=await setup();let release;try{
  let entered;const gate=new Promise(r=>{release=r;});const ready=new Promise(r=>{entered=r;});
  const opening=createLearningService({pool:f.clockPool,erpScheduleReader:async()=>{entered();await gate;return {sessions:[row('2026-10-12')]};}});
  const start=opening.startAttempt(f.startInput);await ready;
  f.setRows([row('2026-10-19')]);const input=await f.movedInput();
  const applying=f.service.saveTeacherJourneyPlan(input);
  release();await start;await assert.rejects(()=>applying,e=>e.code==='ERP_SESSION_IN_USE');
  assert.equal((await f.pool.query('SELECT revision FROM learning.class_journey_plan')).rows[0].revision,1);
  assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM learning.attempt')).rows[0].n,1);
 }finally{release?.();await f.close();}
});
test('S11/S12: nhận bài giữ đích ngay trước enqueue; lịch đổi khi job còn chờ không tạo ý định ghi sang dòng mới',async()=>{
 const f=await setup();try{
  const attempt=await f.service.startAttempt(f.startInput);
  const response={[f.assignment.definition.blocks[0].items[0].itemVersionId]:'Nội dung giả để kiểm nhận bài.'};
  const input={attemptToken:attempt.attemptToken,submissionId:crypto.randomUUID(),definitionHash:attempt.definitionHash,draftRevision:0,responses:response};
  await f.service.submit(input);await f.service.submit(input);
  const binding=(await f.pool.query('SELECT * FROM learning.portal_attendance_binding')).rows[0];
  assert.equal(String(binding.target_session_id),'35819');assert.ok(binding.accepted_at);assert.equal(binding.write_started,false);
  assert.equal(binding.schedule_fingerprint,JSON.stringify(['2139',[['35819','2026-10-12 18:30:00','2026-10-12 21:00:00',0]]]));
  const [job]=await claimLearningJobs({pool:f.clockPool,workerId:'schedule-fixture',limit:1,leaseSeconds:90,jobTypes:['sync_portal_attendance']});
  const held=await createAttendanceBindingStore(f.clockPool).reserve(job,job.payload,{targetSessionId:'35819',resolvedSessionId:'99999',
   scheduleFingerprint:'changed',sessionDate:'2026-10-19',status:'target_changed'});
  assert.equal(held.reviewRequired,true);assert.equal(held.targetSessionId,'35819');
  assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM learning.portal_attendance_operation')).rows[0].n,0);
  assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM learning.submission')).rows[0].n,1);
 }finally{await f.close();}
});
test('S13: cùng mã buổi nhưng lịch đổi sau nhận bài vẫn giữ job để đối chiếu',async()=>{
 const f=await setup();try{
  const attempt=await f.service.startAttempt(f.startInput);
  await f.service.submit({attemptToken:attempt.attemptToken,submissionId:crypto.randomUUID(),definitionHash:attempt.definitionHash,
   draftRevision:0,responses:{[f.assignment.definition.blocks[0].items[0].itemVersionId]:'Dữ liệu giả kiểm lịch đổi.'}});
  const [job]=await claimLearningJobs({pool:f.clockPool,workerId:'schedule-fixture',limit:1,leaseSeconds:90,jobTypes:['sync_portal_attendance']});
  const result=await createAttendanceBindingStore(f.clockPool).reserve(job,job.payload,{targetSessionId:'35819',resolvedSessionId:'35819',
   scheduleFingerprint:'snapshot-after-date-change',sessionDate:'2026-10-19',status:'already_present'});
  assert.equal(result.reviewRequired,true);assert.equal(result.canReadbackKnown,false);
  assert.equal((await f.pool.query('SELECT count(*)::int n FROM learning.portal_attendance_operation')).rows[0].n,0);
 }finally{await f.close();}
});
