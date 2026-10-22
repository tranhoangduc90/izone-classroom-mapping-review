// Đi trọn API và lưu kết quả từng ô trong DB giả; không ghi lớp hoặc Portal thật.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import request from 'supertest';
import {createLearningDemoApp,createPGlitePool,initializeLearningDemoDatabase} from '../src/learning-demo.js';
import {createLearningDemoGrant} from '../src/learning-demo-grant.js';
import {sha256,stableStringify} from '../src/learning-domain.js';
import {fetchCourseSessionDetailSql} from '../src/learning-course-overview.js';
import {fixture} from './fixtures/numbered-grading.js';
import {parseFormDefinition} from '../src/learning-contracts.js';
test('API + DB: 12/12, 10/12 và 0/12; đọc lại, retry, lịch sử giữ từng ô và không lộ khóa',async()=>{
 const db=new PGlite(),f=fixture(),origin='https://example.test',headers={origin,'x-progress-log-demo':'1'},secret='fake-secret-for-numbered-api-tests';
 try{
  await initializeLearningDemoDatabase(db);const pool=createPGlitePool(db);f.definition=parseFormDefinition(f.definition);
  const sourceId=crypto.randomUUID(),publicToken=crypto.randomUUID();
  const source={sourceAssignmentId:sourceId,title:f.definition.title,className:'Lớp giả',sessionNumber:1,courseCode:'DEMO-56',
    definition:f.definition,gradingKey:f.gradingKey,definitionHash:sha256(stableStringify(f.definition))};
  const app=createLearningDemoApp({pool,allowedOrigin:origin,grantSecret:secret,fetchSource:async()=>source});
  const grant=createLearningDemoGrant({assignmentId:sourceId,publicToken,definitionHash:source.definitionHash,secret});
  const created=await request(app).post('/api/demo/runs').set(headers).send({grant}).expect(201),run=created.body.run;
  await request(app).post('/api/demo/runs/open-blocks').set({...headers,'x-demo-teacher-token':run.teacherToken}).send({}).expect(200);
  const opened=await request(app).post('/api/learning/assignments/open').set(headers).send({publicToken:run.publicToken}).expect(200),assignment=opened.body.assignment;
  assert.equal(JSON.stringify(assignment).includes('acceptedBySlot'),false);
  for(const [index,expectedScore]of [12,10,0].entries()){
   const studentRef=assignment.roster[index].studentRef;
   const started=await request(app).post('/api/learning/attempts/start').set(headers).send({publicToken:run.publicToken,studentRef,identityConfirmed:true,clientIdempotencyKey:crypto.randomUUID()}).expect(201);
   const responses=Object.fromEntries(f.items.map(item=>[item.itemVersionId,f.gradingKey.items[item.itemVersionId].acceptedBySlot.map(a=>index===2?'':a[0])]));
   if(index===1){responses[f.items[0].itemVersionId][1]='sai';responses[f.items[1].itemVersionId][4]='';}
   const attemptToken=started.body.attempt.attemptToken,definitionHash=assignment.definitionHash;
   await request(app).patch('/api/learning/attempts/draft').set(headers).send({attemptToken,revision:1,definitionHash,responses}).expect(200);
   const input={attemptToken,submissionId:crypto.randomUUID(),definitionHash,draftRevision:1,responses};
   const submitted=await request(app).post('/api/learning/attempts/submit').set(headers).send(input).expect(200);
   assert.equal(submitted.body.result.summary.scoreEarned,expectedScore);assert.equal(submitted.body.result.summary.maxScore,12);
   const read=await request(app).post('/api/learning/attempts/result').set(headers).send({attemptToken}).expect(200);
   assert.deepEqual(read.body.result.items,submitted.body.result.items);
   const replay=await request(app).post('/api/learning/attempts/submit').set(headers).send(input).expect(200);
   assert.equal(replay.body.result.summary.scoreEarned,expectedScore);
   const history=await pool.query(fetchCourseSessionDetailSql,[String(assignment.class.id),1,studentRef]);
   assert.equal(history.rowCount,1);assert.equal(history.rows[0].grading_items.flatMap(i=>i.slotResults).length,12);
   assert.equal(JSON.stringify(history.rows[0].grading_items).includes('expectedAnswer'),false);
   assert.equal(history.rows[0].grading_items.flatMap(i=>i.slotResults).filter(s=>s.verdict==='correct').length,expectedScore);
  }
  assert.equal((await pool.query('SELECT count(*)::int n FROM learning.submission')).rows[0].n,3);
  // Hàng thử nằm trong DB giả, không có consumer Portal. Retry không nhân yêu cầu điểm danh.
  const jobs=await pool.query("SELECT unit_key,status FROM learning.outbox_job WHERE job_type='sync_portal_attendance'");
  assert.equal(jobs.rows.length,3);assert.ok(jobs.rows.every(job=>job.unit_key.includes(run.assignmentId)&&job.status==='queued'));
 }finally{await db.close();}
});
