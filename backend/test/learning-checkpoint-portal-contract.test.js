// Kiểm job thật từ PostgreSQL qua adapter và mã xác thực workflow thật, Portal dùng dữ liệu giả.
// Giữ bằng chứng riêng cho ghi thành công, mất phản hồi và quyết định GV đổi trong lúc đang ghi.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { postgresFixture,publishedFixture } from './learning-postgres-fixture.js';
import { claimLearningJobs,processLearningJob } from '../src/learning-outbox.js';
import { createLearningAttendanceSync } from '../src/learning-attendance-sync.js';
import { createAttendanceBindingStore } from '../src/learning-attendance-binding.js';
const workflow=JSON.parse(await readFile(new URL('../workflows/progress-log-portal-attendance.json',import.meta.url),'utf8'));
const authCode=workflow.nodes.find(node=>node.name==='Xác thực và khóa identity').parameters.jsCode;
const secret='checkpoint-fixture-only';

for(const mode of ['normal','lost-response','teacher-before-dispatch','teacher-during-write']){
  test(`E08 Portal checkpoint: ${mode} — đúng nguồn và readback trạng thái cuối`,async()=>{
    const fixture=await postgresFixture({asApplication:true});
    try{
      const {assignment,inputs}=await publishedFixture(fixture),block=assignment.definition.blocks[0],input=inputs[0];
      const submitted=await fixture.service.submitCheckpoint({attemptToken:input.attemptToken,checkpointSubmissionId:crypto.randomUUID(),
        blockId:block.blockId,checkpoint:1,draftRevision:0,definitionHash:input.definitionHash,responses:{},idempotencyKey:crypto.randomUUID()});
      let writes=0,present=false;
      const store=createAttendanceBindingStore(fixture.pool);
      const reserve=store.reserve.bind(store);
      if(mode==='teacher-before-dispatch')store.reserve=async(...args)=>{
        const binding=await reserve(...args);
        // Dừng sau khi đã lưu ý định nhưng chưa gửi HTTP; GV hủy quyền ghi của worker cũ.
        await fixture.service.overrideAttendance({assignmentId:assignment.assignmentId,studentRef:assignment.roster[0].studentRef,
          status:'not_eligible',reason:'Điều chỉnh trước khi gửi lệnh ghi.',operationKey:crypto.randomUUID(),
          reviewer:{email:'teacher@example.test',canAccessAllClasses:false}});
        return binding;
      };
      const handler=createLearningAttendanceSync({pool:fixture.pool,bindingStore:store,config:{learningAttendanceSyncUrl:'https://fixture.test/portal',
        learningAttendanceSyncSecret:secret,learningAttendanceSyncTimeoutMs:1000},fetchImpl:async(_url,options)=>{
        const body=JSON.parse(options.body);
        assert.equal(body.submissionId,undefined);assert.equal(body.checkpointSubmissionId,submitted.checkpointSubmissionId);
        const sandbox={$input:{first:()=>({json:{headers:{'x-learning-attendance-sync':secret},body}})},$vars:{TERM_TEST_ERP_SYNC_SECRET:secret}};
        const checked=vm.runInNewContext(`(function(){${authCode}})()`,sandbox)[0].json;
        assert.equal(checked.teacherOverride,false);
        if(body.commit){
          writes++;present=true;
          if(mode==='lost-response'){const error=new Error('fixture timeout after write');error.name='TimeoutError';throw error;}
          if(mode==='teacher-during-write')await fixture.service.overrideAttendance({assignmentId:assignment.assignmentId,
            studentRef:assignment.roster[0].studentRef,status:'not_eligible',reason:'Đối chiếu khi yêu cầu đang bay.',
            operationKey:crypto.randomUUID(),reviewer:{email:'teacher@example.test',canAccessAllClasses:false}});
        }
        return {ok:true,async json(){return {ok:true,status:body.commit?'synced':present?'already_present':'resolved',
          entityKey:checked.entityKey,unitKey:checked.unitKey,operationKey:checked.operationKey,idempotencyKey:checked.idempotencyKey,
          classId:body.classId,studentId:body.studentId,sessionNumber:body.sessionNumber,targetSessionId:'35817',resolvedSessionId:'35817',
          bindingRevision:body.bindingRevision??null,scheduleFingerprint:'fixture-schedule',sessionDate:'2026-10-19'};}};
      }});
      const claim=async workerId=>(await claimLearningJobs({pool:fixture.pool,workerId,limit:1,leaseSeconds:90,jobTypes:['sync_portal_attendance']}))[0];
      const first=await claim('checkpoint-worker-1');
      await processLearningJob({pool:fixture.pool,workerId:'checkpoint-worker-1',job:first,handler});
      if(mode==='lost-response'){
        await fixture.pool.query("UPDATE learning.outbox_job SET next_attempt_at=now()-interval '1 second' WHERE id=$1::uuid",[first.id]);
        const retry=await claim('checkpoint-worker-2');
        assert.equal(retry.id,first.id);
        await processLearningJob({pool:fixture.pool,workerId:'checkpoint-worker-2',job:retry,handler});
      }
      assert.equal(writes,mode==='teacher-before-dispatch'?0:1,'Worker mất quyền trước dispatch không ghi; retry không ghi lần hai');
      const saved=(await fixture.pool.query('SELECT status,result_json FROM learning.outbox_job WHERE id=$1::uuid',[first.id])).rows[0];
      if(mode==='teacher-during-write'||mode==='teacher-before-dispatch'){
        assert.equal(saved.status,'review_required');
        assert.equal(saved.result_json.portalStatus,'write_outcome_unknown');
        assert.equal((await fixture.pool.query('SELECT status FROM learning.attendance_record')).rows[0].status,'not_eligible');
      }else{
        assert.equal(saved.status,'complete');
        assert.equal(saved.result_json.portalStatus,mode==='lost-response'?'already_present':'synced');
        const operation=(await fixture.pool.query('SELECT status,readback_at FROM learning.portal_attendance_operation')).rows[0];
        assert.ok(operation.readback_at);
      }
      assert.equal((await fixture.pool.query('SELECT count(*)::int AS n FROM learning.submission')).rows[0].n,0);
    }finally{await fixture.close();}
  });
}
