import assert from 'node:assert/strict';
import test, {before, after} from 'node:test';
import request from 'supertest';
import {randomUUID} from 'node:crypto';
import {createMiniFixture} from './helpers/mini-answer-sheet-fixture.js';

// API và SQL thật với dữ liệu giả: bảo vệ thu bài, chống bù trùng và giữ đúng nháp.
// Không mô phỏng phép cộng giờ trong mock; đọc lại session/incident/attempt sau thao tác.
const slugs=['term-test-1','term-test-2','mini-test-lesson-5'];
const studentRef='11111111-1111-4111-8111-111111111111';
const assets={supports:s=>slugs.includes(s),getTiming:()=>({listeningDurationSeconds:120,listeningTotalSeconds:240,readingDurationMinutes:20}),
  getContent:async slug=>({baseTestSlug:slug}),getSessionAudioKey:()=>Buffer.alloc(32)};
let f,api;
before(async()=>{
  f=await createMiniFixture({examOrder:true,assets,audioProtection:true});api=request(f.app);
  for(const slug of slugs.slice(0,2))await f.db.query(`INSERT INTO assessment.test_definition
    (slug,title,version,listening_definition,reading_definition,is_active)
    SELECT $1,$1,1,listening_definition,reading_definition,true FROM assessment.test_definition WHERE slug='mini-test-lesson-5'`,[slug]);
});
after(async()=>f?.db.close());
const post=(path,data)=>api.post(path).send({...data,orderClientVersion:1});
async function start(slug='term-test-1',mode='lis_first',protocol=1){
  await f.db.exec(`UPDATE mapping.k67_context_state SET captured_at=now();
    UPDATE assessment.term_test_exam_session SET attempt_id=NULL;UPDATE assessment.term_test_attempt SET exam_session_id=NULL;
    DELETE FROM assessment.term_test_attempt;DELETE FROM assessment.term_test_exam_session;`);
  const base=`/api/term-tests/${slug}`;
  const prepared=await post(base+'/session/prepare',{classCode:'IC2304',studentRef,examMode:mode,examDelivery:'cbt'});
  assert.ok([200,201].includes(prepared.status),JSON.stringify(prepared.body));
  const token={examSessionToken:prepared.body.examSessionToken,attemptToken:prepared.body.attemptToken,generation:0};
  if(mode==='read_first'){
    assert.equal((await post(base+'/reading/start',token)).status,200);
    assert.equal((await post(base+'/reading',{...token,answers:{14:'A'}})).status,200);
  }
  const begun=await post(base+'/session/start',{...token,audioProtocolVersion:protocol,audioEventId:randomUUID()});
  assert.equal(begun.status,200,JSON.stringify(begun.body));
  if(protocol)assert.equal(begun.body.audioProtocolVersion,1,'Server phải công nhận bảo vệ trước khi UI sử dụng');
  return{base,token};
}
const session=async token=>(await f.db.query('SELECT * FROM assessment.term_test_exam_session WHERE id=$1',[token.examSessionToken])).rows[0];
const open=(base,token,eventId=randomUUID())=>post(base+'/session/audio-incident',{
  ...token,eventId,incidentId:eventId,heardSeconds:0,reason:'manual',answers:{11:'A'},draftRevision:2});
const submit=(base,token,id=randomUUID())=>post(base+'/listening',{
  ...token,classCode:'IC2304',studentRef,clientSubmissionId:id,answers:{11:'A'},draftRevision:3});
