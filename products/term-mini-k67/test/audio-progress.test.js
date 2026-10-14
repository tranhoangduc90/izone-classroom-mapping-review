import assert from 'node:assert/strict';
import test, {before, after} from 'node:test';
import request from 'supertest';
import {randomUUID} from 'node:crypto';
import {createMiniFixture} from './helpers/mini-answer-sheet-fixture.js';

// Dùng ứng dụng/SQL thật với người và đề giả; đọc lại mốc/hạn thay vì tin HTTP 200.
const slugs=['term-test-1','term-test-2','mini-test-lesson-5'];
const ref='11111111-1111-4111-8111-111111111111';
const assets={supports:s=>slugs.includes(s),getTiming:()=>({listeningDurationSeconds:120,listeningTotalSeconds:240,readingDurationMinutes:20}),
  getContent:async slug=>({baseTestSlug:slug}),getSessionAudioKey:()=>Buffer.alloc(32)};
let f,api;
before(async()=>{
  f=await createMiniFixture({examOrder:true,assets});api=request(f.app);
  for(const slug of slugs.slice(0,2))await f.db.query(`INSERT INTO assessment.test_definition
    (slug,title,version,listening_definition,reading_definition,is_active)
    SELECT $1,$1,1,listening_definition,reading_definition,true FROM assessment.test_definition WHERE slug='mini-test-lesson-5'`,[slug]);
});
after(async()=>f?.db.close());
const post=(path,data)=>api.post(path).send({...data,orderClientVersion:1});
async function started(slug,mode){
  await f.db.exec(`UPDATE mapping.k67_context_state SET captured_at=now();
    UPDATE assessment.term_test_exam_session SET attempt_id=NULL;UPDATE assessment.term_test_attempt SET exam_session_id=NULL;
    DELETE FROM assessment.term_test_attempt;DELETE FROM assessment.term_test_exam_session;`);
  const base=`/api/term-tests/${slug}`;
  const prepared=await post(base+'/session/prepare',{classCode:'IC2304',studentRef:ref,examMode:mode,examDelivery:'cbt'});
  assert.ok([200,201].includes(prepared.status),JSON.stringify(prepared.body));
  const token={examSessionToken:prepared.body.examSessionToken,attemptToken:prepared.body.attemptToken,generation:0};
  if(mode==='read_first'){
    assert.equal((await post(base+'/reading/start',token)).status,200);
    assert.equal((await post(base+'/reading',{...token,answers:{14:'A'}})).status,200);
  }
  assert.equal((await post(base+'/session/start',{...token,audioEventId:randomUUID()})).status,200);
  return {base,token};
}
for(const slug of slugs)for(const mode of ['lis_first','read_first'])test(`${slug}/${mode}: lưu mốc thật, ngắt 30 giây và retry không bù hai lần`,async()=>{
  const {base,token}=await started(slug,mode);
  const progress=await post(base+'/session/audio-progress',{...token,heardSeconds:0,state:'playing',eventId:randomUUID()});
  assert.equal(progress.status,200,JSON.stringify(progress.body));
  await f.db.query(`UPDATE assessment.term_test_exam_session SET listening_started_at=now()-interval '100 seconds',
    listening_audio_checkpoint_seconds=70,listening_audio_checkpoint_at=now()-interval '30 seconds',listening_audio_state='pause' WHERE id=$1`,[token.examSessionToken]);
  const eventId=randomUUID();
  const body={...token,heardSeconds:70,state:'recovered',eventId};
  const recovery=await post(base+'/session/audio-progress',body);
  assert.equal(recovery.status,200,JSON.stringify(recovery.body));
  assert.equal(recovery.body.listeningResumeAtSeconds,70);
  assert.ok(recovery.body.grantedRecoverySeconds>=29&&recovery.body.grantedRecoverySeconds<=31);
  const deadline=recovery.body.listeningDeadlineAt;
  await f.db.query(`UPDATE assessment.term_test_exam_session SET listening_audio_checkpoint_at=now()-interval '20 seconds' WHERE id=$1`,[token.examSessionToken]);
  const retry=await post(base+'/session/audio-progress',body);
  assert.equal(retry.status,200);assert.equal(retry.body.listeningDeadlineAt,deadline);
  assert.equal(retry.body.grantedRecoverySeconds,0);
  const row=(await f.db.query('SELECT listening_audio_checkpoint_seconds,listening_deadline_at,listening_recovery_seconds FROM assessment.term_test_exam_session WHERE id=$1',[token.examSessionToken])).rows[0];
  assert.equal(Number(row.listening_audio_checkpoint_seconds),70);
  assert.equal(new Date(row.listening_deadline_at).toISOString(),deadline);
  assert.equal(Number(row.listening_recovery_seconds),recovery.body.listeningRecoverySeconds);
});

