import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import {registerTeacherWritingResultRoutes} from '../src/learning-teacher-writing.js';
import {LearningError} from '../src/learning-service.js';
const ref='10000000-0000-4000-8000-000000000001',other='10000000-0000-4000-8000-000000000002';
test('Thẻ 23 Writing giảng viên: quyền lớp/người/bản, chỉ đọc, không cấp token làm bài',async()=>{
 let signedIn=true,reads=0;const input={classId:'1294',studentRef:ref,testSlug:'term-test-1',resultRef:'a'.repeat(64)},reviewer={email:'teacher@example.test',canAccessAllClasses:false};
 const app=express();app.use(express.json());const router=express.Router();registerTeacherWritingResultRoutes(router,{
  authenticate(req,res,next){if(!signedIn)return res.status(401).json({ok:false});req.reviewer=reviewer;next();},
  service:{async getCourseOverview({classId,reviewer:actual}){assert.deepEqual(actual,reviewer);if(classId!=='1294')throw new LearningError('CLASS_ACCESS_DENIED','Không có quyền lớp',403);return {classId,className:'Lớp giả',students:[{studentRef:ref,name:'Học viên giả',externalTests:[{...input,title:'Term Test 1',writing:{status:'ready'}}]}]};}},
  testResultReader:{async readWriting(actual){assert.deepEqual(actual,input);reads++;return {testSlug:input.testSlug,resultRef:input.resultRef,tasks:[{taskNumber:1,score:5.5,essay:'Saved essay'}]};}}
 });app.use(router);app.use((e,_req,res,_next)=>res.status(e.httpStatus||500).json({ok:false,error:e.code}));
 const valid=await request(app).post('/teacher/writing-test-result').send(input).expect(200);assert.equal(valid.body.result.readOnly,true);assert.equal(valid.headers['cache-control'],'no-store');assert.equal(valid.body.result.student.studentRef,ref);assert.doesNotMatch(JSON.stringify(valid.body),/attemptToken|publicToken|accessToken/u);
 await request(app).post('/teacher/writing-test-result').send({...input,classId:'9999'}).expect(403);
 await request(app).post('/teacher/writing-test-result').send({...input,studentRef:other}).expect(409);
 await request(app).post('/teacher/writing-test-result').send({...input,resultRef:'b'.repeat(64)}).expect(409);
 await request(app).post('/teacher/writing-test-result').send({...input,attemptToken:ref}).expect(400);
 signedIn=false;await request(app).post('/teacher/writing-test-result').send(input).expect(401);assert.equal(reads,1);
});
