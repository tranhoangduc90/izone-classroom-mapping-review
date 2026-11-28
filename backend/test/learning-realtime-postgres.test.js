// Chạy trên DB loopback riêng bằng learning_api; không nhận URL hoặc bài production.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import express from 'express';
import {readFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {postgresFixture,publishedFixture} from './learning-postgres-fixture.js';
import {createLearningService} from '../src/learning-service.js';
import {createLearningLiveUpdates} from '../src/learning-realtime.js';
import {reuseLearningQueryPlans,reuseTeacherSessionQueryPlans} from '../src/learning-query-plans.js';
import {createAuthService} from '../src/auth.js';
import {createLearningRouter} from '../src/learning-routes.js';

const teacher={email:'teacher@example.test',canAccessAllClasses:false};
const migration=await readFile(new URL('../ops/learning-migrations/202610230001_teacher_live_updates.sql',import.meta.url),'utf8');
const checkpointAnalyticsMigration=new URL('../ops/learning-migrations/202611270001_teacher_checkpoint_analytics.sql',import.meta.url);
async function setup(studentCount=3){
  const fixture=await postgresFixture({asApplication:true,studentCount});
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

async function startCheckpointApi(f, {draftAnalyticsClassIds=[]}={}) {
  const checkpointAnalyticsClassIds=['2139'];
  await f.admin.query(await readFile(checkpointAnalyticsMigration,'utf8'));
  const {published,assignment}=f.source;
  const block=assignment.definition.blocks[0], assignmentId=published.assignmentId;
  const app=express();
  app.use(express.json());
  const router=createLearningRouter({pool:f.pool,
    authenticate:(req,_res,next)=>{req.reviewer=teacher;next();},
    realtimeEnabled:true,revalidate:async()=>teacher,checkpointAnalyticsClassIds,draftAnalyticsClassIds});
  app.use(router);
  const server=app.listen(0,'127.0.0.1');
  await new Promise(done=>server.once('listening',done));
  const control=new AbortController();
  const base='http://127.0.0.1:'+server.address().port;
  const assignmentPath=base+'/teacher/assignments/'+assignmentId;
  const get=async url=>{
    const response=await fetch(url);
    assert.equal(response.status,200);
    return response.json();
  };
  const post=async(path,body,status)=>{
    const response=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const payload=await response.text();
    assert.equal(response.status,status,payload);
    return JSON.parse(payload);
  };
  return {assignmentId,assignmentPath,get,post,
    checkpointFor({attemptToken,definitionHash,responses},draftRevision=0){
      return {attemptToken,definitionHash,responses,checkpointSubmissionId:crypto.randomUUID(),
        blockId:block.blockId,checkpoint:block.checkpoint,draftRevision,idempotencyKey:crypto.randomUUID()};
    },
    async read(after='0',force=false){return (await get(assignmentPath+'/live-updates?view=overview&submittedParts=1&after='+after+'&force='+(force?'1':'0'))).update;},
    async stream(){return (await fetch(assignmentPath+'/events',{signal:control.signal})).body.getReader();},
    async close(){
      control.abort();
      await router.liveUpdates.close();
      server.closeAllConnections();
      await new Promise(done=>server.close(done));
    }};
}

test('HTTP và SSE ghi nhận từng Nộp phần trước final, kể cả mất thông báo và gửi lại',async()=>{
  const f=await setup();
  let api;
  try{
    api=await startCheckpointApi(f);
    const {assignmentId,assignmentPath,get,post,read,checkpointFor}=api;
    const {inputs,itemId}=f.source;
    const stream=await api.stream();
    await nextEvent(stream,'change');
    const before=await read('0',true);
    assert.equal(before.analytics.parts[0].submittedCount,0);
    await f.service.saveDraft({...inputs[0],revision:1});
    const draft=await read(before.revision);
    assert.equal(draft.analytics,undefined);
    let revision=draft.revision, first;
    for(const [index,input] of inputs.entries()){
      const checkpoint=checkpointFor(input,index===0?1:0);
      first ||= checkpoint;
      await post('/attempts/checkpoints/submit',checkpoint,201);
      const acknowledgedAt=performance.now();
      let event;
      do { event=await nextEvent(stream,'change'); } while(BigInt(event.revision)<=BigInt(revision));
      const updated=await read(revision);
      assert.equal(updated.analytics.parts[0].submittedCount,index+1);
      assert.equal(updated.analytics.items[0].counts.answered,index+1);
      assert.ok(performance.now()-acknowledgedAt<=2000,'ACK → revision → HTTP analytics');
      revision=updated.revision;
    }
    const detail=(await get(assignmentPath+'/question-analytics/'+itemId+'/responses?submittedParts=1')).detail;
    assert.equal(detail.students.length,3);
    assert.equal(detail.students.filter(row=>row.checkpointSubmissionId===first.checkpointSubmissionId).length,1);
    assert.equal((await post('/attempts/checkpoints/submit',first,201)).checkpointSubmission.replayed,true);
    assert.equal((await read(revision)).revision,revision);
    // Đọc lại từ mốc cũ khi client bỏ lỡ toàn bộ SSE.
    assert.equal((await read(before.revision)).analytics.submittedCount,3);
    assert.equal((await f.service.getQuestionAnalytics({assignmentId,reviewer:teacher})).submittedCount,0);
    assert.equal((await get(assignmentPath+'/question-analytics')).analytics.submittedCount,0);
    await post('/attempts/submit',{...inputs[0],draftRevision:1},200);
    const final=await read(revision);
    assert.equal(final.analytics.submittedCount,3);
    assert.equal(final.analytics.items[0].counts.answered,3);
    const result=(await f.admin.query(`SELECT (SELECT count(*)::int FROM learning.checkpoint_submission) AS checkpoints,
      (SELECT count(*)::int FROM learning.submission) AS finals,(SELECT count(*)::int FROM learning.attendance_record) AS attendance,
      (SELECT count(*)::int FROM learning.outbox_job WHERE job_type='sync_portal_attendance') AS jobs`)).rows[0];
    assert.deepEqual(result,{checkpoints:3,finals:1,attendance:3,jobs:3});
  }finally{
    await api?.close();
    await f.close();
  }
});

for (const studentCount of [16,30]) {
  test(`Nộp phần dồn ${studentCount} học viên: HTTP ACK → SSE → thống kê, đủ từng người`,async()=>{
    const f=await setup(studentCount);
    let api;
    try{
      api=await startCheckpointApi(f);
      const stream=await api.stream();
      await nextEvent(stream,'change');
      const before=await api.read('0',true);
      const ackByStudent=new Map(), visibleByStudent=new Map();
      const submits=f.source.inputs.map(async (input,index)=>{
        await api.post('/attempts/checkpoints/submit',api.checkpointFor(input),201);
        ackByStudent.set(f.source.assignment.roster[index].studentRef,performance.now());
      });
      const readAll=async()=>{
        let revision=before.revision;
        while(visibleByStudent.size<studentCount){
          const event=await nextEvent(stream,'change',5000);
          if(BigInt(event.revision)<=BigInt(revision))continue;
          await delay(250); // Cùng nhịp gộp ở controller giảng viên.
          const snapshot=await api.read(revision);
          const now=performance.now();
          for(const change of snapshot.changes){
            if(change.scope==='checkpoint_analytics'&&!visibleByStudent.has(change.studentRef))visibleByStudent.set(change.studentRef,now);
          }
          assert.equal(snapshot.analytics.parts[0].submittedCount,visibleByStudent.size);
          revision=snapshot.revision;
        }
      };
      await Promise.all([...submits,readAll()]);
      const times=[...ackByStudent].map(([ref,time])=>Math.max(0,visibleByStudent.get(ref)-time)).sort((a,b)=>a-b);
      const percentile=p=>Math.round(times[Math.ceil(p*times.length)-1]);
      console.log(JSON.stringify({scenario:'accepted_checkpoint_ack_to_teacher_snapshot',
        students:times.length,p50:percentile(.50),p95:percentile(.95),max:percentile(1)}));
      assert.equal(times.length,studentCount);
      assert.ok(times.every(Number.isFinite));
      assert.ok(percentile(.95)<=2000);
      const snapshot=await api.read('0',true);
      assert.equal(snapshot.analytics.items[0].counts.answered,studentCount);
      assert.equal(snapshot.analytics.submittedCount,studentCount);
    }finally{
      await api?.close();
      await f.close();
    }
  });
}

test('Bài nộp commit đến revision SSE và đường đọc bù; tổng quan khớp danh sách câu đang mở',async()=>{
  const f=await setup();
  const {published,itemId,inputs}=f.source;
  const assignmentId=published.assignmentId;
  const hub=createLearningLiveUpdates({pool:f.pool,service:f.service,revalidate:async()=>teacher});
  const app=express();
  app.get('/events',(req,res,next)=>{
    req.reviewer=teacher;
    hub.subscribe(req,res,{assignmentId}).catch(next);
  });
  const server=app.listen(0,'127.0.0.1');
  await new Promise(done=>server.once('listening',done));
  const control=new AbortController();
  try{
    const response=await fetch('http://127.0.0.1:'+server.address().port+'/events',{signal:control.signal});
    const stream=response.body.getReader();
    await nextEvent(stream,'change');
    const before=await hub.read({assignmentId,reviewer:teacher,force:true,view:'overview'});
    await f.service.saveDraft({...inputs[0],revision:1,responses:{[itemId]:'Nháp chưa nộp'}});
    const draft=await hub.read({assignmentId,reviewer:teacher,after:before.revision,view:'overview'});
    assert.equal(draft.analytics,undefined);
    await f.service.submit({...inputs[0],draftRevision:1});
    const acknowledgedAt=performance.now();
    const event=await nextEvent(stream,'change');
    assert.ok(BigInt(event.revision)>BigInt(before.revision));
    const fromSse=await hub.read({assignmentId,reviewer:teacher,after:before.revision,view:'overview'});
    const fromPoll=await hub.read({assignmentId,reviewer:teacher,after:draft.revision,view:'overview'});
    const detail=await f.service.getQuestionAnalytics({assignmentId,reviewer:teacher,itemVersionId:itemId});
    for(const snapshot of [fromSse,fromPoll]){
      assert.equal(snapshot.analytics.submittedCount,1);
      assert.equal(snapshot.analytics.items[0].responseVersion,detail.responseVersion);
      assert.deepEqual(snapshot.analytics.items[0].counts,detail.counts);
    }
    assert.equal(detail.students.length,1);
    assert.equal(detail.students[0].answer,inputs[0].responses[itemId]);
    assert.ok(performance.now()-acknowledgedAt<3000,'Đọc qua SSE phải đủ nhanh trong fixture');
  }finally{
    control.abort();await hub.close();server.closeAllConnections();
    await new Promise(done=>server.close(done));await f.close();
  }
});

test('Journey đọc cùng dữ liệu ở hai loại link bằng plan JIT riêng, trả setting cũ cả khi lỗi',async()=>{
  const f=await setup();
  const pool=new pg.Pool({connectionString:f.admin.options.connectionString,max:1,options:'-c role=learning_api -c jit=on -c plan_cache_mode=force_generic_plan'});
  reuseLearningQueryPlans(pool);
  try{
    const studentRef=f.source.assignment.roster[0].studentRef;
    const token=crypto.randomBytes(32).toString('base64url');
    const hash=crypto.createHash('sha256').update(token).digest('hex');
    const id=crypto.randomUUID();
    await f.admin.query(`INSERT INTO learning.student_progress_access
      (id,erp_course_class_id,student_ref,token_hash,expires_at,created_by_email,operation_key,idempotency_key)
      VALUES($1::uuid,2139,$2,$3,now()+interval '1 day',$4,$1::uuid::text,$1::uuid::text)`,[id,studentRef,hash,teacher.email]);
    const before=createLearningService({pool,journeyJitOff:false});
    const after=createLearningService({pool});
    const viaClass={publicToken:f.source.published.publicToken,studentRef};
    const stable=journey=>({...journey,sessions:journey.sessions.map(session=>session.submissionWindow
      ?{...session,submissionWindow:{...session.submissionWindow,serverNow:'clock'}}
      :session)});
    for(const input of [viaClass,{accessToken:token}]){
      const initial=await before.getStudentCourseJourney(input);
      for(let i=0;i<7;i++){
        const timing={};
        const optimized=await after.getStudentCourseJourney(input,timing);
        assert.deepEqual(stable(optimized),stable(initial));
        assert.ok(Number.isFinite(timing.poolWaitMs)&&Number.isFinite(timing.sqlMs));
      }
    }
    assert.equal((await pool.query('SHOW jit')).rows[0].jit,'on');
    const plans=await pool.query("SELECT generic_plans FROM pg_prepared_statements WHERE name LIKE 'journey_no_jit_%'");
    assert.equal(plans.rowCount,1);
    assert.ok(Number(plans.rows[0].generic_plans)>0);
    const realConnect=pool.connect.bind(pool);
    let fail=true;
    const unreliable={query:pool.query.bind(pool),async connect(){
      const client=await realConnect();
      return {release:error=>client.release(error),async query(sql,values){
        if(fail&&sql.startsWith('/* student journey')){
          fail=false;
          return client.query('SELECT 1/0');
        }
        return client.query(sql,values);
      }};
    }};
    const service=createLearningService({pool:unreliable});
    await assert.rejects(service.getStudentCourseJourney(viaClass),error=>error.code==='22012');
    assert.equal((await pool.query('SHOW jit')).rows[0].jit,'on');
    assert.equal((await service.getStudentCourseJourney(viaClass)).student.studentRef,studentRef);
  }finally{await pool.end();await f.close();}
});

test('Thống kê nháp theo HTTP và SSE thay đúng đáp án, nộp trống và không phát điểm danh từ nháp',async()=>{
  const f=await setup();
  let api;
  try{
    api=await startCheckpointApi(f,{draftAnalyticsClassIds:['2139']});
    const {itemId,inputs}=f.source;
    const [{attemptToken,definitionHash}]=inputs;
    const url=api.assignmentPath+'/live-updates?view=overview&submittedParts=1&draftAnalytics=1';
    const detailUrl=api.assignmentPath+'/question-analytics/'+itemId+'/responses?submittedParts=1&draftAnalytics=1';
    const stream=await api.stream();
    await nextEvent(stream,'change');
    let update=(await api.get(url+'&force=1')).update;
    assert.equal(update.analytics.draftAnalytics,true);
    const save=async (revision,responses,expectedStatus=200)=>{
      const response=await fetch(api.assignmentPath.split('/teacher/')[0]+'/attempts/draft',{method:'PATCH',
        headers:{'Content-Type':'application/json'},body:JSON.stringify({attemptToken,definitionHash,responses,revision})});
      assert.equal(response.status,expectedStatus);
      await response.arrayBuffer();
    };
    for(const [index,answer] of ['Mẫu A','Mẫu B',null,'Mẫu A'].entries()){
      const prior=update.revision;
      await save(index+1,answer ? {[itemId]:answer}: {});
      let event;
      do{event=await nextEvent(stream,'change');}while(BigInt(event.revision)<=BigInt(prior));
      update=(await api.get(url+'&after='+prior)).update;
      assert.equal(update.analytics.items[0].counts.draftAnswered,Number(Boolean(answer)));
      assert.equal(update.analytics.parts[0].draftCount,Number(Boolean(answer)));
      assert.equal(update.analytics.submittedCount,0);
      assert.equal(update.analytics.items[0].students,undefined);
      assert.ok(!JSON.stringify(update.analytics).includes('Mẫu A'));
      const detail=(await api.get(detailUrl)).detail;
      assert.equal(detail.responseVersion,update.analytics.items[0].responseVersion);
      assert.deepEqual(detail.students.map(row=>[row.responseStatus,row.answer]),answer ? [['draft',answer]]:[]);
      assert.equal((await api.read(prior)).analytics,undefined);
    }
    await save(3,{[itemId]:'Bản cũ'},409);
    assert.equal((await api.get(detailUrl)).detail.students[0].answer,'Mẫu A');
    assert.equal((await f.admin.query('SELECT count(*)::int n FROM learning.attendance_event')).rows[0].n,0);
    const checkpoint=api.checkpointFor({...inputs[0],responses:{}},4);
    await api.post('/attempts/checkpoints/submit',checkpoint,201);
    const after=(await api.get(url+'&after='+update.revision)).update.analytics;
    assert.equal(after.parts[0].submittedCount,1);
    assert.equal(after.items[0].counts.draftAnswered,0);
    assert.equal(after.items[0].counts.answered,0);
    const detail=(await api.get(detailUrl)).detail;
    assert.deepEqual(detail.students.map(row=>[row.responseStatus,row.answer]),[['submitted',null]]);
    assert.equal((await f.admin.query('SELECT count(*)::int n FROM learning.attendance_event')).rows[0].n,1);
  }finally{
    await api?.close();
    await f.close();
  }
});
