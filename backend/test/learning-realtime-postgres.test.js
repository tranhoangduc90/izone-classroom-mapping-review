// Chạy trên DB loopback riêng bằng learning_api; không nhận URL hoặc bài production.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import express from 'express';
import {readFile} from 'node:fs/promises';
import {postgresFixture,publishedFixture} from './learning-postgres-fixture.js';
import {createLearningService} from '../src/learning-service.js';
import {createLearningLiveUpdates} from '../src/learning-realtime.js';
import {reuseLearningQueryPlans,reuseTeacherSessionQueryPlans} from '../src/learning-query-plans.js';
import {createAuthService} from '../src/auth.js';

const teacher={email:'teacher@example.test',canAccessAllClasses:false};
const migration=await readFile(new URL('../ops/learning-migrations/202610230001_teacher_live_updates.sql',import.meta.url),'utf8');
async function setup(){
  const fixture=await postgresFixture({asApplication:true,studentCount:3});
  const pool=new pg.Pool({connectionString:fixture.pool.options.connectionString,max:5,options:'-c role=learning_api',application_name:'pl_v21_live'});
  reuseLearningQueryPlans(pool);
  const source=await publishedFixture(fixture);
  await fixture.pool.query(migration);
  const service=createLearningService({pool});
  return {...fixture,pool,admin:fixture.pool,service,source,async close(){await pool.end();await fixture.close();}};
}
const readerStates=new WeakMap();
async function nextEvent(reader,type,timeout=2500){
  const state=readerStates.get(reader)||{buffer:'',events:[]};readerStates.set(reader,state);
  let rejectTimeout;const deadline=new Promise((_,reject)=>{rejectTimeout=reject;});const timer=setTimeout(()=>rejectTimeout(Error('Không nhận được event '+type)),timeout);
  try{
    while(true){
      const found=state.events.findIndex(event=>event.type===type);if(found>=0)return state.events.splice(found,1)[0].data;
      const {value,done}=await Promise.race([reader.read(),deadline]);
      if(done)throw Error('Stream đóng trước event '+type);state.buffer+=new TextDecoder().decode(value);
      let end;while((end=state.buffer.indexOf('\n\n'))>=0){const record=state.buffer.slice(0,end);state.buffer=state.buffer.slice(end+2);
        const [name,data]=record.split('\ndata: ');if(name.startsWith('event: ')&&data)state.events.push({type:name.slice(7),data:JSON.parse(data)});}
    }
  }finally{clearTimeout(timer);}
}

test('Revision: nháp chỉ đọc delta đúng người; rollback không đổi mốc; role không sửa được revision',async()=>{
  const f=await setup(),live=createLearningLiveUpdates({pool:f.pool,service:f.service});
  try{
    const assignmentId=f.source.published.assignmentId,input=f.source.inputs[0],studentRef=f.source.assignment.roster[0].studentRef;
    const before=await live.read({assignmentId,reviewer:teacher,force:true});assert.equal(before.live.students.length,3);
    await f.service.saveDraft({...input,revision:1,responses:{[f.source.itemId]:'Nháp đã lưu'}});
    const after=await live.read({assignmentId,reviewer:teacher,after:before.revision});
    assert.ok(BigInt(after.revision)>BigInt(before.revision));assert.equal(after.live.partial,true);
    assert.deepEqual(after.live.students.map(s=>s.studentRef),[studentRef]);assert.equal(after.live.students[0].draftResponses[f.source.itemId],'Nháp đã lưu');
    assert.equal(after.analytics,undefined);assert.equal(after.dashboard,undefined);
    const tx=await f.admin.connect();try{await tx.query('BEGIN');await tx.query('UPDATE learning.attempt SET draft_revision=2 WHERE attempt_token=$1',[input.attemptToken]);await tx.query('ROLLBACK');}finally{tx.release();}
    const same=await live.read({assignmentId,reviewer:teacher,after:after.revision});assert.equal(same.revision,after.revision);assert.equal(same.live,undefined);
    await assert.rejects(f.pool.query('UPDATE learning.assignment_live_revision SET revision=999'),e=>e.code==='42501');
    await assert.rejects(live.read({assignmentId,reviewer:{email:'other@example.test',canAccessAllClasses:false},force:true}),e=>e.httpStatus===404);
    const checked=await f.admin.query('SELECT count(*)::int AS n FROM learning.attendance_record');assert.equal(checked.rows[0].n,0);
  }finally{await live.close();await f.close();}
});

