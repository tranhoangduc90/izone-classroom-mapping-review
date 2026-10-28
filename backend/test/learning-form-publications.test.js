// Dữ liệu giả cách ly: xuất bản không mở lớp; giao đúng đích, retry, lỗi một phần và quyền role API.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import express from 'express';
import request from 'supertest';
import {createPGlitePool,initializeLearningDemoDatabase} from '../src/learning-demo.js';
import {createLearningFormDraftService} from '../src/learning-form-drafts.js';
import {previewFormImport} from '../src/learning-form-import.js';
import {createLearningRouter} from '../src/learning-routes.js';

test('R22/R30: xuất bản riêng, giao nhiều đích, giữ thành công khi lỗi một phần và retry không nhân',async()=>{
  const db=new PGlite();
  try{
    await initializeLearningDemoDatabase(db);
    for(const file of ['202609160002_learning_api_mapping_schema_usage.sql','202609160005_publisher_account_lookup.sql',
      '202610010001_progress_log_form_drafts.sql','202610220002_form_library.sql','202610280001_form_publications.sql'])
      await db.exec(await readFile(new URL('../ops/learning-migrations/'+file,import.meta.url),'utf8'));
    await db.exec(`INSERT INTO mapping.classroom_course_mapping VALUES
      (1294,'Lớp giả A','approved',NULL,NULL),(1295,'Lớp giả B','approved',NULL,NULL),(1296,'Lớp chưa có quyền','approved',NULL,NULL);
      INSERT INTO mapping.reviewer_account VALUES('owner@example.test','active');
      INSERT INTO mapping.reviewer_class_access VALUES('owner@example.test',1294),('owner@example.test',1295);
      INSERT INTO mapping.student_mapping_review(erp_course_class_id,erp_student_contact_id,erp_student_name_snapshot)
        VALUES(1294,123,'Học viên giả A'),(1295,124,'Học viên giả B');
      INSERT INTO mapping.erp_class_membership_snapshot VALUES(1294,123),(1295,124);`);
    const reviewer={email:'owner@example.test',canAccessAllClasses:false},pool=createPGlitePool(db),service=createLearningFormDraftService({pool});
    const payload=previewFormImport('type,prompt,skill\nreflection,Câu phản hồi nguồn,speaking').payload;
    payload.definition.courseCode='56';
    const draft=await service.create({classId:'1294',sessionNumber:3,operationId:randomUUID(),...payload,reviewer});
    const publishing={id:draft.id,expectedRevision:1,operationId:randomUUID(),reviewer};
    await assert.rejects(()=>service.publishLibrary(publishing),e=>e.code==='DRAFT_APPROVAL_REQUIRED');
    await service.approve({id:draft.id,expectedRevision:1,expectedHash:draft.contentHash,reviewer});
    const publication=await service.publishLibrary(publishing);
    assert.equal(publication.formVersionId,draft.definition.formVersionId);
    await assert.rejects(()=>db.query("UPDATE learning.form_version SET public_definition=jsonb_set(public_definition,'{title}','\"Đổi sau xuất bản\"') WHERE id=$1::uuid",[publication.formVersionId]),/LIBRARY_PUBLISHED_CONTENT_IMMUTABLE/);
    await assert.rejects(()=>db.query('UPDATE learning.form_grading_key SET grader_version=999 WHERE form_version_id=$1::uuid',[publication.formVersionId]),/LIBRARY_PUBLISHED_CONTENT_IMMUTABLE/);
    assert.equal((await service.publishLibrary(publishing)).id,publication.id);
    const copying={id:draft.id,classId:'1294',sessionNumber:4,operationId:randomUUID(),reviewer};
    const copy=await service.copyDraft(copying),copyAgain=await service.copyDraft(copying);
    assert.equal(copy.id,copyAgain.id);assert.notEqual(copy.definition.formVersionId,publication.formVersionId);
    copy.definition.title='Bản riêng còn sửa được';
    const edited=await service.save({id:copy.id,expectedRevision:1,sessionNumber:4,definition:copy.definition,gradingKey:copy.gradingKey,reviewer});
    assert.equal(edited.revision,2);assert.equal(edited.definition.title,'Bản riêng còn sửa được');
    await assert.rejects(()=>service.publishLibrary({...publishing,operationId:randomUUID()}),e=>e.code==='PUBLICATION_OPERATION_CONFLICT');
    for(const table of ['form_assignment','form_assignment_roster','assignment_block_release','outbox_job','submission'])
      assert.equal((await db.query('SELECT count(*)::int n FROM learning.'+table)).rows[0].n,0,table);
    await assert.rejects(()=>service.save({id:draft.id,expectedRevision:1,sessionNumber:3,
      definition:draft.definition,gradingKey:draft.gradingKey,reviewer}),/LIBRARY_PUBLISHED_DRAFT_IMMUTABLE/);
    const input={id:publication.id,operationId:randomUUID(),reviewer,targets:[{classId:'1294',sessionNumber:3},
      {classId:'1295',sessionNumber:4},{classId:'1296',sessionNumber:5}]};
    await db.exec('SET ROLE learning_api');
    const assigned=await service.assignPublication(input);assert.equal(assigned.status,'partial');
    assert.deepEqual(assigned.results.map(r=>r.ok),[true,true,false]);
    assert.equal(assigned.results[2].status,403);
    const retry=await service.assignPublication(input);assert.deepEqual(retry.results.slice(0,2).map(r=>r.delivery.replayed),[true,true]);
    assert.deepEqual(retry.results.slice(0,2).map(r=>r.delivery.assignmentId),assigned.results.slice(0,2).map(r=>r.delivery.assignmentId));
    await db.exec('RESET ROLE');
    assert.equal((await db.query('SELECT count(*)::int n FROM learning.form_assignment')).rows[0].n,2);
    assert.equal((await db.query('SELECT count(*)::int n FROM learning.submission')).rows[0].n,0);
    assert.equal((await db.query('SELECT count(*)::int n FROM learning.outbox_job')).rows[0].n,0);
    const conflict=await service.assignPublication({...input,operationId:randomUUID(),targets:[input.targets[0]]});
    assert.equal(conflict.status,'failure');assert.equal(conflict.results[0].error,'ASSIGNMENT_SESSION_CONFLICT');
    await assert.rejects(()=>service.assignPublication({...input,targets:[input.targets[0],input.targets[0]]}),e=>e.code==='DELIVERY_DUPLICATE_TARGET');
    const app=express();app.use(express.json());app.use('/api/learning',createLearningRouter({pool,authenticate(req,_res,next){req.reviewer=reviewer;next();}}));
    const listed=await request(app).get('/api/learning/teacher/form-publications').expect(200);
    assert.equal(listed.body.publications[0].id,publication.id);assert.ok(!JSON.stringify(listed.body).includes('private_definition'));
    const response=await request(app).post('/api/learning/teacher/form-publications/'+publication.id+'/assign')
      .send({operationId:input.operationId,targets:[input.targets[0]]}).expect(200);
    assert.equal(response.body.delivery.results[0].delivery.replayed,true);
    await request(app).post('/api/learning/teacher/form-publications/'+publication.id+'/assign').send({operationId:randomUUID(),targets:[]}).expect(400);
    await db.exec(await readFile(new URL('../ops/learning-migrations/202610280001_form_publications.sql',import.meta.url),'utf8'));
    assert.equal((await service.listPublications({reviewer})).length,1);
  }finally{await db.close();}
});
