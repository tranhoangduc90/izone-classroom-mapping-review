import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers.js';
import {authoredLesson,registerAuthoredLesson} from '../src/authored-content.js';
import {CODE,emptyDraft,secret,uuid} from '../src/domain.js';

// Hồi quy lỗi chuyển tab: SQL thật trong bộ nhớ, người và nội dung giả.
// Kiểm thời gian/nháp/lượt qua service; không dùng key thật hoặc Google.
const C10='67-practice-listening_c20_t3_p4_inclusive_design';
const FULL='67-practice-listening_full-recovery-fixture';
registerAuthoredLesson({code:FULL,title:'Full recovery fixture',lesson:78,totalMs:720000,audioMs:600000,reviewMs:120000,
 paragraphs:['P1','P2','P3','P4'],groups:[1,2,3,4].map(n=>({id:'part'+n,kind:'completion',label:'Notes',start:(n-1)*10+1,end:n*10})),
 parts:[1,2,3,4].map(n=>({id:'part'+n,title:'Part '+n,start:(n-1)*10+1,end:n*10,startMs:(n-1)*150000,endMs:n*150000}))});
async function setup(code){
 const f=await fixture();let token=f.token;
 if(code!==CODE){
  const lesson=authoredLesson(code),paragraphs=Object.fromEntries(lesson.paragraphs.map(p=>[p,'Fixture evidence.']));
  const groups=lesson.groups.map(g=>({...g,instruction:'Write ONE WORD.',maxWords:1,questions:Array.from({length:g.end-g.start+1},(_,i)=>({n:g.start+i,text:'Fixture ___.'}))}));
  const p={runs:[{text:'Fixture'}]},key=Object.fromEntries(lesson.questionIds.map(n=>[n,['fixture']]));
  const bundle={code,version:'recovery-fixture-v1',totalMs:lesson.totalMs,key,
   definition:{authored:true,lesson,groups,mcq:[],audio:{durationMs:lesson.audioMs,sha256:'1'.repeat(64)}},
   explanations:{passage:paragraphs,entries:Object.fromEntries(lesson.questionIds.map(n=>[n,{number:+n,kind:'completion',answer:key[n],prompt:p,reason:[p],evidenceGroups:[{paragraph:lesson.paragraphs[0],paragraphs:[p],marks:[{start:0,end:7}]}]}]))}};
  await f.service.seedContent(bundle);const entryToken=secret();
  await f.service.register({...f.registration,code,contentVersion:bundle.version,documentId:'recovery_fixture_doc_123456789',entryToken});
  await f.pool.query("UPDATE listening_practice.assignment SET status='open'");await f.pool.query('UPDATE listening_practice.binding SET cta_verified_at=now()');
  token=(await f.service.login({entryToken,studentRef:f.studentRef,classCode:f.registration.classCode})).token;
 }
 const start=await f.service.begin({token,owner:'device1',operationId:uuid()}),id=start.attempts.at(-1).id;
 await f.service.activate({token,attemptId:id,lease:start.lease});
 const d=emptyDraft(code),input={token,attemptId:id,lease:start.lease};
 async function advance(ms){for(let rest=ms;rest>0;){const dt=Math.min(5000,rest);rest-=dt;f.advance(dt);d.sequence++;d.activeMs+=dt;d.audioPosition+=dt/1000;await f.service.pulse({...input,snapshot:structuredClone(d)});}}
 return{...f,token,start,id,d,input,advanceListening:advance};
}
for(const [label,code] of [['Buổi 8',CODE],['Buổi 10',C10],['Full 4 part',FULL]]){
 test(`${label}: Pause đối soát audio từ snapshot đã lưu khi ACK tính thời gian khác mốc`,async()=>{
  const f=await setup(code);try{
   await f.advanceListening(50000);f.advance(5908);
   Object.assign(f.d,{sequence:f.d.sequence+1,activeMs:54816,audioPosition:54.776439});
   const saved=await f.service.pulse({...f.input,snapshot:structuredClone(f.d)});
   assert.equal(saved.attempts.at(-1).usedMs,55908);
   f.advance(2849);Object.assign(f.d,{sequence:f.d.sequence+1,activeMs:57665,audioPosition:57.625596,notes:'Nháp trước khi rời cửa sổ'});
   const paused=await f.service.pause({...f.input,snapshot:structuredClone(f.d)}),a=paused.attempts.at(-1);
   assert.equal(a.progressRecovery,undefined);assert.equal(a.id,f.id);assert.equal(a.no,1);
   assert.ok(Math.abs(a.usedMs-57625.596)<.001);assert.equal(a.audioPosition,57.625596);assert.equal(a.notes,f.d.notes);
   f.advance(60000);const resumed=await f.service.resume({token:f.token,attemptId:f.id,owner:'device1',operationId:uuid(),recovery:{lease:f.input.lease,snapshot:f.d}});
   assert.ok(resumed.lease);assert.ok(Math.abs(resumed.attempts.at(-1).usedMs-57625.596)<.001);assert.equal(resumed.attempts.length,1);
  }finally{await f.close();}
 });
 test(`${label}: Tiếp tục phục hồi được trạng thái kẹt cũ mà không Reset hoặc cộng giờ vắng`,async()=>{
  const f=await setup(code);try{
   await f.advanceListening(50000);f.advance(5908);
   Object.assign(f.d,{sequence:f.d.sequence+1,activeMs:54816,audioPosition:54.776439});
   await f.service.pulse({...f.input,snapshot:structuredClone(f.d)});
   const row=(await f.pool.query('SELECT state FROM listening_practice.work WHERE binding_id=$1',[f.start.identity.bindingId])).rows[0],a=row.state.attempts.at(-1);
   a.status='paused';a.lease.activationCancelled=true;a.progressRecovery={code:'PROGRESS_RESYNC_REQUIRED',reason:'AUDIO_POSITION_INVALID',reportedAudioPosition:57.625596,reportedActiveMs:57665,reportedPhase:'listening'};
   await f.pool.query('UPDATE listening_practice.work SET state=$2 WHERE binding_id=$1',[f.start.identity.bindingId,row.state]);
   Object.assign(f.d,{sequence:f.d.sequence+1,activeMs:57665,audioPosition:57.625596,notes:'Nháp đang kẹt vẫn được giữ'});
   f.advance(86400000);const resumed=await f.service.resume({token:f.token,attemptId:f.id,owner:'device1',operationId:uuid(),recovery:{lease:f.input.lease,snapshot:f.d}}),after=resumed.attempts.at(-1);
   assert.equal(after.progressRecovery,undefined);assert.ok(resumed.lease);assert.equal(after.id,f.id);assert.equal(after.no,1);
   assert.ok(Math.abs(after.usedMs-57625.596)<.001);assert.equal(after.audioPosition,57.625596);assert.equal(after.notes,f.d.notes);assert.equal(resumed.attempts.length,1);
  }finally{await f.close();}
 });
 test(`${label}: gián đoạn 9 giây giữ nháp/lượt 1, nghỉ lâu không mất giờ, tự nộp một lần`,async()=>{
  const f=await setup(code);try{
   await f.advanceListening(10000);f.advance(9000);f.d.sequence++;f.d.activeMs+=9000;f.d.audioPosition+=9;
   const q=Object.keys(f.d.answers)[0]||String(f.d.activeQuestion);f.d.answers[q]='fixture';f.d.notes='Ghi chú chưa ACK';
   const paused=await f.service.pause({...f.input,snapshot:f.d});let a=paused.attempts.at(-1);
   assert.equal(a.usedMs,19000);assert.equal(a.audioPosition,19);assert.equal(a.status,'paused');assert.equal(a.notes,f.d.notes);
   f.advance(86400000);const resumed=await f.service.resume({token:f.token,attemptId:f.id,owner:'device1',operationId:uuid(),recovery:{lease:f.input.lease,snapshot:f.d}});
   a=resumed.attempts.at(-1);assert.equal(a.id,f.id);assert.equal(a.no,1);assert.equal(a.usedMs,19000);assert.deepEqual(a.answers,f.d.answers);
   const op={token:f.token,attemptId:f.id,lease:resumed.lease,snapshot:{...f.d,activeMs:0},method:'manual',operationId:uuid()};
   const submitted=await f.service.submit(op),again=await f.service.submit(op);
   assert.equal(submitted.attempts.length,1);assert.equal(submitted.attempts[0].status,'submitted');assert.deepEqual(again,submitted);
  }finally{await f.close();}
 });
 test(`${label}: tiến độ không xác minh được vẫn lưu nội dung và không tự phát/nộp`,async()=>{
  const f=await setup(code);try{
   await f.advanceListening(10000);f.advance(30000);f.d.sequence++;f.d.activeMs+=30000;f.d.audioPosition+=30;f.d.answers[String(f.d.activeQuestion)]='new answer';f.d.notes='Nội dung phải còn';
   const response=await f.service.resume({token:f.token,attemptId:f.id,owner:'device1',operationId:uuid(),recovery:{lease:f.input.lease,snapshot:f.d}});
   const a=response.attempts.at(-1);assert.equal(response.lease,undefined);assert.equal(a.status,'paused');assert.equal(a.usedMs,10000);assert.equal(a.audioPosition,10);
   assert.equal(a.progressRecovery.code,'PROGRESS_RESYNC_REQUIRED');assert.deepEqual(a.answers,f.d.answers);assert.equal(a.notes,f.d.notes);assert.equal(a.no,1);
   const again=await f.service.submit({...f.input,snapshot:{...f.d,sequence:f.d.sequence+1},method:'manual',operationId:uuid()});
   assert.equal(again.attempts.at(-1).status,'paused');assert.equal(again.events.filter(e=>e.type==='completed').length,0);
  }finally{await f.close();}
 });
 test(`${label}: Reset thoát lỗi tiến độ nhưng giữ lịch sử, nháp và chống chiếm phiên`,async()=>{
  const f=await setup(code);try{
   await f.advanceListening(10000);f.advance(30000);f.d.sequence++;f.d.activeMs+=30000;f.d.audioPosition+=30;f.d.notes='Nháp lượt cũ';
   await assert.rejects(f.service.reset({...f.input,lease:{id:'wrong',token:'wrong'},snapshot:f.d,owner:'other',operationId:uuid()}),e=>e.code==='LEASE_LOST');
   const result=await f.service.reset({...f.input,snapshot:f.d,owner:'device1',operationId:uuid()});
   assert.equal(result.attempts.length,2);assert.equal(result.attempts[0].id,f.id);assert.equal(result.attempts[0].status,'reset');assert.equal(result.attempts[0].notes,f.d.notes);
   assert.equal(result.attempts[1].no,2);assert.equal(result.attempts[1].audioPosition,0);assert.deepEqual(result.attempts[1].answers,{});
  }finally{await f.close();}
 });
 test(`${label}: không nhận tua, active giả hoặc cộng thời gian vắng trong recovery`,async()=>{
  const f=await setup(code);try{
   await f.advanceListening(10000);f.advance(9000);const bad={...f.d,sequence:f.d.sequence+1,audioPosition:19,activeMs:f.d.activeMs};
   const response=await f.service.pause({...f.input,snapshot:bad});assert.equal(response.attempts.at(-1).usedMs,10000);assert.equal(response.attempts.at(-1).audioPosition,10);assert.ok(response.attempts.at(-1).progressRecovery);
   f.advance(86400000);const saved=await f.service.read({token:f.token});assert.equal(saved.attempts.at(-1).usedMs,10000);
  }finally{await f.close();}
 });
 test(`${label}: gián đoạn qua cuối audio giữ thời gian rà đã dùng, không cấp lại 2 phút`,async()=>{
  const f=await setup(code);try{
   const duration=authoredLesson(code)?.audioMs||459207;await f.advanceListening(duration-3000);
   f.advance(9000);Object.assign(f.d,{sequence:f.d.sequence+1,activeMs:duration+6000,audioPosition:duration/1000,phase:'review'});
   const response=await f.service.pause({...f.input,snapshot:f.d}),a=response.attempts.at(-1);
   assert.equal(a.phase,'review');assert.equal(a.usedMs,duration+6000);assert.equal(a.reviewRemainingMs,114000);
   f.advance(3600000);const resumed=await f.service.resume({token:f.token,attemptId:f.id,owner:'device1',operationId:uuid()});
   assert.equal(resumed.attempts.at(-1).reviewRemainingMs,114000);assert.equal(resumed.attempts.at(-1).id,f.id);
  }finally{await f.close();}
 });
}
