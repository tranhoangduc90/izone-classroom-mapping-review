import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {createLearningDemoApp,createPGlitePool,initializeLearningDemoDatabase} from '../src/learning-demo.js';
import {createLearningLibraryDemoGrant} from '../src/learning-demo-grant.js';
import {previewFormImport} from '../src/learning-form-import.js';
import {fetchCourseSessionDetailSql} from '../src/learning-course-overview.js';
import {sha256,stableStringify} from '../src/learning-domain.js';
test('Demo candidate: library grant, fake roster, blank survey reference after success, final and reset stay in new isolated DB',{timeout:40000},async()=>{
 const db=new PGlite();let server;
 try{
  await initializeLearningDemoDatabase(db);const secret='isolated-fixture-grant-secret-00000000000',origin='https://fixture.example';
  const payload=previewFormImport('type,prompt,skill\nreflection,Nội dung khảo sát giả,reading').payload;
  payload.definition.blocks[0].kind='survey';payload.definition.courseCode='56';payload.definition.answerReleasePolicy='hidden';
  const item=payload.definition.blocks[0].items[0];payload.gradingKey.referenceAnswers={[item.itemVersionId]:['Nguồn tham khảo giả']};
  const hash=sha256(stableStringify(payload)),entry={id:randomUUID(),revision:1,contentHash:hash};
  const source={sourceLibraryId:entry.id,sourceRevision:1,contentHash:hash,sourceAssignmentId:null,className:'Lớp mẫu giả',courseCode:'56',sessionNumber:1,title:payload.definition.title,
   definition:payload.definition,gradingKey:payload.gradingKey,definitionHash:sha256(stableStringify(payload.definition)),blockReleases:[],answerReleaseOverride:null};
  let reads=0;const app=createLearningDemoApp({pool:createPGlitePool(db),allowedOrigin:origin,grantSecret:secret,fetchSource:async value=>{assert.equal(typeof value,'object');reads++;return source;}});
  server=app.listen(0,'127.0.0.1');await new Promise(done=>server.once('listening',done));const base='http://127.0.0.1:'+server.address().port;
  async function post(path,body,extra={}){const response=await fetch(base+path,{method:'POST',headers:{origin,'content-type':'application/json','x-progress-log-demo':'1',...extra},body:JSON.stringify(body)});const result=await response.json();assert.equal(response.ok,true,JSON.stringify({path,status:response.status,result}));return result;}
  const grant=createLearningLibraryDemoGrant({entry,reviewer:{email:'fixture@example.test'},secret});
  const {run}=await post('/api/demo/runs',{grant});const headers={'x-demo-teacher-token':run.teacherToken};
  await post('/api/demo/runs/open-blocks',{},headers);const {assignment:form}=await post('/api/learning/assignments/open',{publicToken:run.publicToken});
  assert.equal(form.roster.length,3);assert.ok(form.roster.every(s=>s.name.startsWith('Học viên mẫu')));assert.equal(JSON.stringify(form).includes('Nguồn tham khảo giả'),false);
  const {attempt}=await post('/api/learning/attempts/start',{publicToken:run.publicToken,studentRef:form.roster[0].studentRef,identityConfirmed:true,clientIdempotencyKey:randomUUID()});
  const block=form.definition.blocks[0];const cp=await post('/api/learning/attempts/checkpoints/submit',{attemptToken:attempt.attemptToken,checkpointSubmissionId:randomUUID(),blockId:block.blockId,checkpoint:block.checkpoint,definitionHash:form.definitionHash,draftRevision:0,responses:{},idempotencyKey:randomUUID()});
  assert.equal(cp.checkpointSubmission.result.summary.maxScore,0);assert.ok(JSON.stringify(cp.checkpointSubmission.result).includes('Nguồn tham khảo giả'));
  const input={attemptToken:attempt.attemptToken,submissionId:randomUUID(),definitionHash:form.definitionHash,draftRevision:0,responses:{}};
  await post('/api/learning/attempts/submit',input);await post('/api/learning/attempts/submit',input);
  assert.equal((await db.query('SELECT count(*)::int n FROM learning.submission')).rows[0].n,1);
  const review=await db.query(fetchCourseSessionDetailSql,[String(form.class.id),form.sessionNumber,form.roster[0].studentRef]);
  assert.equal(review.rows.length,1);assert.deepEqual(review.rows[0].grading_items[0].expectedAnswer,['Nguồn tham khảo giả']);
  const detail=await post('/api/learning/student/course-session-detail',{publicToken:run.publicToken,studentRef:form.roster[0].studentRef,identityConfirmed:true,sessionNumber:form.sessionNumber});
  assert.deepEqual(detail.detail.gradingItems[0].expectedAnswer,['Nguồn tham khảo giả']);
  assert.equal((await db.query('SELECT count(*)::int n FROM learning.submission')).rows[0].n,1);
  await post('/api/demo/runs/reset',{},headers);assert.equal(reads,1);assert.equal((await db.query('SELECT kind FROM learning_demo.environment_marker WHERE id=true')).rows[0].kind,'progress_log_demo_only');
 }finally{if(server)await new Promise(done=>server.close(done));await db.close();}
});
