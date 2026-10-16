import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {createApp} from '../src/app.js';
import {createMiniFixture} from './helpers/mini-answer-sheet-fixture.js';
import {createReadinessFixture} from './helpers/readiness-fixture.js';
import {randomBytes,randomUUID,createDecipheriv,createHash} from 'node:crypto';

let f,api;
const studentRef='11111111-1111-4111-8111-111111111111',prefix='/api/k67-readiness/v1';
before(async()=>{f=await createReadinessFixture();api=request(f.app);});
after(async()=>{await f?.db.close();});
async function open(overrides={}){
  await f.db.exec('UPDATE mapping.k67_context_state SET captured_at=now()');
  const body={classCode:'IC2304',studentRef,requestId:randomUUID(),openingProof:randomBytes(32).toString('hex'),...overrides};
  return{body,response:await api.post(prefix+'/sessions').send(body)};
}
const post=(route,token,data={})=>api.post(prefix+route).send({token,...data});
async function prepared(){
  const {response}=await open();assert.equal(response.status,201,JSON.stringify(response.body));
  const token=response.body.token;
  assert.equal((await post('/device',token,{sameComputer:true,sameHeadphones:true})).status,200);
  const access=await post('/audio-access',token);assert.equal(access.status,200);
  return{token,duration:access.body.duration,access:access.body};
}

// Bảo vệ điểm vào làm quen: có danh tính từ roster nhưng không cần mở một đề thi.
test('K67 mở danh sách làm quen riêng mà không tạo phiên thi thật', async () => {
  const f = await createMiniFixture();
  try {
    const app = createApp({pool:f.pool,config:{readinessEnabled:true,readinessClasses:new Set(['IC2304']),
      termTestSessionSecret:'readiness-local-test-secret-32-characters',allowedOrigins:new Set(),trustProxyHops:0,
      authMode:'legacy',legacyReviewToken:'fixture-only-key'}});
    const response = await request(app).get('/api/k67-readiness/v1/roster?class=IC2304');
    assert.equal(response.status,200,JSON.stringify(response.body));
    assert.equal(response.body.students[0].ref,'11111111-1111-4111-8111-111111111111');
    assert.equal((await f.db.query('SELECT count(*)::int AS n FROM assessment.term_test_exam_session')).rows[0].n,0);
  } finally {await f.db.close();}
});

test('Mở lại cùng thao tác trả đúng một phiên; không nhớ raw token trong DB',async()=>{
  const {body,response}=await open();assert.equal(response.status,201);
  const again=await api.post(prefix+'/sessions').send(body);assert.equal(again.status,201);assert.equal(again.body.token,response.body.token);
  const rows=await f.db.query('SELECT * FROM assessment.k67_readiness_session WHERE id=$1',[body.requestId]);
  assert.equal(rows.rows.length,1);assert.notEqual(rows.rows[0].token_hash,response.body.token);
  assert.equal((await api.post(prefix+'/sessions').send({...body,studentRef:'44444444-4444-4444-8444-444444444444'})).status,409);
});

test('Lưu, đọc lại, nháp cũ đến muộn, nộp lặp và reload giữ đúng đáp án',async()=>{
  const {token,duration}=await prepared();
  assert.equal((await post('/submit',token,{revision:1,heardConfirmed:true})).status,409);
  const newer=await post('/draft',token,{revision:2,answers:{1:'blue',2:'library'},heardSeconds:duration,cacheState:'saved'});
  assert.equal(newer.status,200);assert.deepEqual(newer.body.session.answers,{1:'blue',2:'library'});
  const stale=await post('/draft',token,{revision:1,answers:{1:'old'},heardSeconds:0,cacheState:'unavailable'});
  assert.deepEqual(stale.body.session.answers,{1:'blue',2:'library'});
  assert.equal((await post('/draft',token,{revision:2,answers:{1:'different'},heardSeconds:duration,cacheState:'saved'})).status,409);
  assert.equal((await post('/submit',token,{revision:1,heardConfirmed:true})).status,409);
  const done=await post('/submit',token,{revision:2,heardConfirmed:true});assert.equal(done.status,200);assert.ok(done.body.session.submittedAt);
  const duplicate=await post('/submit',token,{revision:2,heardConfirmed:false});assert.equal(duplicate.body.session.submittedAt,done.body.session.submittedAt);assert.equal(duplicate.body.session.heardConfirmed,true);
  assert.equal((await post('/draft',token,{revision:3,answers:{1:'changed'},heardSeconds:duration,cacheState:'saved'})).status,409);
  const restored=await post('/session',token);assert.deepEqual(restored.body.session.answers,{1:'blue',2:'library'});assert.equal(restored.body.session.heardConfirmed,true);
  const db=(await f.db.query('SELECT answers,submitted_at FROM assessment.k67_readiness_session WHERE token_hash=$1',[createHash('sha256').update(token).digest('hex')])).rows[0];
  assert.deepEqual(db.answers,{1:'blue',2:'library'});assert.ok(db.submitted_at);
});

