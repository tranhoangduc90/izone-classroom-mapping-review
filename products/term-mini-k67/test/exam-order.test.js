import assert from 'node:assert/strict';
import test,{before,after} from 'node:test';
import request from 'supertest';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createApp} from '../src/app.js';
import {createMiniFixture} from './helpers/mini-answer-sheet-fixture.js';
const ref='11111111-1111-4111-8111-111111111111';
let fixture,api,synced=[];
const timings={ 'term-test-1':{readingMinutes:60,listeningTotalSeconds:1855,writingMinutes:40},
  'term-test-2':{readingMinutes:60,listeningTotalSeconds:1964,writingMinutes:60},
  'mini-test-lesson-5':{readingMinutes:20,listeningTotalSeconds:1092,writingMinutes:0}};
const assets={supports:slug=>Boolean(timings[slug]),getTiming:slug=>({...timings[slug],readingDurationMinutes:timings[slug].readingMinutes}),
  getContent:async slug=>({variant:'semantic-html',timing:timings[slug],listening:{},reading:{},writing:slug.startsWith('term')?{tasks:[]}:null}),
  getSessionAudioKey:()=>Buffer.alloc(32),getPreview:async()=>Buffer.from('preview-fixture'),
  streamEncryptedAudio:async(_slug,_token,res)=>res.send(Buffer.from('encrypted-fixture'))};