test('Gom writer trong cùng transaction nhưng hai giao dịch đồng thời vẫn có hai mốc và đủ scope',async()=>{
  const f=await setup(),hub=createLearningLiveUpdates({pool:f.pool,service:f.service}),tx=await f.admin.connect();
  try{
    const assignmentId=f.source.published.assignmentId,before=await hub.read({assignmentId,reviewer:teacher,force:true});
    await tx.query('BEGIN');
    await tx.query('UPDATE learning.attempt SET draft_revision=2 WHERE attempt_token=$1',[f.source.inputs[0].attemptToken]);
    await tx.query('UPDATE learning.attempt SET draft_revision=3 WHERE attempt_token=$1',[f.source.inputs[0].attemptToken]);
    await tx.query('UPDATE learning.assignment_block_release SET status=\'locked\' WHERE assignment_id=$1',[assignmentId]);
    const current=(await tx.query('SELECT revision::text FROM learning.assignment_live_revision WHERE assignment_id=$1',[assignmentId])).rows[0].revision;
    assert.equal(BigInt(current),BigInt(before.revision)+1n);
    let completed=false;
    const second=f.service.saveDraft({...f.source.inputs[0],revision:4,responses:{[f.source.itemId]:'Nháp giao dịch sau'}}).then(()=>{completed=true;});
    await new Promise(done=>setTimeout(done,50));assert.equal(completed,false);
    await tx.query('COMMIT');await second;
    const after=await hub.read({assignmentId,reviewer:teacher,after:before.revision});
    assert.equal(BigInt(after.revision),BigInt(before.revision)+2n);
    assert.ok(after.dashboard);assert.equal(after.live.students[0].draftResponses[f.source.itemId],'Nháp giao dịch sau');
    assert.equal(after.analytics,undefined);
  }finally{await tx.query('ROLLBACK').catch(()=>{});tx.release();await hub.close();await f.close();}
});

test('Giới hạn rollout kiểm class ID tại máy chủ, không thay quyền hoặc chặn dashboard cũ',async()=>{
  const f=await setup();
  const classId=(await f.admin.query('SELECT erp_course_class_id::text AS id FROM learning.form_assignment WHERE id=$1',[f.source.published.assignmentId])).rows[0].id;
  const yes=createLearningLiveUpdates({pool:f.pool,service:f.service,classIds:[classId]}),no=createLearningLiveUpdates({pool:f.pool,service:f.service,classIds:['99999999']});
  try{
    const input={assignmentId:f.source.published.assignmentId,reviewer:teacher,force:true};
    assert.ok((await yes.read(input)).dashboard);
    await assert.rejects(no.read(input),error=>error.code==='LIVE_UPDATES_UNAVAILABLE');
    assert.equal((await f.service.getTeacherDashboard(input)).assignmentId,input.assignmentId);
    await assert.rejects(no.read({...input,reviewer:{email:'other@example.test',canAccessAllClasses:false}}),error=>error.httpStatus===404);
  }finally{await yes.close();await no.close();await f.close();}
});

test('Phiên dùng kế hoạch truy vấn lại vẫn kiểm tài khoản, thu hồi và hết hạn tại DB mỗi lần',async()=>{
  const f=await setup(),sessions=new pg.Pool({connectionString:f.admin.options.connectionString,max:2});reuseTeacherSessionQueryPlans(sessions);
  try{
    await f.admin.query(`ALTER TABLE mapping.reviewer_account ADD COLUMN display_name text,ADD COLUMN role text DEFAULT 'reviewer',ADD COLUMN can_access_all_classes boolean DEFAULT false,ADD COLUMN google_subject text;
      CREATE TABLE mapping.reviewer_session(token_hash bytea PRIMARY KEY,reviewer_email text,google_subject text,idle_expires_at timestamptz,absolute_expires_at timestamptz,last_seen_at timestamptz,revoked_at timestamptz);
      UPDATE mapping.reviewer_account SET google_subject='fixture-sub';`);
    const raw=crypto.randomBytes(32).toString('base64url'),hash=crypto.createHash('sha256').update(raw).digest();
    await f.admin.query(`INSERT INTO mapping.reviewer_session VALUES($1,$2,'fixture-sub',now()+interval '90 days',now()+interval '365 days',now(),NULL)`,[hash,teacher.email]);
    const auth=createAuthService({pool:sessions,config:{authMode:'google',nodeEnv:'test'}}),request={get:name=>name==='cookie'?'izone_teacher_session='+raw:''};
    assert.equal((await auth.revalidate(request)).email,teacher.email);assert.equal((await auth.revalidate(request)).email,teacher.email);
    await f.admin.query("UPDATE mapping.reviewer_account SET status='inactive'");assert.equal(await auth.revalidate(request),null);
    await f.admin.query("UPDATE mapping.reviewer_account SET status='active'; UPDATE mapping.reviewer_session SET revoked_at=now()");assert.equal(await auth.revalidate(request),null);
    await f.admin.query("UPDATE mapping.reviewer_session SET revoked_at=NULL,idle_expires_at=now()-interval '1 minute'");assert.equal(await auth.revalidate(request),null);
  }finally{await sessions.end();await f.close();}
});

