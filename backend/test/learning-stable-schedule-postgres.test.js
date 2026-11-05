import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {postgresFixture} from './learning-postgres-fixture.js';
import {createLearningService} from '../src/learning-service.js';
import {createLearningAttendanceSync} from '../src/learning-attendance-sync.js';
import {claimLearningJobs,processLearningJob} from '../src/learning-outbox.js';

const reviewer={email:'teacher@example.test',canAccessAllClasses:false};
const row=(id,date,statusCode=0)=>({erpSessionId:id,date,startsAt:date+' 18:30:00',endsAt:date+' 21:00:00',statusCode});
const fingerprint=rows=>JSON.stringify(['2139',[...rows].sort((a,b)=>a.startsAt.localeCompare(b.startsAt)).map(s=>[s.erpSessionId,s.startsAt,s.endsAt,s.statusCode])]);
async function setup(){
 const f=await postgresFixture({asApplication:true});let rows=[row('45','2026-10-12')];
 const service=createLearningService({pool:f.clockPool,erpScheduleReader:async()=>({sessions:rows})});
 await service.saveTeacherJourneyPlan({classId:'2139',totalSessions:3,testSessionNumbers:[],sessionDates:[{sessionNumber:3,date:'2026-10-12',erpSessionId:'45'}],expectedRevision:0,reviewer});
 const published=await service.publishReflectionForm({reviewer,title:'Stable session fixture',courseCode:'56',classId:'2139',sessionNumber:3,opensAt:null,closesAt:null,items:[{libraryItemId:'10000000-0000-4000-8000-000000000001',checkpoint:1,required:true}]});
 const assignment=await service.getPublicAssignment(published.publicToken);
 const start=student=>service.startAttempt({publicToken:published.publicToken,studentRef:student.studentRef,identityConfirmed:true,clientIdempotencyKey:crypto.randomUUID()});
 return {...f,service,published,assignment,start,get rows(){return rows;},set rows(value){rows=value;}};
}
test('0→1 ở cùng mã buổi không khóa cả phiếu hoặc chặn người kế tiếp',async()=>{
 const f=await setup();try{
  const attempt=await f.start(f.assignment.roster[0]);
  await f.service.submit({attemptToken:attempt.attemptToken,submissionId:crypto.randomUUID(),definitionHash:attempt.definitionHash,draftRevision:0,responses:{}});
  f.rows=[row('45','2026-10-12',1)];let writes=0;
  const fetchImpl=async(_url,options)=>{const r=JSON.parse(options.body),same=r.expectedScheduleFingerprint===fingerprint(f.rows);
   const status=r.commit?(writes++,'synced'):!same?'target_changed':'resolved';
   return {ok:true,json:async()=>({ok:true,status,entityKey:r.entityKey,unitKey:r.unitKey,operationKey:r.operationKey,idempotencyKey:r.idempotencyKey,classId:r.classId,studentId:r.studentId,sessionNumber:r.sessionNumber,targetSessionId:'45',resolvedSessionId:'45',bindingRevision:r.bindingRevision??null,scheduleFingerprint:fingerprint(f.rows),sessionDate:'2026-10-12'})};};
  const [job]=await claimLearningJobs({pool:f.clockPool,workerId:'fixture',limit:1,leaseSeconds:90,jobTypes:['sync_portal_attendance']});
  const result=await processLearningJob({pool:f.clockPool,workerId:'fixture',job,handler:createLearningAttendanceSync({pool:f.clockPool,config:{learningAttendanceSyncUrl:'https://fixture.invalid/readwrite',learningAttendanceSyncSecret:'fixture',learningAttendanceSyncTimeoutMs:1000},fetchImpl})});
  assert.equal(result.status,'complete');assert.equal(writes,1);
  assert.equal((await f.pool.query('SELECT review_required FROM learning.portal_attendance_binding')).rows[0].review_required,false);
  await f.start(f.assignment.roster[1]);
 }finally{await f.close();}
});
test('cùng ID dời ngày/giờ: giữ attempt/nháp/đích, Journey và kế hoạch trả lịch mới',async()=>{
 const f=await setup();try{
  const student=f.assignment.roster[0],attempt=await f.start(student);
  const responses={[f.assignment.definition.blocks[0].items[0].itemVersionId]:'Nháp và phần đã nhận phải giữ nguyên'};
  await f.service.saveDraft({attemptToken:attempt.attemptToken,revision:1,definitionHash:attempt.definitionHash,responses});
  await f.service.submitCheckpoint({attemptToken:attempt.attemptToken,checkpointSubmissionId:crypto.randomUUID(),blockId:f.assignment.definition.blocks[0].blockId,checkpoint:1,draftRevision:1,definitionHash:attempt.definitionHash,responses,idempotencyKey:crypto.randomUUID()});
  const before=(await f.pool.query('SELECT id,draft,draft_revision FROM learning.attempt')).rows;
  const checkpoints=(await f.pool.query('SELECT * FROM learning.checkpoint_submission')).rows;
  const attendance=(await f.pool.query('SELECT * FROM learning.attendance_record')).rows;
  f.rows=[row('44','2026-10-10',1),{...row('45','2026-10-19',1),startsAt:'2026-10-19 19:00:00',endsAt:'2026-10-19 21:30:00'}];
  const reopened=await f.start(student);assert.equal(reopened.attemptToken,attempt.attemptToken);
  assert.deepEqual((await f.pool.query('SELECT id,draft,draft_revision FROM learning.attempt')).rows,before);
  assert.deepEqual((await f.pool.query('SELECT * FROM learning.checkpoint_submission')).rows,checkpoints);
  assert.deepEqual((await f.pool.query('SELECT * FROM learning.attendance_record')).rows,attendance);
  const journey=await f.service.getStudentCourseJourney({publicToken:f.published.publicToken,studentRef:student.studentRef,identityConfirmed:true});
  const lesson=journey.sessions.find(s=>s.sessionNumber===3);assert.equal(lesson.erpSessionId,'45');assert.equal(lesson.sessionDate,'2026-10-19');assert.equal(lesson.sessionStartTime,'19:00:00');assert.equal(lesson.scheduleStatus,'connected');
  const plan=await f.service.getTeacherJourneyPlan({classId:'2139',reviewer});assert.equal(plan.sessionDates[0].date,'2026-10-19');assert.equal(plan.sessionDates[0].erpSessionId,'45');
 }finally{await f.close();}
});
test('cùng ID nhưng hủy/mất buổi hoặc trùng nguồn vẫn chặn và giữ nháp',async()=>{
 const f=await setup();try{
  const student=f.assignment.roster[0];await f.start(student);
  for(const rows of [[row('45','2026-10-19',2)],[row('46','2026-10-19')],[row('45','2026-10-19'),row('45','2026-10-19')]]){
   f.rows=rows;await assert.rejects(()=>f.start(student),{code:'ERP_SESSION_REVIEW_REQUIRED'});
  }
  assert.equal((await f.pool.query('SELECT count(*)::int n FROM learning.attempt')).rows[0].n,1);
 }finally{await f.close();}
});
