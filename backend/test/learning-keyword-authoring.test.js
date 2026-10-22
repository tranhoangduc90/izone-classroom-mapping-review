// Câu giả kiểm đăng ký, quyền dùng kiểu dữ liệu và bản sao; không chứa đáp án lớp thật.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {AUTHORING_TYPES,authoringType,validateAuthoringPayload,copyAuthoringPayload} from '../src/learning-form-authoring.js';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import express from 'express';
import request from 'supertest';
import {createPGlitePool,initializeLearningDemoDatabase,createLearningDemoApp} from '../src/learning-demo.js';
import {createLearningFormDraftService} from '../src/learning-form-drafts.js';
import {createLearningRouter} from '../src/learning-routes.js';

function fixture(){
  const version=randomUUID(),item={itemFamilyId:randomUUID(),itemVersionId:randomUUID(),position:1,prompt:'Gạch chân từ khác nhau',
    helpText:'Bấm lại để bỏ chọn',interactionType:'multi_choice_group',layoutType:'keyword_selection',pedagogicalTypeCode:'keyword_identification',
    graderType:'none',maxScore:0,required:true,skillCodes:['listening'],options:[{id:'word-1',label:'test'},{id:'word-2',label:'test'},{id:'word-3',label:'again?'}],interactionConfig:{maxSelections:3}};
  return {definition:{schemaVersion:'FormDefinitionV1',formVersionId:version,title:'Phiếu kiểm từ khóa',kind:'mixed',blocks:[{blockId:randomUUID(),checkpoint:1,title:'Tìm từ khóa',items:[item]}]},
    gradingKey:{schemaVersion:'FormGradingKeyV1',formVersionId:version,graderVersion:1,items:{},groups:{}}};
}
test('Gạch chân: đăng ký riêng, không cần bịa đáp án và không chuyển thành câu chấm điểm',()=>{
  const p=fixture(),i=p.definition.blocks[0].items[0];assert.equal(authoringType(i),'keyword_selection');
  assert.equal(AUTHORING_TYPES.find(t=>t.code==='keyword_selection').label,'Gạch chân từ khóa');
  i.interactionConfig.maxSelections=2;
  const checked=validateAuthoringPayload({...p,requireAnswers:true});assert.deepEqual(checked.missingAnswers,[]);
  i.graderType='exact_option';i.maxScore=1;
  assert.throws(()=>validateAuthoringPayload(p),e=>e.code==='DRAFT_TYPE_NOT_ALLOWED');
});
test('Gạch chân: từ trùng chữ giữ vị trí riêng, sao chép giữ văn bản và thay mã câu',()=>{
  const p=fixture(),copy=copyAuthoringPayload(p),before=p.definition.blocks[0].items[0],after=copy.definition.blocks[0].items[0];
  assert.deepEqual(after.options,before.options);assert.notEqual(after.itemVersionId,before.itemVersionId);assert.equal(after.itemFamilyId,before.itemFamilyId);
  assert.notEqual(after.options[0].id,after.options[1].id);assert.equal(after.options[0].label,after.options[1].label);
});
test('Gạch chân: chặn sai token, giới hạn không khớp và key tự thêm',()=>{
  for(const mutate of [i=>{i.options[0].label='hai từ';},i=>{i.options=Array.from({length:12},(_,n)=>({id:'w'+n,label:'từ'}));i.interactionConfig.maxSelections=11;}]){
    const p=fixture();mutate(p.definition.blocks[0].items[0]);assert.throws(()=>validateAuthoringPayload(p),e=>e.code==='DRAFT_KEYWORDS_INVALID');
  }
  const p=fixture();p.gradingKey.items[p.definition.blocks[0].items[0].itemVersionId]={graderType:'exact_option',expectedOptionId:'word-1'};
  assert.throws(()=>validateAuthoringPayload(p),e=>e.code==='DRAFT_ANSWER_INVALID');
});