async function ageIncident(token,seconds){
  await f.db.query(`UPDATE assessment.term_test_audio_incident SET opened_at=clock_timestamp()-make_interval(secs=>$2::double precision)
    WHERE exam_session_id=$1 AND resolved_at IS NULL`,[token.examSessionToken,seconds]);
}
async function recover(base,token,incidentId){
  const resumeAttemptId=randomUUID();
  const prepared=await post(base+'/session/audio-resume',{...token,eventId:randomUUID(),incidentId,resumeAttemptId,phase:'prepare',heardSeconds:0});
  assert.equal(prepared.status,200,JSON.stringify(prepared.body));
  const body={...token,eventId:randomUUID(),incidentId,resumeAttemptId,phase:'confirm',heardSeconds:0.25};
  // Thời gian phía server vẫn được kiểm, không tin mỗi vị trí khách gửi.
  await f.db.query(`UPDATE assessment.term_test_audio_incident SET prepared_at=clock_timestamp()-interval '1 second' WHERE incident_id=$1`,[incidentId]);
  return{body,reply:await post(base+'/session/audio-resume',body)};
}
for(const slug of slugs)for(const mode of ['lis_first','read_first'])test(`${slug}/${mode}: báo lỗi → giữ bài sát hạn → phục hồi → bù một lần → nộp đúng nháp`,async()=>{
  const {base,token}=await start(slug,mode);
  await f.db.query(`UPDATE assessment.term_test_exam_session SET listening_deadline_at=clock_timestamp()+interval '1 second' WHERE id=$1`,[token.examSessionToken]);
  const before=await session(token),incidentId=randomUUID();
  const held=await open(base,token,incidentId);assert.equal(held.status,200,JSON.stringify(held.body));
  assert.equal(held.body.audioPhase,'holding');assert.equal(held.body.canSubmit,false);
  assert.equal((await session(token)).listening_draft['11'],'A');
  const denied=await submit(base,token);assert.equal(denied.status,409);assert.equal(denied.body.error,'AUDIO_INCIDENT_OPEN');
  assert.equal((await session(token)).listening_submitted_at,null);
  const draft=await post(base+'/listening/draft',{...token,revision:5,answers:{11:'B'}});
  assert.equal(draft.status,409);assert.equal((await session(token)).listening_draft['11'],'A');
  await ageIncident(token,30);
  const {body,reply}=await recover(base,token,incidentId);
  assert.equal(reply.status,200,JSON.stringify(reply.body));assert.equal(reply.body.audioPhase,'playing');
  assert.ok(reply.body.grantedRecoverySeconds>=29&&reply.body.grantedRecoverySeconds<=31);
  assert.equal(Date.parse(reply.body.listeningDeadlineAt)-new Date(before.listening_deadline_at).getTime(),reply.body.grantedRecoverySeconds*1000);
  const duplicate=await post(base+'/session/audio-resume',body);
  assert.equal(duplicate.status,200);assert.equal(duplicate.body.audioRevision,reply.body.audioRevision);
  assert.equal(duplicate.body.listeningDeadlineAt,reply.body.listeningDeadlineAt);
  const done=await submit(base,token);assert.ok([200,201].includes(done.status),JSON.stringify(done.body));
  const row=await session(token);assert.ok(row.listening_submitted_at);
  const attempt=(await f.db.query('SELECT listening_answers FROM assessment.term_test_attempt WHERE exam_session_id=$1',[token.examSessionToken])).rows;
  assert.equal(attempt.length,1);assert.equal(attempt[0].listening_answers['11'],'A');
});

test('Retry mở sự cố, confirm mất ACK, playing cũ và recovered cũ không đóng giữ bài hoặc cộng bù hai lần',async()=>{
  const{base,token}=await start(),id=randomUUID();
  const first=await open(base,token,id);assert.equal((await open(base,token,id)).body.audioRevision,first.body.audioRevision);
  const conflict=await post(base+'/session/audio-incident',{...token,incidentId:id,eventId:id,heardSeconds:1,reason:'manual',answers:{11:'A'},draftRevision:2});
  assert.equal(conflict.status,409);
  for(const state of ['playing','recovered']){
    const r=await post(base+'/session/audio-progress',{...token,heardSeconds:3,state,eventId:randomUUID()});
    assert.equal(r.status,200);assert.equal(r.body.audioPhase,'holding');assert.equal(r.body.listeningResumeAtSeconds,0);
  }
  await ageIncident(token,20);const{body,reply}=await recover(base,token,id);assert.equal(reply.status,200);
  const total=Number((await session(token)).listening_recovery_seconds);
  const duplicates=await Promise.all([post(base+'/session/audio-resume',body),post(base+'/session/audio-resume',body)]);
  assert.ok(duplicates.every(r=>r.status===200));assert.equal(Number((await session(token)).listening_recovery_seconds),total);
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM assessment.term_test_audio_incident WHERE exam_session_id=$1',[token.examSessionToken])).rows[0].n,1);
});

test('Prepare chưa phát, sai mốc confirm và vượt ngân sách đều giữ bài; giáo viên xử lý khi vượt 900 giây',async()=>{
  const{base,token}=await start(),id=randomUUID();await open(base,token,id);
  const resumeAttemptId=randomUUID();
  const prepared=await post(base+'/session/audio-resume',{...token,incidentId:id,eventId:randomUUID(),resumeAttemptId,phase:'prepare',heardSeconds:0});
  assert.equal(prepared.body.audioPhase,'holding');assert.equal((await submit(base,token)).status,409);
  const invalid=await post(base+'/session/audio-resume',{...token,incidentId:id,eventId:randomUUID(),resumeAttemptId,phase:'confirm',heardSeconds:10});
  assert.equal(invalid.status,409);assert.equal((await session(token)).listening_audio_incident_id,id);
  await ageIncident(token,901);
  const capped=await post(base+'/session/audio-resume',{...token,incidentId:id,eventId:randomUUID(),resumeAttemptId:randomUUID(),phase:'prepare',heardSeconds:0});
  assert.equal(capped.status,200);assert.equal(capped.body.needsTeacher,true);
  assert.equal(Number((await session(token)).listening_recovery_seconds),0);assert.equal((await submit(base,token)).status,409);
});