test('Khôi phục song song và replay muộn chỉ bù một khoảng; mã sự kiện đổi dữ liệu bị từ chối',async()=>{
  const {base,token}=await started('term-test-1','read_first');
  await f.db.query(`UPDATE assessment.term_test_exam_session SET listening_started_at=now()-interval '100 seconds',
    listening_audio_checkpoint_seconds=70,listening_audio_checkpoint_at=now()-interval '30 seconds',listening_audio_state='pause' WHERE id=$1`,[token.examSessionToken]);
  const body={...token,state:'recovered',heardSeconds:70,eventId:randomUUID()};
  const replies=await Promise.all([post(base+'/session/audio-progress',body),post(base+'/session/audio-progress',body)]);
  assert.ok(replies.every(r=>r.status===200));
  const granted=replies.map(r=>r.body.grantedRecoverySeconds);assert.equal(granted.filter(x=>x>0).length,1);
  assert.ok(granted.reduce((a,b)=>a+b,0)>=29&&granted.reduce((a,b)=>a+b,0)<=31);
  const conflict=await post(base+'/session/audio-progress',{...body,heardSeconds:71});assert.equal(conflict.status,409);assert.equal(conflict.body.error,'AUDIO_EVENT_CONFLICT');
  const rows=(await f.db.query('SELECT granted_seconds FROM assessment.term_test_audio_recovery_event WHERE exam_session_id=$1 AND event_id=$2',[token.examSessionToken,body.eventId])).rows;
  assert.equal(rows.length,1);assert.equal(rows[0].granted_seconds,Math.max(...granted));
});

test('Không tua vượt, không lùi checkpoint, không bù sau audio kết thúc và giữ trần 900 giây',async()=>{
  const {base,token}=await started('term-test-1','lis_first');
  const send=(heardSeconds,state='playing')=>post(base+'/session/audio-progress',{...token,heardSeconds,state,eventId:randomUUID()});
  const fast=await send(5000);assert.equal(fast.status,200);assert.ok(fast.body.listeningResumeAtSeconds<=4);
  await f.db.query(`UPDATE assessment.term_test_exam_session SET listening_started_at=now()-interval '1100 seconds',
    listening_audio_checkpoint_seconds=50,listening_audio_checkpoint_at=now()-interval '30 seconds',listening_audio_state='pause',listening_recovery_seconds=890 WHERE id=$1`,[token.examSessionToken]);
  const capped=await send(50,'recovered');assert.equal(capped.body.grantedRecoverySeconds,10);assert.equal(capped.body.listeningRecoverySeconds,900);
  const stale=await send(40);assert.equal(stale.body.listeningResumeAtSeconds,50);assert.equal(stale.body.listeningDeadlineAt,capped.body.listeningDeadlineAt);
  await f.db.query(`UPDATE assessment.term_test_exam_session SET listening_audio_checkpoint_seconds=120,
    listening_audio_checkpoint_at=now()-interval '30 seconds',listening_audio_state='pause',listening_recovery_seconds=0 WHERE id=$1`,[token.examSessionToken]);
  const ended=await send(120,'recovered');assert.equal(ended.body.grantedRecoverySeconds,0);
});

test('Sai input/token/bài/generation, bài giấy, chưa bắt đầu và phiên đã nộp/bị thay không được ghi',async()=>{
  const {base,token}=await started('term-test-1','lis_first');
  const body={...token,heardSeconds:0,state:'playing',eventId:randomUUID()};
  for(const patch of [{heardSeconds:-1},{heardSeconds:'10'},{state:'khác'},{eventId:'sai'}]){
    assert.equal((await post(base+'/session/audio-progress',{...body,...patch})).status,400);
  }
  for(const patch of [{examSessionToken:randomUUID()},{generation:1}])assert.equal((await post(base+'/session/audio-progress',{...body,...patch})).status,409);
  assert.equal((await post('/api/term-tests/term-test-2/session/audio-progress',body)).status,409);
  for(const change of ["listening_started_at=NULL,listening_deadline_at=NULL","attempt_mode='answer_sheet'","listening_submitted_at=now()","superseded_at=now()"]){
    const snapshot=(await f.db.query('SELECT * FROM assessment.term_test_exam_session WHERE id=$1',[token.examSessionToken])).rows[0];
    await f.db.query(`UPDATE assessment.term_test_exam_session SET ${change} WHERE id=$1`,[token.examSessionToken]);
    const before=(await f.db.query('SELECT listening_audio_checkpoint_at,listening_recovery_seconds FROM assessment.term_test_exam_session WHERE id=$1',[token.examSessionToken])).rows[0];
    assert.equal((await post(base+'/session/audio-progress',body)).status,409);
    assert.deepEqual((await f.db.query('SELECT listening_audio_checkpoint_at,listening_recovery_seconds FROM assessment.term_test_exam_session WHERE id=$1',[token.examSessionToken])).rows[0],before);
    await f.db.query(`UPDATE assessment.term_test_exam_session SET listening_started_at=$2,attempt_mode=$3,listening_submitted_at=$4,superseded_at=$5,listening_deadline_at=$6 WHERE id=$1`,
      [token.examSessionToken,snapshot.listening_started_at,snapshot.attempt_mode,snapshot.listening_submitted_at,snapshot.superseded_at,snapshot.listening_deadline_at]);
  }
});

