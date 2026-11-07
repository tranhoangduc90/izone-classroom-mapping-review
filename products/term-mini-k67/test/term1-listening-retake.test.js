import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import request from 'supertest';
import {createApp} from '../src/app.js';
import {createMiniFixture} from './helpers/mini-answer-sheet-fixture.js';

const root='/api/term-tests/term-test-1';
const retake=root+'/listening-retake';
const signingKey='synthetic-retake-ticket-key-at-least-32-characters';
const sessionKey='synthetic-retake-session-key-at-least-32-characters';
const identity={classCode:'IC2304',studentRef:'11111111-1111-4111-8111-111111111111'};
const deviceProof='a'.repeat(64);
const assets={supports:()=>true,getTiming:()=>({listeningDurationSeconds:10,listeningTotalSeconds:130}),
  getContent:()=>({title:'Đề thử',listening:{title:'Listening'},reading:{title:'Không cấp'},writing:{title:'Không cấp'}})};

function signedTicket(sessionToken,fields={}){
  const body=Buffer.from(JSON.stringify({v:1,purpose:'listening-retake',testSlug:'term-test-1',...identity,sessionToken,
    expiresAt:Math.floor(Date.now()/1000)+3600,...fields})).toString('base64url');
  return `${body}.${createHmac('sha256',signingKey).update(`izone-listening-retake-v1:${body}`).digest('base64url')}`;
}