test('Mất listener: đọc bù revision sau reconnect; thu hồi phiên gửi 401 và dừng stream',async()=>{
  const f=await setup();let valid=true;
  const hub=createLearningLiveUpdates({pool:f.pool,service:f.service,revalidate:async()=>valid?teacher:null,heartbeatMs:100,repairMs:100,coalesceMs:10});
  const app=express();app.get('/events',async(req,res,next)=>{req.reviewer=teacher;try{await hub.subscribe(req,res,{assignmentId:f.source.published.assignmentId});}catch(error){next(error);}});
  const server=app.listen(0,'127.0.0.1');await new Promise(done=>server.once('listening',done));const controller=new AbortController();
  try{
    const response=await fetch('http://127.0.0.1:'+server.address().port+'/events',{signal:controller.signal}),reader=response.body.getReader();
    const first=await nextEvent(reader,'change');
    await f.admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=current_database() AND application_name='pl_v21_live' AND query='LISTEN learning_teacher_live'");
    await nextEvent(reader,'unavailable');
    await f.service.saveDraft({...f.source.inputs[0],revision:1,responses:{[f.source.itemId]:'Giữ được sau ngắt listener'}});
    const caught=await nextEvent(reader,'change');assert.ok(BigInt(caught.revision)>BigInt(first.revision));
    const snapshot=await hub.read({assignmentId:f.source.published.assignmentId,reviewer:teacher,after:first.revision});
    assert.equal(snapshot.live.students[0].draftResponses[f.source.itemId],'Giữ được sau ngắt listener');
    valid=false;assert.equal((await nextEvent(reader,'access')).status,401);
  }finally{controller.abort();await hub.close();server.closeAllConnections();await new Promise(done=>server.close(done));await f.close();}
});

test('SSE: commit mới phát; nhiều màn chung một listener; thu hồi lớp chặn đọc và đóng stream',async()=>{
  const f=await setup();let valid=true;
  const hub=createLearningLiveUpdates({pool:f.pool,service:f.service,revalidate:async()=>valid?teacher:null,heartbeatMs:100,repairMs:150,coalesceMs:10});
  const app=express();app.get('/events',async(req,res,next)=>{req.reviewer=teacher;try{await hub.subscribe(req,res,{assignmentId:f.source.published.assignmentId});}catch(error){next(error);}});
  const server=app.listen(0,'127.0.0.1');await new Promise(done=>server.once('listening',done));
  const controllers=[new AbortController(),new AbortController()];
  try{
    const url='http://127.0.0.1:'+server.address().port+'/events';
    const responses=await Promise.all(controllers.map(c=>fetch(url,{signal:c.signal}))),readers=responses.map(r=>r.body.getReader());
    const first=await nextEvent(readers[0],'change');await nextEvent(readers[1],'change');
    assert.equal(hub.stats().streams,2);assert.equal(hub.stats().listeners,1);
    const tx=await f.admin.connect();
    try{await tx.query('BEGIN');await tx.query('UPDATE learning.attempt SET draft_revision=1 WHERE attempt_token=$1',[f.source.inputs[0].attemptToken]);
      const pending=await hub.read({assignmentId:f.source.published.assignmentId,reviewer:teacher,after:first.revision});assert.equal(pending.revision,first.revision);
      await tx.query('COMMIT');}finally{tx.release();}
    const change=await nextEvent(readers[0],'change');assert.ok(BigInt(change.revision)>BigInt(first.revision));
    await f.admin.query('DELETE FROM mapping.reviewer_class_access WHERE reviewer_email=$1',[teacher.email]);
    const denied=await nextEvent(readers[0],'access');assert.equal(denied.status,403);
    await assert.rejects(hub.read({assignmentId:f.source.published.assignmentId,reviewer:teacher}),e=>e.httpStatus===404);
    valid=false;
  }finally{controllers.forEach(c=>c.abort());await hub.close();server.closeAllConnections();await new Promise(done=>server.close(done));await f.close();}
});

test('Checkpoint/final giữ điểm danh sớm và analytics chỉ final; đọc cập nhật không nhân tác vụ',async()=>{
  const f=await setup(),hub=createLearningLiveUpdates({pool:f.pool,service:f.service});
  try{
    const {published,assignment,inputs}=f.source,assignmentId=published.assignmentId;
    const before=await hub.read({assignmentId,reviewer:teacher,force:true});
    const block=assignment.definition.blocks[0],key=crypto.randomUUID();
    const checkpoint=await f.service.submitCheckpoint({...inputs[0],checkpointSubmissionId:crypto.randomUUID(),blockId:block.blockId,checkpoint:block.checkpoint,draftRevision:0,responses:{},idempotencyKey:key});
    assert.equal(checkpoint.attendance.status,'self_confirmed');
    const middle=await hub.read({assignmentId,reviewer:teacher,after:before.revision});assert.equal(middle.analytics,undefined);
    await f.service.submit({...inputs[0],responses:{}});
    const final=await hub.read({assignmentId,reviewer:teacher,after:middle.revision});assert.equal(final.analytics.submittedCount,1);
    await hub.read({assignmentId,reviewer:teacher,force:true});await hub.read({assignmentId,reviewer:teacher,after:final.revision});
    const count=(await f.admin.query(`SELECT (SELECT count(*)::int FROM learning.attendance_record) AS attendance,
      (SELECT count(*)::int FROM learning.attendance_event) AS events,(SELECT count(*)::int FROM learning.outbox_job WHERE job_type='sync_portal_attendance') AS jobs`)).rows[0];
    assert.deepEqual(count,{attendance:1,events:1,jobs:1});
  }finally{await hub.close();await f.close();}
});