test('Lượt cũ chưa có mốc không tự được bù toàn thời gian; checkpoint không dùng quota autosave',async()=>{
  const {base,token}=await started('term-test-1','read_first');
  await f.db.query(`UPDATE assessment.term_test_exam_session SET listening_started_at=now()-interval '100 seconds',
    listening_audio_checkpoint_at=NULL,listening_audio_checkpoint_seconds=0 WHERE id=$1`,[token.examSessionToken]);
  const r=await post(base+'/session/audio-progress',{...token,heardSeconds:70,state:'recovered',eventId:randomUUID()});
  assert.equal(r.body.grantedRecoverySeconds,0);assert.equal(r.body.listeningResumeAtSeconds,70);
  const a=await post(base+'/listening/draft',{...token,revision:1,answers:{11:'A'}});
  for(let i=0;i<5;i++)assert.equal((await post(base+'/session/audio-progress',{...token,heardSeconds:70,state:'playing'})).status,200);
  const b=await post(base+'/listening/draft',{...token,revision:2,answers:{11:'A'}});
  assert.equal(a.status,200);assert.equal(b.status,200);
  const remaining=r=>Number(/"600-in-1min"; r=(\d+)/.exec(r.headers.ratelimit)[1]);
  assert.equal(remaining(a)-remaining(b),1);
});

test('Reload/start của cả hai thứ tự trả đúng mốc và hạn đã bù; đã nộp không bị mở lại',async()=>{
  for(const mode of ['lis_first','read_first']){
    const {base,token}=await started('term-test-1',mode);
    await f.db.query(`UPDATE assessment.term_test_exam_session SET listening_started_at=now()-interval '100 seconds',
      listening_audio_checkpoint_seconds=70,listening_audio_checkpoint_at=now()-interval '30 seconds',listening_audio_state='pagehide' WHERE id=$1`,[token.examSessionToken]);
    const data={...token,heardSeconds:70,audioEventId:randomUUID()};
    const resumed=await post(base+'/session/start',data);assert.equal(resumed.status,200,JSON.stringify(resumed.body));
    assert.equal(resumed.body.listeningResumeAtSeconds,70);assert.ok(resumed.body.listeningRecoverySeconds>=29);
    const retry=await post(base+'/session/start',data);assert.equal(retry.body.listeningDeadlineAt,resumed.body.listeningDeadlineAt);
    await f.db.query('UPDATE assessment.term_test_exam_session SET listening_submitted_at=now() WHERE id=$1',[token.examSessionToken]);
    const before=(await f.db.query('SELECT listening_recovery_seconds,listening_submitted_at,listening_deadline_at FROM assessment.term_test_exam_session WHERE id=$1',[token.examSessionToken])).rows[0];
    const locked=await post(base+'/session/audio-progress',{...token,state:'recovered',heardSeconds:70,eventId:randomUUID()});assert.equal(locked.status,409);
    assert.deepEqual((await f.db.query('SELECT listening_recovery_seconds,listening_submitted_at,listening_deadline_at FROM assessment.term_test_exam_session WHERE id=$1',[token.examSessionToken])).rows[0],before);
  }
});

test('11 học viên đồng thời lưu đúng mốc riêng bằng role ứng dụng, không lẫn phiên hoặc dùng quota nháp',async()=>{
  await started('term-test-1','lis_first');
  const tokens=[];
  for(let i=0;i<11;i++){
    const ref=randomUUID();await f.db.query(`INSERT INTO mapping.student_mapping_review VALUES($1,1293,$2,'Học viên tải giả','approved')`,[ref,9900000+i]);
    const opened=await post('/api/term-tests/term-test-1/session/prepare',{classCode:'IC2304',studentRef:ref});assert.ok([200,201].includes(opened.status));
    const token=opened.body.examSessionToken;tokens.push(token);
    assert.equal((await post('/api/term-tests/term-test-1/session/start',{examSessionToken:token,audioEventId:randomUUID()})).status,200);
    await f.db.query(`UPDATE assessment.term_test_exam_session SET listening_started_at=now()-interval '20 seconds' WHERE id=$1`,[token]);
  }
  const replies=await Promise.all(tokens.map((token,i)=>post('/api/term-tests/term-test-1/session/audio-progress',{examSessionToken:token,heardSeconds:i+1,state:'playing'})));
  assert.ok(replies.every(r=>r.status===200));
  for(let i=0;i<tokens.length;i++){
    const row=(await f.db.query('SELECT listening_audio_checkpoint_seconds,listening_recovery_seconds FROM assessment.term_test_exam_session WHERE id=$1',[tokens[i]])).rows[0];
    assert.equal(Number(row.listening_audio_checkpoint_seconds),i+1);assert.equal(Number(row.listening_recovery_seconds),0);
  }
});
