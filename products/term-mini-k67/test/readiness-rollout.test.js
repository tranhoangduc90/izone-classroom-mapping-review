import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {randomUUID,randomBytes} from 'node:crypto';
import {createApp} from '../src/app.js';
import {createReadinessFixture} from './helpers/readiness-fixture.js';

// Diễn tập bật/tắt module trên cùng DB giả; không downgrade schema hay xóa bài.
// Chứng minh giới hạn công tắc hiện có: tắt cả phiên đang làm, không phải đóng mềm.
test('Tắt rồi bật lại giữ nháp, báo cáo và bài nộp; không tạo lượt thi thật',async()=>{
  const f=await createReadinessFixture(),prefix='/api/k67-readiness/v1';
  const enabled=request(f.app),disabled=request(createApp({pool:f.pool,config:{...f.config,readinessEnabled:false}}));
  try{
    const opened=await enabled.post(prefix+'/sessions').send({classCode:'IC2304',studentRef:'11111111-1111-4111-8111-111111111111',requestId:randomUUID(),openingProof:randomBytes(32).toString('hex')});
    assert.equal(opened.status,201);const token=opened.body.token;
    const post=(api,route,data={})=>api.post(prefix+route).send({token,...data});
    assert.equal((await post(enabled,'/device',{sameComputer:true,sameHeadphones:true})).status,200);
    const answers={1:'Nháp cần giữ'};
    assert.equal((await post(enabled,'/draft',{revision:1,answers,heardSeconds:2,cacheState:'saved'})).status,200);
    const now=new Date().toISOString(),report={version:'web-check-v1',runId:randomUUID(),startedAt:now,checks:[{id:'page',state:'pass',code:'VISIBLE',at:now}]};
    assert.equal((await post(enabled,'/checks',{revision:1,report})).status,200);
    const snapshot=(await f.db.query('SELECT row_to_json(r) AS data FROM assessment.k67_readiness_session r')).rows;
    assert.equal((await disabled.get(prefix+'/roster?class=IC2304')).status,404);
    assert.equal((await post(disabled,'/session')).status,404);
    assert.equal((await post(disabled,'/draft',{revision:2,answers:{1:'không được ghi'},heardSeconds:2,cacheState:'saved'})).status,404);
    assert.deepEqual((await f.db.query('SELECT row_to_json(r) AS data FROM assessment.k67_readiness_session r')).rows,snapshot);
    const restored=await post(enabled,'/session');assert.equal(restored.status,200);assert.deepEqual(restored.body.session.answers,answers);assert.deepEqual(restored.body.session.checkReport,report);
    const submitted=await post(enabled,'/submit',{revision:1,heardConfirmed:false});assert.equal(submitted.status,200);
    const text='Bài Writing giả được giữ sau bật lại.';
    assert.equal((await post(enabled,'/practice/writing/draft',{revision:1,data:{text}})).status,200);
    const writing=await post(enabled,'/practice/writing/submit',{revision:1});assert.equal(writing.status,200);
    assert.equal((await post(disabled,'/session')).status,404);
    const again=await post(request(createApp({pool:f.pool,config:f.config})),'/session');
    assert.equal(again.status,200);assert.equal(again.body.session.submittedAt,submitted.body.session.submittedAt);assert.equal(again.body.session.practice.writing.submittedAt,writing.body.session.practice.writing.submittedAt);assert.equal(again.body.session.practice.writing.data.text,text);
    assert.equal((await f.db.query('SELECT count(*)::int AS n FROM assessment.term_test_exam_session')).rows[0].n,0);
    assert.equal((await f.db.query('SELECT count(*)::int AS n FROM assessment.term_test_attempt')).rows[0].n,0);
  }finally{await f.db.close();}
});

test('Bỏ lớp khỏi allowlist chặn cả phiên cũ, không được dùng thay đóng mềm',async()=>{
  const f=await createReadinessFixture(),prefix='/api/k67-readiness/v1';
  try{
    const opened=await request(f.app).post(prefix+'/sessions').send({classCode:'IC2304',studentRef:'11111111-1111-4111-8111-111111111111',requestId:randomUUID(),openingProof:randomBytes(32).toString('hex')});assert.equal(opened.status,201);
    const closed=request(createApp({pool:f.pool,config:{...f.config,readinessClasses:new Set()}}));
    const response=await closed.post(prefix+'/session').send({token:opened.body.token});assert.equal(response.status,401);assert.equal(response.body.error,'READINESS_SESSION_EXPIRED');
    assert.equal((await f.db.query('SELECT count(*)::int AS n FROM assessment.k67_readiness_session')).rows[0].n,1);
  }finally{await f.db.close();}
});