// Dữ liệu giả + SQL/constraint thật. Không gọi n8n, Portal hay database đang chạy.
before(async()=>{
  fixture=await createMiniFixture({examOrder:true,assets,syncErpGrades:async payload=>{synced.push(payload);return{status:'queued'};}});api=request(fixture.app);
  for(const slug of ['term-test-1','term-test-2'])await fixture.db.query(`INSERT INTO assessment.test_definition
    (slug,title,version,listening_definition,reading_definition,is_active)
    SELECT $1,$1,1,listening_definition,reading_definition,true FROM assessment.test_definition WHERE slug='mini-test-lesson-5'`,[slug]);
});
after(async()=>fixture?.db.close());
const post=(path,body)=>api.post(path).send({...body,orderClientVersion:1});
async function clean(){await fixture.db.exec('UPDATE mapping.k67_context_state SET captured_at=now();UPDATE assessment.term_test_exam_session SET attempt_id=NULL;UPDATE assessment.term_test_attempt SET exam_session_id=NULL;DELETE FROM assessment.term_test_attempt;DELETE FROM assessment.term_test_exam_session;');synced=[];}
async function open(slug,delivery='cbt'){
  const paper=slug==='mini-test-lesson-5'&&delivery==='answer_sheet';
  const base=`/api/term-tests/${slug}${paper?'/answer-sheet':''}`;
  const r=await post(`${base}/${paper?'open':'session/prepare'}`,{classCode:'IC2304',studentRef:ref,identityConfirmed:true,examMode:'read_first',examDelivery:delivery});
  assert.equal(r.status,200,JSON.stringify(r.body));return{base,paper,state:r.body};
}
for(const slug of Object.keys(timings))for(const delivery of ['cbt','answer_sheet'])test(`${slug} · ${delivery}: Reading trước, cùng lượt, hạn riêng, nộp lại không đổi điểm`,async()=>{
  await clean();const {base,paper,state}=await open(slug,delivery);
  const token={attemptToken:state.attemptToken,examSessionToken:state.examSessionToken,generation:state.generation};
  assert.equal(state.nextSection,'reading');assert.equal(state.listeningSubmitted,false);assert.equal(state.readingStartedAt,null);assert.equal(state.listeningStartedAt,null);
  const bad=await post(`${base}/${paper?'listening':'session/start'}`,{...token,answers:{11:'A'},clientSubmissionId:randomUUID()});assert.equal(bad.status,409);
  const start=await post(`${base}/reading/start`,token);assert.equal(start.status,200,JSON.stringify(start.body));
  assert.equal(start.body.listeningStartedAt,null);
  if(paper)assert.equal(start.body.readingDeadlineAt,null);
  else assert.equal((Date.parse(start.body.readingDeadlineAt)-Date.parse(start.body.readingStartedAt))/60000,timings[slug].readingMinutes);
  const draft=await post(`${base}/reading/draft`,{...token,revision:2,answers:{14:'A'}});assert.equal(draft.body.accepted,true);
  const stale=await post(`${base}/reading/draft`,{...token,revision:1,answers:{14:'B'}});assert.equal(stale.body.accepted,false);assert.deepEqual(stale.body.draft,{14:'A'});
  const reading=await post(`${base}/reading`,{...token,answers:{14:'A'},draftRevision:2});assert.equal(reading.status,200,JSON.stringify(reading.body));
  assert.equal(reading.body.completed,false);assert.equal(reading.body.next,'listening');assert.equal(reading.body.listeningStartedAt,null);assert.equal(reading.body.result,null);assert.equal(synced.length,0);
  const repeat=await post(`${base}/reading`,{...token,answers:{14:'B'}});assert.equal(repeat.body.next,'listening');
  const changed=await post(`${base}/${paper?'open':'session/prepare'}`,{classCode:'IC2304',studentRef:ref,identityConfirmed:true,examMode:'lis_first',examDelivery:delivery});
  assert.equal(changed.body.examMode,'read_first');assert.equal(changed.body.attemptToken,state.attemptToken);
  if(delivery==='cbt'){
    const listen=await post(`${base}/session/start`,token);assert.equal(listen.status,200,JSON.stringify(listen.body));
    assert.equal((Date.parse(listen.body.listeningDeadlineAt)-Date.parse(listen.body.listeningStartedAt))/1000,timings[slug].listeningTotalSeconds);assert.ok(listen.body.audioKey);
  }
  const submitted=await post(`${base}/listening`,{...token,answers:{11:'A'},clientSubmissionId:randomUUID()});assert.equal(submitted.status,200,JSON.stringify(submitted.body));
  assert.equal(submitted.body.completed,true);assert.equal(submitted.body.next,slug.startsWith('term')?'writing':'result');
  assert.equal(submitted.body.result.listening.correct,1);assert.equal(submitted.body.result.reading.correct,1);
  const again=await post(`${base}/listening`,{...token,answers:{11:'B'},clientSubmissionId:randomUUID()});assert.deepEqual(again.body.result,submitted.body.result);
  const rows=(await fixture.db.query('SELECT * FROM assessment.term_test_attempt')).rows;assert.equal(rows.length,1);assert.deepEqual(rows[0].reading_answers,{14:'A'});assert.deepEqual(rows[0].listening_answers,{11:'A'});
});
test('Hai tab mở đồng thời chỉ có một lượt; sai người và client cũ bị chặn',async()=>{
  await clean();const [a,b]=await Promise.all([open('term-test-1'),open('term-test-1')]);assert.equal(a.state.attemptToken,b.state.attemptToken);
  const old=await api.post('/api/term-tests/term-test-1/reading/start').send({attemptToken:a.state.attemptToken});assert.equal(old.status,409);assert.equal(old.body.error,'ORDER_CLIENT_UPDATE_REQUIRED');
  for(const body of [
    {examSessionToken:a.state.examSessionToken,orderClientVersion:2},
    {examSessionToken:a.state.examSessionToken,orderClientVersion:1,generation:-1},
    {examSessionToken:a.state.examSessionToken,attemptToken:'không hợp lệ',orderClientVersion:1},
    {examSessionToken:a.state.examSessionToken,attemptToken:randomUUID(),orderClientVersion:1}
  ]){
    const bypass=await api.post('/api/term-tests/term-test-1/session/start').send(body);
    assert.ok([400,409].includes(bypass.status),JSON.stringify(bypass.body));assert.equal(bypass.body.audioKey,undefined);
  }
  const unchanged=(await fixture.db.query('SELECT listening_started_at FROM assessment.term_test_exam_session')).rows[0];assert.equal(unchanged.listening_started_at,null);
  const wrong=await post('/api/term-tests/term-test-1/session/resume-attempt',{attemptToken:a.state.attemptToken,classCode:'IC2304',studentRef:'44444444-4444-4444-8444-444444444444'});assert.equal(wrong.status,404);
});
test('Constraint không cho điểm 0 giả hoặc hoàn tất khi thiếu kỹ năng; Mini giấy kiểm generation',async()=>{
  await clean();const {base,state}=await open('mini-test-lesson-5','answer_sheet');
  const stale=await post(`${base}/reading/start`,{attemptToken:state.attemptToken,generation:1});assert.equal(stale.body.error,'STALE_GENERATION');
  await assert.rejects(fixture.db.query('UPDATE assessment.term_test_attempt SET completed_at=now(),combined_result=\'{}\' WHERE id=$1',[state.attemptToken]),/check constraint/);
  await assert.rejects(fixture.db.query('UPDATE assessment.term_test_attempt SET listening_result=\'{}\' WHERE id=$1',[state.attemptToken]),/check constraint/);
});
test('Hết giờ Reading dùng nháp ACK, giữ thời hạn qua reload và không khởi động Listening',async()=>{
  await clean();const {base,state}=await open('term-test-2');const token={attemptToken:state.attemptToken};
  await post(`${base}/reading/start`,token);await post(`${base}/reading/draft`,{...token,revision:3,answers:{14:'A'}});
  await fixture.db.query(`UPDATE assessment.term_test_attempt SET reading_started_at=now()-interval '70 minutes',reading_deadline_at=now()-interval '10 minutes' WHERE id=$1`,[state.attemptToken]);
  const before=(await fixture.db.query('SELECT reading_deadline_at FROM assessment.term_test_attempt')).rows[0];
  await post(`${base}/reading/start`,token);const after=(await fixture.db.query('SELECT reading_deadline_at FROM assessment.term_test_attempt')).rows[0];assert.deepEqual(after,before);
  const draft=await post(`${base}/reading/draft`,{...token,revision:4,answers:{14:'B'}});assert.equal(draft.status,409);
  const sub=await post(`${base}/reading`,{...token,answers:{14:'B'},draftRevision:4});assert.equal(sub.body.next,'listening');
  const row=(await fixture.db.query('SELECT * FROM assessment.term_test_attempt')).rows[0];assert.deepEqual(row.reading_answers,{14:'A'});
});
test('Chờ quá 8 giờ sau Reading vẫn tải được audio; trước Reading không cấp audio',async()=>{
  await clean();const {base,state}=await open('term-test-1');const token={attemptToken:state.attemptToken};
  const audio=`${base}/session/${state.examSessionToken}/audio`;
  await api.get(audio).expect(409);
  await post(`${base}/reading/start`,token);await post(`${base}/reading`,{...token,answers:{14:'A'}});
  await fixture.db.query(`UPDATE assessment.term_test_exam_session SET prepared_at=now()-interval '9 hours' WHERE id=$1`,[state.examSessionToken]);
  const resumed=await open('term-test-1');assert.equal(resumed.state.attemptToken,state.attemptToken);
  await api.get(audio).expect(200);await api.get(`${base}/session/${state.examSessionToken}/preview`).expect(200);
  const started=await post(`${base}/session/start`,{examSessionToken:state.examSessionToken});assert.equal(started.status,200);
});
test('Tắt mở lượt Reading mới vẫn cho tiếp tục lượt đã bind',async()=>{
  await clean();const {state}=await open('term-test-1');
  const disabled=request(createApp({pool:fixture.pool,termTestAssetService:assets,config:{readFirstNewEnabled:false,
    allowedOrigins:new Set(),trustProxyHops:0,authMode:'legacy',legacyReviewToken:'fixture-only-key'}}));
  const body={classCode:'IC2304',studentRef:ref,examMode:'read_first',orderClientVersion:1};
  const resumed=await disabled.post('/api/term-tests/term-test-1/session/prepare').send(body);assert.equal(resumed.body.attemptToken,state.attemptToken);
  const denied=await disabled.post('/api/term-tests/term-test-2/session/prepare').send(body);assert.equal(denied.status,409);assert.equal(denied.body.error,'READ_FIRST_NOT_ENABLED');
});
test('Hai lần nộp Reading đồng thời giữ một snapshot; constraint kiểm NULL tường minh',async()=>{
  await clean();const {base,state}=await open('term-test-1');const token={attemptToken:state.attemptToken};
  await assert.rejects(fixture.db.query('UPDATE assessment.term_test_attempt SET reading_started_at=now() WHERE id=$1',[state.attemptToken]),/check constraint/);
  await assert.rejects(fixture.db.query('UPDATE assessment.term_test_exam_session SET listening_started_at=now() WHERE id=$1',[state.examSessionToken]),/check constraint/);
  await post(`${base}/reading/start`,token);
  const [a,b]=await Promise.all([post(`${base}/reading`,{...token,answers:{14:'A'}}),post(`${base}/reading`,{...token,answers:{14:'B'}})]);
  assert.equal(a.status,200);assert.equal(b.status,200);
  const rows=(await fixture.db.query('SELECT * FROM assessment.term_test_attempt')).rows;assert.equal(rows.length,1);
  assert.ok(['A','B'].includes(rows[0].reading_answers['14']));
  await post(`${base}/reading`,{...token,answers:{14:'C'}});
  assert.deepEqual((await fixture.db.query('SELECT reading_answers FROM assessment.term_test_attempt')).rows[0].reading_answers,rows[0].reading_answers);
});
test('Chưa chuẩn bị Reading trước không được tạo lượt Listening trước qua tuyến cũ',async()=>{
  await clean();
  const denied=await post('/api/term-tests/mini-test-lesson-5/listening',{classCode:'IC2304',studentRef:ref,
    examMode:'read_first',examDelivery:'answer_sheet',answers:{11:'A'},clientSubmissionId:randomUUID()});
  assert.equal(denied.status,409);assert.equal(denied.body.error,'EXAM_SESSION_REQUIRED');
  assert.equal((await fixture.db.query('SELECT * FROM assessment.term_test_attempt')).rows.length,0);
});

