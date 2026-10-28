// Chạy toàn đường checkpoint → PostgreSQL/outbox → worker → HTTP → mã workflow
// → kho Portal giả có lưu thật → HTTP readback. Không có credential/đích production.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import crypto from 'node:crypto';
import vm from 'node:vm';
import {postgresFixture,publishedFixture} from './learning-postgres-fixture.js';
import {claimLearningJobs,processLearningJob} from '../src/learning-outbox.js';
import {createLearningAttendanceSync} from '../src/learning-attendance-sync.js';

const workflow=JSON.parse(await readFile(new URL('../workflows/progress-log-portal-attendance.json',import.meta.url),'utf8'));
const secret='portal-http-fixture-only';
const names={auth:'Xác thực và khóa identity',resolve:'Chọn đúng buổi và quyết định',verify:'Xác nhận Portal đã lưu',safe:'Chuẩn bị phản hồi an toàn'};
const nodes=new Map(workflow.nodes.map(n=>[n.name,n]));
const sessions=[1,2,3].map(n=>({class_session_id:35000+n,course_class_id:2139,status:1,
  session_start_datetime:`2026-10-${String(n*7).padStart(2,'0')}T18:00:00`,session_end_datetime:`2026-10-${String(n*7).padStart(2,'0')}T20:00:00`}));