test('Giữ ngân sách còn lại, từ chối phiên/generation sai và không tự mở lại bài đã nộp',async()=>{
  const{base,token}=await start();
  const bad=await post(base+'/session/audio-incident',{...token,incidentId:randomUUID(),eventId:randomUUID(),heardSeconds:-1,reason:'manual'});assert.equal(bad.status,400);
  assert.equal((await open(base,{...token,generation:1})).status,409);
  assert.equal((await open('/api/term-tests/term-test-2',token)).status,409);
  await f.db.query('UPDATE assessment.term_test_exam_session SET listening_recovery_seconds=895 WHERE id=$1',[token.examSessionToken]);
  const id=randomUUID();await open(base,token,id);await ageIncident(token,4);
  const{reply}=await recover(base,token,id);assert.equal(reply.status,200);assert.equal(reply.body.needsTeacher,false);
  assert.ok(Number((await session(token)).listening_recovery_seconds)<=900);
  assert.ok([200,201].includes((await submit(base,token)).status));
  assert.equal((await open(base,token)).status,409);
});

test('Nộp đồng thời mở sự cố có một kết quả tuần tự; API không token không được đi vòng giữ bài',async()=>{
  const{base,token}=await start();
  const results=await Promise.all([open(base,token),submit(base,token)]);
  const row=await session(token);
  assert.ok((results[0].status===200&&results[1].status===409&&!row.listening_submitted_at)
    ||(results[0].status===409&&[200,201].includes(results[1].status)&&row.listening_submitted_at),JSON.stringify(results.map(r=>({status:r.status,body:r.body}))));
  if(row.listening_submitted_at){await start();}
  const current=(await f.db.query('SELECT id FROM assessment.term_test_exam_session LIMIT 1')).rows[0].id;
  const t={examSessionToken:current,generation:0};await open(base,t);
  const bypass=await submit(base,{});assert.equal(bypass.status,409);assert.equal(bypass.body.error,'AUDIO_INCIDENT_OPEN');
  assert.equal((await session(t)).listening_submitted_at,null);
});

test('Start/reload và audio-state giữ cùng sự cố; client cũ không tự đổi protocol giữa bài',async()=>{
  const{base,token}=await start(),id=randomUUID();await open(base,token,id);
  const reload=await post(base+'/session/start',{...token,audioProtocolVersion:1,audioEventId:randomUUID(),heardSeconds:0});
  assert.equal(reload.status,200);assert.equal(reload.body.activeIncident.incidentId,id);assert.equal(reload.body.audioPhase,'holding');
  const snapshot=await post(base+'/session/audio-state',token);assert.equal(snapshot.body.activeIncident.incidentId,id);
  const legacy=await start('term-test-1','lis_first',0);
  const again=await post(legacy.base+'/session/start',{...legacy.token,audioProtocolVersion:1});
  assert.equal(again.body.audioProtocolVersion,0,'Phiên đã bắt đầu bằng client cũ giữ nguyên protocol');
});

test('Đợi khóa qua deadline phải dùng thời gian sau khi có khóa và chuyển giáo viên',async()=>{
  const{base,token}=await start();
  await f.db.query(`UPDATE assessment.term_test_exam_session SET listening_deadline_at=clock_timestamp()+interval '0.8 seconds' WHERE id=$1`,[token.examSessionToken]);
  const lock=await f.pool.connect();await lock.query('BEGIN');
  await lock.query('SELECT id FROM assessment.term_test_exam_session WHERE id=$1 FOR UPDATE',[token.examSessionToken]);
  const pending=open(base,token).then(r=>r);
  await new Promise(resolve=>setTimeout(resolve,1100));await lock.query('COMMIT');lock.release();
  const held=await pending;assert.equal(held.status,200);assert.equal(held.body.needsTeacher,true);
  assert.equal(held.body.activeIncident.remainingMs,0);assert.equal((await submit(base,token)).status,409);
});

test('Client nộp không token trước khi báo lỗi không được tách bài khỏi phiên đang bảo vệ',async()=>{
  const{base,token}=await start();
  const legacy=await submit(base,{});assert.equal(legacy.status,409);assert.equal(legacy.body.error,'AUDIO_SESSION_REQUIRED');
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM assessment.term_test_attempt')).rows[0].n,0);
  assert.equal((await session(token)).listening_submitted_at,null);
  const held=await open(base,token);assert.equal(held.status,200);assert.equal(held.body.audioPhase,'holding');
});

test('Cờ mặc định tắt: client mới không tự bật bảo vệ trên server chưa cho phép',async()=>{
  const legacy=await createMiniFixture({examOrder:true,assets,audioProtection:false});
  try{
    const client=request(legacy.app),base='/api/term-tests/mini-test-lesson-5';
    const prepared=await client.post(base+'/session/prepare').send({classCode:'IC2304',studentRef});
    assert.ok([200,201].includes(prepared.status));
    const token={examSessionToken:prepared.body.examSessionToken};
    const begun=await client.post(base+'/session/start').send({...token,audioProtocolVersion:1});
    assert.equal(begun.status,200);assert.equal(begun.body.audioProtocolVersion,0);
    const denied=await client.post(base+'/session/audio-incident').send({...token,incidentId:randomUUID(),eventId:randomUUID(),heardSeconds:0,reason:'manual'});
    assert.equal(denied.status,409);assert.equal(denied.body.error,'AUDIO_PROTOCOL_REQUIRED');
  }finally{await legacy.db.close();}
});
