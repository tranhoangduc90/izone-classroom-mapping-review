// Request trái quyền có body/query riêng tư: log chỉ giữ route mẫu, thời gian và HTTP status.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import {createLearningRouter} from '../src/learning-routes.js';
test('log nâng cấp ghi metadata/correlation, không ghi request private và logger lỗi không đổi outcome',async()=>{
  const logs=[],pool={query(){throw new Error('DB must not be called');}},app=express();app.use(express.json());
  app.use('/api/learning',createLearningRouter({pool,logger:{info:value=>logs.push(JSON.parse(value))},
    authenticate(_req,res){res.status(403).json({ok:false});}}));
  await request(app).post('/api/learning/teacher/form-drafts').query({email:'private@example.test'})
    .send({gradingKey:'PRIVATE_TEST_CONTENT',grant:'PRIVATE_TEST_GRANT'}).expect(403);
  assert.equal(logs.length,1);assert.equal(logs[0].status,403);assert.equal(logs[0].operation,'/teacher/form-drafts');
  assert.ok(logs[0].durationMs>=0);assert.match(logs[0].correlation,/^[a-f0-9-]{36}$/u);
  assert.ok(!JSON.stringify(logs).includes('private@'));assert.ok(!JSON.stringify(logs).includes('PRIVATE_TEST'));
  const broken=express();broken.use('/api/learning',createLearningRouter({pool,logger:{info(){throw new Error('logger offline');}},
    authenticate(_req,res){res.status(403).json({ok:false});}}));
  await request(broken).get('/api/learning/teacher/form-drafts').expect(403);
});