test('Gạch chân: soạn/lưu/mở lại → xem thử → nộp và đọc biên nhận giữ đúng vị trí, không ghi lớp nguồn',async()=>{
  // Hai kho riêng kiểm đúng đường API đang dùng; dữ liệu thử không gửi đến Portal.
  const sourceDb=new PGlite(),demoDb=new PGlite(),secret='keyword-preview-test-secret-01234567890123456789';
  const origin='https://tranhoangduc90.github.io',headers={origin,'x-progress-log-demo':'1'};
  try{
    await initializeLearningDemoDatabase(sourceDb);await initializeLearningDemoDatabase(demoDb);
    await sourceDb.exec("ALTER TABLE mapping.reviewer_account ADD COLUMN role TEXT DEFAULT 'teacher', ADD COLUMN can_access_all_classes BOOLEAN DEFAULT false;");
    await sourceDb.exec(await readFile(new URL('../ops/learning-migrations/202610010001_progress_log_form_drafts.sql',import.meta.url),'utf8'));
    await sourceDb.exec("INSERT INTO mapping.classroom_course_mapping VALUES(1294,'Lớp thử','approved',NULL,NULL); INSERT INTO mapping.reviewer_account(email,status) VALUES('owner@example.test','active'); INSERT INTO mapping.reviewer_class_access VALUES('owner@example.test',1294);");
    const reviewer={email:'owner@example.test',canAccessAllClasses:false},pool=createPGlitePool(sourceDb),service=createLearningFormDraftService({pool}),payload=fixture();
    payload.definition.blocks[0].items[0].interactionConfig.maxSelections=2;
    const draft=await service.create({classId:'1294',sessionNumber:11,operationId:randomUUID(),...payload,reviewer});
    const read=await service.get({id:draft.id,reviewer});assert.deepEqual(read.definition.blocks[0].items[0].options,payload.definition.blocks[0].items[0].options);
    assert.equal(read.definition.blocks[0].items[0].interactionConfig.maxSelections,2);
    const sourceApp=express();sourceApp.use(express.json());sourceApp.use('/api/learning',createLearningRouter({pool,demoSourceSecret:secret,authenticate(req,_res,next){req.reviewer=reviewer;next();}}));
    const grant=(await request(sourceApp).post('/api/learning/teacher/form-drafts/'+draft.id+'/preview-grant').send({expectedRevision:1}).expect(200)).body.grant;
    const app=createLearningDemoApp({pool:createPGlitePool(demoDb),allowedOrigin:origin,grantSecret:secret,fetchSource:async value=>{
      const response=await request(sourceApp).post('/api/learning/assignments/demo-source').set('x-learning-demo-source',secret).send(value).expect(200);return response.body.source;
    }});
    const run=(await request(app).post('/api/demo/runs').set(headers).send({grant}).expect(201)).body.run;
    const form=(await request(app).post('/api/learning/assignments/open').set(headers).send({publicToken:run.publicToken}).expect(200)).body.assignment;
    const item=form.definition.blocks[0].items[0],attempt=(await request(app).post('/api/learning/attempts/start').set(headers).send({publicToken:run.publicToken,studentRef:form.roster[0].studentRef,clientIdempotencyKey:randomUUID(),identityConfirmed:true}).expect(201)).body.attempt;
    const responses={[item.itemVersionId]:['word-2','word-3']};
    await request(app).patch('/api/learning/attempts/draft').set(headers).send({attemptToken:attempt.attemptToken,definitionHash:form.definitionHash,revision:1,responses}).expect(200);
    const submitted=(await request(app).post('/api/learning/attempts/submit').set(headers).send({attemptToken:attempt.attemptToken,submissionId:randomUUID(),definitionHash:form.definitionHash,draftRevision:1,responses}).expect(200)).body;
    assert.equal(submitted.receipt.completeness,'complete');
    const result=(await request(app).post('/api/learning/attempts/result').set(headers).send({attemptToken:attempt.attemptToken}).expect(200)).body;
    assert.deepEqual(result.result.items[0].rawAnswer,['word-2','word-3']);assert.equal(result.result.items[0].maxScore,0);assert.equal(result.result.items[0].verdict,'ungraded');
    const counts=(await sourceDb.query('SELECT (SELECT count(*)::integer FROM learning.form_assignment) AS assignments,(SELECT count(*)::integer FROM learning.submission) AS submissions,(SELECT count(*)::integer FROM learning.outbox_job) AS jobs')).rows[0];
    assert.deepEqual(counts,{assignments:0,submissions:0,jobs:0});
  }finally{await sourceDb.close();await demoDb.close();}
});