// Phiên Listening cũ không được âm thầm đổi lựa chọn Reading trước hoặc thu bài trắng.
// Kiểm qua HTTP và đọc lại nguyên snapshot; dữ liệu và điểm đều là giả.
for(const slug of ['term-test-1','term-test-2'])for(const phase of ['prepared','started','expired'])test(`${slug}: Reading trước gặp phiên Listening ${phase}: báo xung đột, giữ nguyên phiên`,async()=>{
  await clean();
  const prepared=await post(`/api/term-tests/${slug}/session/prepare`,{
    classCode:'IC2304',studentRef:ref,examMode:'lis_first',examDelivery:'cbt'});
  assert.equal(prepared.status,201,JSON.stringify(prepared.body));
  if(phase!=='prepared')await fixture.db.query(`UPDATE assessment.term_test_exam_session
    SET listening_started_at=now()-interval '5 hours',listening_deadline_at=now()+$2::interval,
      listening_draft=$3::jsonb,listening_draft_revision=2 WHERE id=$1`,
    [prepared.body.examSessionToken,phase==='expired'?'-4 hours':'20 minutes',JSON.stringify(phase==='started'?{11:'A'}:{})]);
  const before=(await fixture.db.query('SELECT * FROM assessment.term_test_exam_session')).rows;
  for(const route of ['session/prepare','order/open']){
    const response=await post(`/api/term-tests/${slug}/${route}`,{
      classCode:'IC2304',studentRef:ref,examMode:'read_first',examDelivery:'cbt'});
    assert.equal(response.status,409,JSON.stringify(response.body));
    assert.equal(response.body.error,'EXAM_ORDER_CONFLICT');
    assert.equal(response.body.attemptToken,undefined);
  }
  assert.deepEqual((await fixture.db.query('SELECT * FROM assessment.term_test_exam_session')).rows,before);
  assert.equal((await fixture.db.query('SELECT * FROM assessment.term_test_attempt')).rows.length,0);
  assert.equal(synced.length,0);
  const resumed=await post(`/api/term-tests/${slug}/session/prepare`,{
    classCode:'IC2304',studentRef:ref,examMode:'lis_first',examSessionToken:prepared.body.examSessionToken});
  assert.equal(resumed.status,201);assert.equal(resumed.body.examSessionToken,prepared.body.examSessionToken);
});
for(const slug of ['term-test-1','term-test-2'])test(`${slug}: Reading trước gặp lượt đã nộp Listening: không trả token của thứ tự khác`,async()=>{
  await clean();
  const submitted=await post(`/api/term-tests/${slug}/listening`,{
    classCode:'IC2304',studentRef:ref,examMode:'lis_first',answers:{11:'A'},clientSubmissionId:randomUUID()});
  assert.equal(submitted.status,201,JSON.stringify(submitted.body));
  const before=(await fixture.db.query('SELECT * FROM assessment.term_test_attempt')).rows;
  const response=await post(`/api/term-tests/${slug}/session/prepare`,{
    classCode:'IC2304',studentRef:ref,examMode:'read_first',examDelivery:'cbt'});
  assert.equal(response.status,409,JSON.stringify(response.body));
  assert.equal(response.body.error,'EXAM_ORDER_CONFLICT');
  assert.deepEqual((await fixture.db.query('SELECT * FROM assessment.term_test_attempt')).rows,before);
});
test('Migration không đổi token, điểm, nháp, thế hệ hay thời gian bài cũ',async()=>{
  const old=await createMiniFixture();
  try {
    for(let i=0;i<4;i++)await old.db.query(`INSERT INTO assessment.term_test_attempt
      (client_submission_id,test_slug,definition_version,erp_course_class_id,class_name_snapshot,erp_student_contact_id,
       student_name_snapshot,listening_answers,listening_result,listening_submitted_at,reading_draft,reading_draft_revision,
       attempt_mode,generation) VALUES($1,'mini-test-lesson-5',1,1293,'IC2304',$2,'Người thử cũ','{}','{}',now(),'{"14":"A"}',3,$3,7)`,
      [randomUUID(),900100+i,i===3?'answer_sheet':'legacy']);
    await old.db.exec(`UPDATE assessment.term_test_attempt SET reading_answers='{}',reading_result='{}',reading_submitted_at=now(),
      completed_at=now(),combined_result='{"preserve":true}' WHERE erp_student_contact_id IN(900101,900102);
      UPDATE assessment.term_test_attempt SET writing_started_at=now(),writing_updated_at=now(),writing_task_2='Bài viết giữ nguyên'
      WHERE erp_student_contact_id=900102;`);
    const before=(await old.db.query('SELECT * FROM assessment.term_test_attempt ORDER BY erp_student_contact_id')).rows;
    await old.db.exec(await readFile(new URL('../db/008-exam-order.sql',import.meta.url),'utf8'));
    const after=(await old.db.query('SELECT * FROM assessment.term_test_attempt ORDER BY erp_student_contact_id')).rows;
    assert.deepEqual(after.map(({exam_mode,exam_delivery,...row})=>row),before);
    assert.ok(after.every(row=>row.exam_mode==='lis_first'));
  }finally{await old.db.close();}
});

