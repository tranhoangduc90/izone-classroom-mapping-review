import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {readFile} from 'node:fs/promises';
import express from 'express';
import request from 'supertest';
import {PGlite} from '@electric-sql/pglite';
import {createLearningDemoApp,createPGlitePool,initializeLearningDemoDatabase} from '../src/learning-demo.js';
import {createLearningRouter} from '../src/learning-routes.js';
import {createLearningFormDraftService} from '../src/learning-form-drafts.js';
import {previewFormImport} from '../src/learning-form-import.js';
import {createLearningDraftDemoGrant,verifyLearningDemoGrant} from '../src/learning-demo-grant.js';

test('D06/P04: nháp xem thử/nộp/reset ở DB riêng; grant hết hạn/đổi revision bị chặn, lớp thật không đổi',async()=>{
  const sourceDb=new PGlite(),demoDb=new PGlite(),secret='test-draft-preview-secret-01234567890123456789';
  const origin='https://tranhoangduc90.github.io',headers={origin,'x-progress-log-demo':'1'};
  try {
    await initializeLearningDemoDatabase(sourceDb);await initializeLearningDemoDatabase(demoDb);
    await sourceDb.exec("ALTER TABLE mapping.reviewer_account ADD COLUMN role TEXT DEFAULT 'teacher', ADD COLUMN can_access_all_classes BOOLEAN DEFAULT false;");
    await sourceDb.exec(await readFile(new URL('../ops/learning-migrations/202610010001_progress_log_form_drafts.sql',import.meta.url),'utf8'));
    await sourceDb.exec(`INSERT INTO mapping.classroom_course_mapping VALUES(1294,'Lớp thật fixture','approved',NULL,NULL);
      INSERT INTO mapping.reviewer_account(email,status) VALUES('owner@example.test','active');
      INSERT INTO mapping.reviewer_class_access VALUES('owner@example.test',1294);`);
    const reviewer={email:'owner@example.test',canAccessAllClasses:false},pool=createPGlitePool(sourceDb),drafts=createLearningFormDraftService({pool});
    const checked=previewFormImport('type,prompt\nreflection,Em đã hiểu điều gì?');assert.deepEqual(checked.errors,[]);
    const draft=await drafts.create({classId:'1294',sessionNumber:3,operationId:crypto.randomUUID(),...checked.payload,reviewer});
    const sourceApp=express();sourceApp.use(express.json());sourceApp.use('/api/learning',createLearningRouter({pool,demoSourceSecret:secret,
      authenticate(req,_res,next){req.reviewer=reviewer;next();}}));
    const granted=await request(sourceApp).post('/api/learning/teacher/form-drafts/'+draft.id+'/preview-grant').send({expectedRevision:1}).expect(200);
    const grant=granted.body.grant;assert.equal(verifyLearningDemoGrant(grant,secret).draftId,draft.id);
    assert.ok(!Buffer.from(grant.split('.')[0],'base64url').toString().includes('gradingKey'));
    await request(sourceApp).post('/api/learning/assignments/demo-source').send({grant}).expect(404);
    const source=await request(sourceApp).post('/api/learning/assignments/demo-source').set('x-learning-demo-source',secret).send({grant}).expect(200);
    assert.equal(source.headers['cache-control'],'no-store');assert.equal(source.body.source.sourceDraftId,draft.id);
    const app=createLearningDemoApp({pool:createPGlitePool(demoDb),allowedOrigin:origin,grantSecret:secret,
      fetchSource:async value=>{
        assert.equal(typeof value,'object');const response=await request(sourceApp).post('/api/learning/assignments/demo-source')
          .set('x-learning-demo-source',secret).send(value);assert.equal(response.status,200);return response.body.source;
      }});
    const expired=createLearningDraftDemoGrant({draft,reviewer,secret,now:Date.now()-301000});
    await request(app).post('/api/demo/runs').set(headers).send({grant:expired}).expect(403);
    await request(app).post('/api/demo/runs').set(headers).send({grant:grant.slice(0,-3)+'AAA'}).expect(403);
    const created=await request(app).post('/api/demo/runs').set(headers).send({grant}).expect(201);
    const run=created.body.run;
    const form=(await request(app).post('/api/learning/assignments/open').set(headers).send({publicToken:run.publicToken}).expect(200)).body.assignment;
    assert.equal(form.definition.title,draft.definition.title);assert.notEqual(form.definition.formVersionId,draft.definition.formVersionId);
    assert.equal(form.roster.length,3);assert.ok(form.roster.every(student=>student.name.startsWith('Học viên mẫu')));
    const attempt=(await request(app).post('/api/learning/attempts/start').set(headers).send({publicToken:run.publicToken,
      studentRef:form.roster[0].studentRef,clientIdempotencyKey:crypto.randomUUID(),identityConfirmed:true}).expect(201)).body.attempt;
    const responses=Object.fromEntries(form.definition.blocks.flatMap(block=>block.items).map(item=>[item.itemVersionId,'Nội dung thử']))
    const submitted=await request(app).post('/api/learning/attempts/submit').set(headers).send({attemptToken:attempt.attemptToken,
      submissionId:crypto.randomUUID(),definitionHash:form.definitionHash,draftRevision:0,responses}).expect(200);
    assert.equal(submitted.body.receipt.completeness,'complete');
    const changed=structuredClone(draft.definition);changed.title='Nháp đã đổi sau khi xem thử';
    await drafts.save({id:draft.id,expectedRevision:1,sessionNumber:3,definition:changed,gradingKey:draft.gradingKey,reviewer});
    await request(sourceApp).post('/api/learning/assignments/demo-source').set('x-learning-demo-source',secret).send({grant}).expect(409);
    const teacherHeaders={...headers,'x-demo-teacher-token':run.teacherToken};
    const reset=await request(app).post('/api/demo/runs/reset').set(teacherHeaders).send({}).expect(201);
    const resetForm=await request(app).post('/api/learning/assignments/open').set(headers).send({publicToken:reset.body.run.publicToken}).expect(200);
    assert.equal(resetForm.body.assignment.definition.title,draft.definition.title);
    const counts=(await sourceDb.query(`SELECT (SELECT count(*)::integer FROM learning.form_assignment) AS assignments,
      (SELECT count(*)::integer FROM learning.submission) AS submissions,(SELECT count(*)::integer FROM learning.outbox_job) AS jobs,
      (SELECT count(*)::integer FROM learning.form_draft) AS drafts;`)).rows[0];
    assert.deepEqual(counts,{assignments:0,submissions:0,jobs:0,drafts:1});
    // Grant giữ cờ admin cũ: phía nguồn phải đọc lại quyền vừa thu hồi, dù account còn active.
    const current=await drafts.get({id:draft.id,reviewer});
    await sourceDb.exec("DELETE FROM mapping.reviewer_class_access; UPDATE mapping.reviewer_account SET role='admin';");
    const adminGrant=createLearningDraftDemoGrant({draft:current,reviewer:{...reviewer,canAccessAllClasses:true},secret});
    await request(sourceApp).post('/api/learning/assignments/demo-source').set('x-learning-demo-source',secret).send({grant:adminGrant}).expect(200);
    await sourceDb.exec("UPDATE mapping.reviewer_account SET role='teacher';");
    await request(sourceApp).post('/api/learning/assignments/demo-source').set('x-learning-demo-source',secret).send({grant:adminGrant}).expect(403);
    await sourceDb.exec("INSERT INTO learning.progress_log_admin(reviewer_email,grant_reference) VALUES('owner@example.test','Test fixture only');");
    await request(sourceApp).post('/api/learning/assignments/demo-source').set('x-learning-demo-source',secret).send({grant:adminGrant}).expect(200);
    await sourceDb.exec("UPDATE learning.progress_log_admin SET status='revoked';");
    await request(sourceApp).post('/api/learning/assignments/demo-source').set('x-learning-demo-source',secret).send({grant:adminGrant}).expect(403);
    await sourceDb.exec("INSERT INTO mapping.reviewer_class_access VALUES('owner@example.test',1294);");
    await request(sourceApp).post('/api/learning/assignments/demo-source').set('x-learning-demo-source',secret).send({grant:adminGrant}).expect(200);
    await sourceDb.exec("UPDATE mapping.reviewer_account SET status='inactive';");
    const revoked=createLearningDraftDemoGrant({draft:current,reviewer,secret});
    await request(sourceApp).post('/api/learning/assignments/demo-source').set('x-learning-demo-source',secret).send({grant:revoked}).expect(403);
  }finally{await sourceDb.close();await demoDb.close();}
});