test('Không nghe rõ và dùng máy khác vẫn có kết quả trung thực, không chấm trượt năng lực',async()=>{
  const {token,duration}=await prepared();await post('/device',token,{sameComputer:false,sameHeadphones:false});
  await post('/draft',token,{revision:1,answers:{1:'incorrect'},heardSeconds:duration,cacheState:'unavailable'});
  const done=await post('/submit',token,{revision:1,heardConfirmed:false});assert.equal(done.status,200);
  assert.equal(done.body.session.heardConfirmed,false);assert.equal(done.body.session.sameComputer,false);assert.equal(done.body.session.score,undefined);
});

test('Ciphertext thử giải mã/hash đúng; hai phiên có khóa riêng; không lưu khóa vào bản ghi',async()=>{
  const a=await prepared(),b=await prepared();assert.notEqual(a.access.audioKey,b.access.audioKey);
  const r=await api.get(prefix+'/audio').set('Authorization','Bearer '+a.token).buffer(true).parse((res,callback)=>{
    const parts=[];res.on('data',p=>parts.push(p));res.on('end',()=>callback(null,Buffer.concat(parts)));
  });assert.equal(r.status,200);assert.equal(r.body.length,a.access.manifest.encryptedByteLength);
  const decipher=createDecipheriv('aes-256-gcm',Buffer.from(a.access.audioKey,'base64'),r.body.subarray(5,17));decipher.setAuthTag(r.body.subarray(-16));
  const plain=Buffer.concat([decipher.update(r.body.subarray(17,-16)),decipher.final()]);
  assert.equal(plain.toString('ascii',0,4),'RIFF');assert.equal(createHash('sha256').update(plain).digest('hex'),a.access.manifest.sha256);
  const row=(await f.db.query('SELECT * FROM assessment.k67_readiness_session WHERE token_hash=$1',[createHash('sha256').update(a.token).digest('hex')])).rows[0];
  assert.ok(!JSON.stringify(row).includes(a.access.audioKey));
});

test('Token thử không lấy preview/khóa/nội dung/nộp bài thật; token thật không đọc phiên thử',async()=>{
  const {token}=await prepared();
  const official=await api.post('/api/term-tests/mini-test-lesson-5/session/prepare').send({classCode:'IC2304',studentRef});
  assert.equal(official.status,201,JSON.stringify(official.body));
  const valid=await api.get('/api/term-tests/mini-test-lesson-5/session/'+official.body.examSessionToken+'/preview');
  assert.equal(valid.status,200);assert.equal(valid.text||valid.body.toString(),'OFFICIAL_ASSET_SENTINEL');
  const before=(await f.db.query('SELECT row_to_json(s) AS data FROM assessment.term_test_exam_session s')).rows;
  const responses=await Promise.all([
    api.get('/api/term-tests/mini-test-lesson-5/session/'+token+'/preview'),
    api.get('/api/term-tests/mini-test-lesson-5/session/'+token+'/audio'),
    api.post('/api/term-tests/mini-test-lesson-5/session/start').send({examSessionToken:token}),
    api.post('/api/term-tests/mini-test-lesson-5/session/audio-access').send({examSessionToken:token,generation:0}),
    api.post('/api/term-tests/mini-test-lesson-5/listening').send({examSessionToken:token,classCode:'IC2304',studentRef,clientSubmissionId:randomUUID(),answers:{11:'A'}}),
    post('/session',official.body.examSessionToken)
  ]);
  for(const r of responses){assert.ok(r.status>=400,String(r.status));assert.ok(!JSON.stringify(r.body).includes('OFFICIAL_ASSET_SENTINEL'));assert.equal(r.body.audioKey,undefined);}
  assert.deepEqual((await f.db.query('SELECT row_to_json(s) AS data FROM assessment.term_test_exam_session s')).rows,before);
  assert.equal((await f.db.query('SELECT count(*)::int n FROM assessment.term_test_attempt')).rows[0].n,0);
});