for(const mode of ['synced','lost-response','conflict'])test(`Portal HTTP có lưu: ${mode}, đúng người/buổi và retry không ghi trùng`,
  {skip:!process.env.PROGRESS_LOG_FIXTURE_URL},async()=>{
  const fixture=await postgresFixture({asApplication:true});let server;
  try{
    const {assignment,inputs}=await publishedFixture(fixture),block=assignment.definition.blocks[0],input=inputs[0];
    const checkpoint=await fixture.service.submitCheckpoint({attemptToken:input.attemptToken,checkpointSubmissionId:crypto.randomUUID(),
      blockId:block.blockId,checkpoint:1,draftRevision:0,definitionHash:input.definitionHash,responses:{},idempotencyKey:crypto.randomUUID()});
    const claim=async workerId=>(await claimLearningJobs({pool:fixture.pool,workerId,limit:1,leaseSeconds:90,jobTypes:['sync_portal_attendance']}))[0];
    const job=await claim('http-worker-1');assert.equal(job.payload.checkpointSubmissionId,checkpoint.checkpointSubmissionId);
    assert.equal(job.payload.sessionNumber,3);
    await fixture.pool.query('CREATE TABLE portal_fixture(student_id bigint,class_session_id bigint,attendance_status int,homework_status int,note jsonb,PRIMARY KEY(student_id,class_session_id))');
    await fixture.pool.query(`INSERT INTO portal_fixture VALUES($1,35003,$2,2,'{"keep":"unchanged"}'),(99999,35003,2,3,'{}')`,[job.payload.studentId,mode==='conflict'?2:null]);
    let puts=0,lost=false,reads=0,syncCalls=0;const errors=[];
    const run=(name,json,outputs)=>vm.runInNewContext(`(function(){${nodes.get(name).parameters.jsCode}})()`,{
      $input:{first:()=>({json})},$vars:{TERM_TEST_ERP_SYNC_SECRET:secret},$:(n)=>({first:()=>({json:outputs[n]})})},{timeout:1000})[0].json;
    const expression=(value,outputs,json)=>{
      const context={$json:json,$:n=>({first:()=>({json:outputs[n]})})};
      const text=value.replace(/^=/,'');
      if(/^\{\{[\s\S]*\}\}$/.test(text))return vm.runInNewContext(text.slice(2,-2),context);
      return text.replace(/\{\{([\s\S]*?)\}\}/g,(_m,code)=>vm.runInNewContext(code,context));
    };
    let origin;
    const http=async(name,outputs,json)=>{
      const config=nodes.get(name).parameters;
      const url=new URL(expression(config.url,outputs,json));assert.equal(url.origin,'https://gateway.izone.edu.vn');
      const result=await fetch(origin+url.pathname,{method:config.method||'GET',headers:{'Content-Type':'application/json'},
        ...(config.sendBody?{body:JSON.stringify(expression(config.jsonBody,outputs,json))}:{})});
      assert.equal(result.status,200);return result.json();
    };
    server=createServer(async(req,res)=>{try{
      let raw='';for await(const data of req)raw+=data;const body=raw?JSON.parse(raw):null;
      if(req.url==='/sync'){
        syncCalls++;const outputs={};outputs[names.auth]=run(names.auth,{headers:req.headers,body},outputs);
        let data=await http('Đọc trạng thái lớp trên Portal',outputs,outputs[names.auth]);
        outputs[names.resolve]=run(names.resolve,data,outputs);data=outputs[names.resolve];
        if(data.needsWrite){await http('Ghi có mặt vào Portal',outputs,data);data=await http('Đọc lại sau khi ghi',outputs,data);data=run(names.verify,data,outputs);
          if(mode==='lost-response'&&!lost){lost=true;res.destroy();return;}}
        data=run(names.safe,data,outputs);res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(data));return;
      }
      assert.equal(req.url,'/portal/v1/course-classes/2139/student-class-sessions');
      if(req.method==='PUT'){
        puts++;assert.equal(body.student_class_sessions.length,1);const row=body.student_class_sessions[0];
        assert.equal(String(row.student_id),job.payload.studentId);assert.equal(row.class_session_id,35003);assert.equal(row.attendance_status,1);
        assert.equal(row.homework_status,2);assert.equal(row.note.keep,'unchanged');
        await fixture.pool.query('UPDATE portal_fixture SET attendance_status=$3 WHERE student_id=$1 AND class_session_id=$2',[row.student_id,row.class_session_id,row.attendance_status]);
        res.writeHead(200,{'Content-Type':'application/json'});res.end('{}');return;
      }
      reads++;const rows=(await fixture.pool.query('SELECT * FROM portal_fixture ORDER BY student_id')).rows;
      res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({data:rows,meta:{class_sessions:sessions}}));
    }catch(error){errors.push(error.message);res.writeHead(500);res.end('{}');}});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${server.address().port}`;
    const handler=createLearningAttendanceSync({pool:fixture.pool,config:{learningAttendanceSyncUrl:origin+'/sync',learningAttendanceSyncSecret:secret,learningAttendanceSyncTimeoutMs:1000}});
    await processLearningJob({pool:fixture.pool,workerId:'http-worker-1',job,handler});
    if(mode==='lost-response'){
      await fixture.pool.query("UPDATE learning.outbox_job SET next_attempt_at=now()-interval '1 second' WHERE id=$1",[job.id]);
      const retry=await claim('http-worker-2');assert.equal(retry.id,job.id);
      await processLearningJob({pool:fixture.pool,workerId:'http-worker-2',job:retry,handler});
    }
    const saved=(await fixture.pool.query('SELECT status,result_json FROM learning.outbox_job WHERE id=$1',[job.id])).rows[0];
    assert.equal(saved.status,mode==='conflict'?'review_required':'complete');
    assert.equal(saved.result_json.portalStatus,mode==='lost-response'?'already_present':mode);
    assert.equal(puts,mode==='conflict'?0:1);assert.ok(reads>=1);assert.ok(syncCalls>=1);assert.deepEqual(errors,[]);
    const portal=(await fixture.pool.query('SELECT * FROM portal_fixture WHERE student_id=$1',[job.payload.studentId])).rows[0];
    assert.equal(portal.attendance_status,mode==='conflict'?2:1);assert.equal(portal.homework_status,2);assert.equal(portal.note.keep,'unchanged');
    assert.equal((await fixture.pool.query('SELECT attendance_status FROM portal_fixture WHERE student_id=99999')).rows[0].attendance_status,2);
    const counts=(await fixture.pool.query(`SELECT (SELECT count(*)::int FROM learning.attendance_event) events,
      (SELECT count(*)::int FROM learning.outbox_job WHERE job_type='sync_portal_attendance') jobs,(SELECT count(*)::int FROM learning.submission) finals`)).rows[0];
    assert.deepEqual(counts,{events:1,jobs:1,finals:0});
    if(mode!=='conflict')assert.ok((await fixture.pool.query('SELECT readback_at FROM learning.portal_attendance_operation')).rows[0].readback_at);
  }finally{if(server)await new Promise(resolve=>server.close(resolve));await fixture.close();}
});