test('Term 1 retake verifies scope and seals only its own Listening attempt',async t=>{
  const f=await createMiniFixture({examOrder:true,completeSchema:true,assets});
  t.after(()=>f.db.close());
  await f.db.exec(await readFile(new URL('../db/027-term1-listening-retake.sql',import.meta.url),'utf8'));
  await f.db.exec(`INSERT INTO assessment.test_definition(slug,title,version,listening_definition,reading_definition,is_active)
    SELECT 'term-test-1','Đề giả Term 1',1,listening_definition,reading_definition,true
    FROM assessment.test_definition WHERE slug='mini-test-lesson-5'`);
  const config={readFirstNewEnabled:true,term1ListeningRetakeSecret:signingKey,termTestSessionSecret:sessionKey,
    allowedOrigins:new Set(['https://tranhoangduc90.github.io']),trustProxyHops:0,authMode:'legacy',legacyReviewToken:'fixture-only-key'};
  const apiFor=mode=>request(createApp({pool:f.pool,termTestAssetService:assets,config:{...config,term1ListeningRetakeMode:mode}}));
  const api=apiFor('on');
  const regular=await api.post(root+'/session/prepare').send({...identity,examMode:'lis_first',examDelivery:'cbt',orderClientVersion:1});
  assert.ok(regular.ok,regular.text);
  await f.db.exec(`INSERT INTO assessment.term_test_attempt
    (client_submission_id,test_slug,definition_version,erp_course_class_id,class_name_snapshot,erp_student_contact_id,
     student_name_snapshot,listening_answers,listening_result,listening_submitted_at)
    VALUES(gen_random_uuid(),'term-test-1',1,1293,'IC2304',900001,'Học viên mô phỏng','{"11":"legacy"}','{}',now())`);
  const ordinary=async()=>Promise.all(['term_test_exam_session','term_test_attempt'].map(async table=>
    (await f.db.query(`SELECT to_jsonb(row) AS state FROM assessment.${table} row ORDER BY id`)).rows));
  const before=await ordinary();
  const id=randomUUID();
  const invalid='a'.repeat(80)+'.'+'b'.repeat(43);
  for(const examMode of ['lis_first','read_first'])for(const path of ['/session/prepare','/order/open']) {
    const reject=await api.post(root+path).send({...identity,examMode,deviceProof,retakeGrant:invalid});
    assert.equal(reject.status,403,reject.text);
    assert.equal(reject.body.examSessionToken,undefined);
  }
  const grant=signedTicket(id);
  const prepare=(client=api,body={})=>client.post(retake+'/prepare').send({...identity,deviceProof,retakeGrant:grant,...body});
  assert.equal((await prepare(api,{retakeGrant:signedTicket(id,{expiresAt:1})})).status,403);
  assert.equal((await prepare(api,{retakeGrant:signedTicket(id,{testSlug:'term-test-2'})})).status,403);
  assert.equal((await prepare(api,{retakeGrant:signedTicket(id,{classCode:'IC0000'})})).status,403);
  assert.equal((await prepare(api,{retakeGrant:signedTicket(id,{studentRef:randomUUID()})})).status,403);
  assert.equal((await prepare(apiFor('drain'))).body.error,'RETAKE_NEW_DISABLED');
  assert.equal((await prepare(apiFor('off'))).body.error,'RETAKE_UNAVAILABLE');
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM assessment.term_k67_listening_retake')).rows[0].n,0);
  const ready=await prepare(api,{examMode:'read_first'});
  assert.ok(ready.ok,ready.text);
  assert.equal(ready.body.examSessionToken,id);
  assert.notEqual(id,regular.body.examSessionToken);
  assert.equal(ready.body.examMode,'lis_first');
  assert.deepEqual(Object.keys(ready.body.content),['title','listening']);
  assert.equal((await prepare(api,{deviceProof:'b'.repeat(64)})).status,403);
  assert.equal((await prepare(apiFor('drain'))).body.examSessionToken,id);
  assert.equal((await prepare()).body.permit,ready.body.permit);

  const scope={examSessionToken:id,generation:0};
  const post=(path,input={},client=api)=>client.post(retake+path).set('x-term2-permit',ready.body.permit).send({...scope,deviceProof,...input});
  const begin=await post('/begin');
  assert.ok(begin.ok,begin.text);
  assert.equal((await post('/begin')).body.activatedAt,begin.body.activatedAt);
  assert.equal((await post('/begin',{generation:1})).status,403);
  assert.equal((await post('/begin',{deviceProof:'b'.repeat(64)})).status,403);
  const fakeStart=(await f.db.query(`UPDATE assessment.term_k67_listening_retake SET started_at=clock_timestamp()-interval '3 minutes'
    WHERE id=$1 RETURNING started_at`,[id])).rows[0].started_at;
  const startedAt=new Date(fakeStart).getTime(),eofAt=startedAt+10_000;
  const operation={...scope,operationId:randomUUID(),section:'listening',previousOperationId:null,startedAt,
    capturedAt:eofAt+120_000,revision:1,automatic:true,eofAt,heardSeconds:10,answers:{11:'A'}};
  assert.equal((await post('/seal',{...operation,eofAt:null})).body.error,'AUDIO_END_NOT_CONFIRMED');
  assert.equal((await post('/seal',{...operation,capturedAt:operation.capturedAt-1})).body.error,'AUDIO_END_NOT_CONFIRMED');
  assert.equal((await post('/status',{section:'listening',operationId:operation.operationId})).body.persisted,false);
  const sealed=await post('/seal',operation);
  assert.ok(sealed.ok,sealed.text);
  assert.equal(sealed.body.receipt.payloadHash,createHash('sha256').update(JSON.stringify(operation)).digest('hex'));
  assert.deepEqual((await post('/status',{section:'listening',operationId:operation.operationId},apiFor('drain'))).body.receipt,sealed.body.receipt);
  assert.deepEqual((await post('/seal',operation)).body.receipt,sealed.body.receipt);
  assert.equal((await post('/seal',{...operation,answers:{11:'B'}})).status,409);
  const result=await post('/result');
  assert.ok(result.ok,result.text);
  assert.equal(result.body.result.listening.correct,1);
  assert.equal(result.body.result.reading,null);
  assert.equal(result.body.portalSyncStatus,'pending');
  assert.equal((await api.post('/api/term-tests/result').send({attemptToken:id})).status,404);
  assert.deepEqual(await ordinary(),before);
});