test('Sai lớp/người, token đoán, phiên hết hạn hoặc người bị thu quyền đều bị từ chối',async()=>{
  assert.equal((await api.get(prefix+'/roster?class=IC9999')).status,404);
  assert.equal((await open({studentRef:randomUUID()})).response.status,403);
  assert.equal((await post('/session','k67r1_'+randomBytes(32).toString('base64url'))).status,401);
  const {token}=await prepared();
  await f.db.query('UPDATE assessment.k67_readiness_session SET expires_at=now()-interval \'1 second\' WHERE token_hash=$1',[createHash('sha256').update(token).digest('hex')]);
  assert.equal((await post('/audio-access',token)).status,401);
  const b=await prepared();await f.db.exec("UPDATE mapping.student_mapping_review SET status='rejected' WHERE erp_student_contact_id=900001");
  assert.equal((await post('/session',b.token)).status,401);
  await f.db.exec("UPDATE mapping.student_mapping_review SET status='approved' WHERE erp_student_contact_id=900001");
});

test('Ngữ cảnh cũ chặn mở mới nhưng phiên đã có vẫn lưu được; mặc định không bật readiness',async()=>{
  const {token,duration}=await prepared();await f.db.exec("UPDATE mapping.k67_context_state SET captured_at=now()-interval '5 minutes'");
  assert.equal((await api.get(prefix+'/roster?class=IC2304')).status,503);
  assert.equal((await post('/draft',token,{revision:1,answers:{1:'blue'},heardSeconds:duration,cacheState:'saved'})).status,200);
  await f.db.exec('UPDATE mapping.k67_context_state SET captured_at=now()');
  const disabled=createApp({pool:f.pool,config:{...f.config,readinessEnabled:false}});
  assert.equal((await request(disabled).get(prefix+'/roster?class=IC2304')).status,404);
});

test('Hai nháp cùng revision chỉ một bản được nhận; nộp đồng thời trả cùng một kết quả',async()=>{
  const {token,duration}=await prepared();
  const results=await Promise.all(['blue','red'].map(value=>post('/draft',token,{revision:1,answers:{1:value},heardSeconds:duration,cacheState:'saved'})));
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
  const saved=(await post('/session',token)).body.session;
  assert.equal(saved.answers[1],results.find(r=>r.status===200).body.session.answers[1]);
  const submitted=await Promise.all([post('/submit',token,{revision:1,heardConfirmed:true}),post('/submit',token,{revision:1,heardConfirmed:true})]);
  assert.deepEqual(submitted.map(r=>r.status),[200,200]);assert.equal(submitted[0].body.session.submittedAt,submitted[1].body.session.submittedAt);
});

test('120 lượt làm quen chung IP vẫn mở/lưu/nộp được và không tạo bài thi',async()=>{
  await f.db.exec('UPDATE mapping.k67_context_state SET captured_at=now()');
  const outcomes=await Promise.all(Array.from({length:120},async()=>{
    const {response}=await open();assert.equal(response.status,201);const token=response.body.token;
    assert.equal((await post('/device',token,{sameComputer:true,sameHeadphones:true})).status,200);
    assert.equal((await post('/draft',token,{revision:1,answers:{1:'blue'},heardSeconds:0,cacheState:'unavailable'})).status,200);
    const done=await post('/submit',token,{revision:1,heardConfirmed:false});assert.equal(done.status,200);assert.ok(done.body.session.submittedAt);return done.body.session.id;
  }));assert.equal(new Set(outcomes).size,120);
  assert.equal((await f.db.query('SELECT count(*)::int n FROM assessment.term_test_attempt')).rows[0].n,0);
});

test('Chặn token lạ theo IP nhưng phiên đã xác minh cùng mạng vẫn đọc/lưu được',async()=>{
  const {token}=await prepared();let blocked=false;
  for(let i=0;i<650;i++){
    const r=await post('/session','k67r1_'+randomBytes(32).toString('base64url'));
    if(r.status===429){blocked=true;break;}assert.equal(r.status,401);
  }
  assert.ok(blocked,'Token lạ phải có hạn mức trước khi dồn truy vấn vào DB');
  assert.equal((await post('/session',token)).status,200);
  assert.equal((await post('/draft',token,{revision:1,answers:{1:'blue'},heardSeconds:0,cacheState:'saved'})).status,200);
});