test('Trang cache cũ không nhận active:false hoặc nộp Listening nhầm cho lượt Reading trước',async()=>{
  await clean();const {base,state}=await open('term-test-1');
  const identity={classCode:'IC2304',studentRef:ref};
  const old=await api.post(`${base}/attempt/active`).send(identity);
  assert.equal(old.status,409);assert.equal(old.body.error,'ORDER_CLIENT_UPDATE_REQUIRED');
  const current=await post(`${base}/attempt/active`,identity);
  assert.equal(current.body.active,true);assert.equal(current.body.attemptToken,state.attemptToken);assert.equal(current.body.listeningSubmitted,false);
  const direct=await api.post(`${base}/listening`).send({...identity,clientSubmissionId:randomUUID(),answers:{11:'A'}});
  assert.equal(direct.status,409);assert.equal(direct.body.error,'ORDER_CLIENT_UPDATE_REQUIRED');
  for(const path of [`${base}/session/resume-attempt`,'/api/term-tests/result']) {
    const bad=await api.post(path).send({...identity,attemptToken:state.attemptToken,orderClientVersion:2});
    assert.equal(bad.status,409);assert.equal(bad.body.error,'ORDER_CLIENT_UPDATE_REQUIRED');
  }
  assert.equal((await fixture.db.query('SELECT listening_result FROM assessment.term_test_attempt')).rows[0].listening_result,null);
});
test('Phiên Listening chuẩn bị đã hết 8 giờ được thay an toàn khi mở Reading trước',async()=>{
  await clean();const old=(await fixture.db.query(`INSERT INTO assessment.term_test_exam_session
    (test_slug,definition_version,erp_course_class_id,class_name_snapshot,erp_student_contact_id,student_name_snapshot,prepared_at)
    VALUES('term-test-1',1,1293,'IC2304',900001,'Người thử',now()-interval '9 hours') RETURNING id`)).rows[0];
  const {state}=await open('term-test-1');assert.notEqual(state.examSessionToken,old.id);
  assert.ok((await fixture.db.query('SELECT superseded_at FROM assessment.term_test_exam_session WHERE id=$1',[old.id])).rows[0].superseded_at);
});
test('Session đổi generation hoặc bị thay thế không được ghi nháp qua token attempt cũ',async()=>{
  await clean();const {base,state}=await open('mini-test-lesson-5','answer_sheet');
  const token={attemptToken:state.attemptToken,generation:0};await post(`${base}/reading/start`,token);
  await fixture.db.query('UPDATE assessment.term_test_exam_session SET generation=1 WHERE id=$1',[state.examSessionToken]);
  const stale=await post(`${base}/reading/draft`,{...token,revision:1,answers:{14:'B'}});assert.equal(stale.body.error,'STALE_GENERATION');
  await fixture.db.query('UPDATE assessment.term_test_exam_session SET generation=0,superseded_at=now() WHERE id=$1',[state.examSessionToken]);
  const dead=await post(`${base}/reading/draft`,{...token,revision:2,answers:{14:'B'}});assert.equal(dead.body.error,'STALE_ATTEMPT');
  assert.deepEqual((await fixture.db.query('SELECT reading_draft FROM assessment.term_test_attempt')).rows[0].reading_draft,{});
});
test('Draft đã hết giờ hoặc đã thu giữ mã khóa và không báo ACK thành công',async()=>{
  await clean();const {base,state}=await open('term-test-1');const token={attemptToken:state.attemptToken};
  await post(`${base}/reading/start`,token);
  await fixture.db.query(`UPDATE assessment.term_test_attempt SET reading_deadline_at=clock_timestamp()-interval '1 second',
    reading_started_at=clock_timestamp()-interval '1 minute' WHERE id=$1`,[state.attemptToken]);
  const expired=await post(`${base}/reading/draft`,{...token,revision:1,answers:{14:'B'}});assert.equal(expired.body.error,'READING_LOCKED');
  const sub=await post(`${base}/reading`,{...token,answers:{14:'A'}});assert.equal(sub.body.timedOut,true);
  const closed=await post(`${base}/reading/draft`,{...token,revision:2,answers:{14:'B'}});assert.equal(closed.body.error,'READING_LOCKED');assert.equal(closed.body.accepted,undefined);
});
test('Hai học viên dùng cùng mã gửi Listening nhận xung đột; mã thực được lưu',async()=>{
  await clean();const id=randomUUID(),identity={classCode:'IC2304',examMode:'read_first',examDelivery:'cbt'};
  for(const studentRef of [ref,'44444444-4444-4444-8444-444444444444']) {
    const opened=await post('/api/term-tests/term-test-1/session/prepare',{...identity,studentRef});
    const token={attemptToken:opened.body.attemptToken,examSessionToken:opened.body.examSessionToken};
    const base='/api/term-tests/term-test-1';await post(`${base}/reading/start`,token);await post(`${base}/reading`,{...token,answers:{14:'A'}});
    await post(`${base}/session/start`,token);
    const submitted=await post(`${base}/listening`,{...token,clientSubmissionId:id,answers:{11:'A'}});
    if(studentRef===ref){assert.equal(submitted.status,200);assert.equal((await fixture.db.query('SELECT client_submission_id FROM assessment.term_test_attempt WHERE id=$1',[token.attemptToken])).rows[0].client_submission_id,id);}
    else {assert.equal(submitted.status,409);assert.equal(submitted.body.error,'SUBMISSION_ID_CONFLICT');}
  }
});
test('Native: đợi khóa vượt deadline không nhận nháp quá hạn', {skip:!process.env.K67_ORDER_NATIVE_URL},async()=>{
  await clean();const {base,state}=await open('term-test-1');await post(`${base}/reading/start`,{attemptToken:state.attemptToken});
  await fixture.db.query(`UPDATE assessment.term_test_attempt SET reading_deadline_at=clock_timestamp()+interval '2 seconds' WHERE id=$1`,[state.attemptToken]);
  const blocker=await fixture.pool.connect();await blocker.query('BEGIN');
  await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['term-test-1:1293:900001']);
  const pending=post(`${base}/reading/draft`,{attemptToken:state.attemptToken,revision:2,answers:{14:'B'}}).then(response=>response);
  await new Promise(resolve=>setTimeout(resolve,250));
  const waiting=await fixture.db.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory'`);
  assert.equal(waiting.rows[0].n,1);
  await new Promise(resolve=>setTimeout(resolve,2200));await blocker.query('ROLLBACK');blocker.release();
  const r=await pending;assert.equal(r.body.error,'READING_LOCKED');
  assert.deepEqual((await fixture.db.query('SELECT reading_draft FROM assessment.term_test_attempt')).rows[0].reading_draft,{});
});
test('Token Listening LF/RF tiếp tục lưu/nộp khi bộ đệm lớp tạm cũ; audio phiên bị thay không cấp nữa',async()=>{
  for(const mode of ['lis_first','read_first']) {
    await clean();await fixture.db.exec('UPDATE mapping.k67_context_state SET captured_at=now()');
    const base='/api/term-tests/term-test-1';
    const opened=await post(base+'/session/prepare',{classCode:'IC2304',studentRef:ref,examMode:mode});
    const token={examSessionToken:opened.body.examSessionToken,attemptToken:opened.body.attemptToken};
    if(mode==='read_first') {await post(base+'/reading/start',token);await post(base+'/reading',{...token,answers:{14:'A'}});}
    await post(base+'/session/start',token);
    await fixture.db.exec(`UPDATE mapping.k67_context_state SET captured_at=now()-interval '1 day'`);
    const submitted=await post(base+'/listening',{...token,classCode:'IC2304',studentRef:ref,clientSubmissionId:randomUUID(),answers:{11:'A'}});
    assert.ok([200,201].includes(submitted.status),JSON.stringify(submitted.body));
    if(mode==='read_first') {
      await fixture.db.query('UPDATE assessment.term_test_exam_session SET superseded_at=now() WHERE id=$1',[token.examSessionToken]);
      for(const kind of ['audio','preview']) {
        const r=await api.get(`${base}/session/${token.examSessionToken}/${kind}`);assert.equal(r.status,409);assert.equal(r.body.error,'STALE_ATTEMPT');
      }
    }
  }
  await fixture.db.exec('UPDATE mapping.k67_context_state SET captured_at=now()');
});
test('Listening trước tính một lượt giới hạn; xung đột Reading trước cũng tính một lượt và không nối nhầm',async()=>{
  await clean();
  const config={allowedOrigins:new Set(),trustProxyHops:0,authMode:'legacy',legacyReviewToken:'fixture-only-key'};
  const baseline=request(createApp({pool:fixture.pool,termTestAssetService:assets,config}));
  const candidate=request(createApp({pool:fixture.pool,termTestAssetService:assets,config:{...config,readFirstNewEnabled:true}}));
  const path='/api/term-tests/term-test-1/session/prepare',body={classCode:'IC2304',studentRef:ref,examMode:'lis_first',orderClientVersion:1};
  const a=await baseline.post(path).send(body),b=await candidate.post(path).send(body);
  assert.equal(b.status,a.status);assert.equal(b.headers.ratelimit,a.headers.ratelimit);assert.ok(a.headers.ratelimit);
  const boundA=await baseline.post(path).send({...body,examMode:'read_first'}),boundB=await candidate.post(path).send({...body,examMode:'read_first'});
  assert.equal(boundB.status,409);assert.equal(boundB.body.error,'EXAM_ORDER_CONFLICT');
  assert.equal(boundB.headers.ratelimit,boundA.headers.ratelimit);
});
test('Mini giấy: đổi từ người Reading trước sang người có Listening trước trả thứ tự thật',async()=>{
  await clean();const base='/api/term-tests/mini-test-lesson-5/answer-sheet',other='44444444-4444-4444-8444-444444444444';
  const legacy=await post(base+'/open',{classCode:'IC2304',studentRef:other,identityConfirmed:true,examMode:'lis_first'});
  assert.equal(legacy.body.examMode,'lis_first');assert.equal(legacy.body.readingSubmitted,false);
  const submitted=await post(base+'/listening',{examSessionToken:legacy.body.examSessionToken,generation:0,clientSubmissionId:randomUUID(),answers:{11:'A'}});
  assert.equal(submitted.status,201,JSON.stringify(submitted.body));
  const rf=await open('mini-test-lesson-5','answer_sheet');
  const changed=await post(base+'/open',{classCode:'IC2304',studentRef:other,identityConfirmed:true,examMode:'read_first',examDelivery:'answer_sheet'});
  assert.equal(changed.body.examMode,'lis_first');assert.equal(changed.body.attemptToken,submitted.body.attemptToken);
  const reading=await post(base+'/reading/start',{attemptToken:changed.body.attemptToken,generation:changed.body.generation,examMode:changed.body.examMode});
  assert.equal(reading.status,200);assert.equal(reading.body.readingDeadlineAt,null);
  const a=await post(base+'/open',{classCode:'IC2304',studentRef:ref,identityConfirmed:true,examMode:'read_first',examDelivery:'answer_sheet'});
  assert.equal(a.body.attemptToken,rf.state.attemptToken);assert.equal(a.body.readingStartedAt,null);
});
test('Native: thời điểm bắt đầu ở sau khi lấy được khóa, học viên được đủ thời lượng', {skip:!process.env.K67_ORDER_NATIVE_URL},async()=>{
  await clean();const {base,state}=await open('term-test-1');
  for(const skill of ['reading','listening']) {
    const blocker=await fixture.pool.connect();await blocker.query('BEGIN');
    await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['term-test-1:1293:900001']);
    const pending=post(`${base}/${skill==='reading'?'reading/start':'session/start'}`,{attemptToken:state.attemptToken}).then(r=>r);
    await new Promise(resolve=>setTimeout(resolve,500));
    const unlocked=Date.now();await blocker.query('ROLLBACK');blocker.release();
    const r=await pending;assert.equal(r.status,200,JSON.stringify(r.body));
    assert.ok(Date.parse(r.body[skill+'StartedAt'])>=unlocked-5);
    assert.equal(Date.parse(r.body[skill+'DeadlineAt'])-Date.parse(r.body[skill+'StartedAt']),skill==='reading'?3600000:1855000);
    if(skill==='reading')await post(`${base}/reading`,{attemptToken:state.attemptToken,answers:{14:'A'}});
  }
});
