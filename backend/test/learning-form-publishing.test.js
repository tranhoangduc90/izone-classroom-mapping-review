import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {readFile} from 'node:fs/promises';
import express from 'express';
import request from 'supertest';
import {PGlite} from '@electric-sql/pglite';
import {createPGlitePool,initializeLearningDemoDatabase} from '../src/learning-demo.js';
import {createLearningFormDraftService} from '../src/learning-form-drafts.js';
import {createLearningService} from '../src/learning-service.js';
import {previewFormImport} from '../src/learning-form-import.js';
import {createLearningRouter} from '../src/learning-routes.js';

const owner={email:'owner@example.test',canAccessAllClasses:false},lead={email:'lead@example.test',canAccessAllClasses:false};
function content() {
  const result=previewFormImport('type,prompt,options,answer\nmcq,"Chọn phương án đúng","[{""id"":""A"",""label"":""Đúng""},{""id"":""B"",""label"":""Sai""}]",A');
  assert.deepEqual(result.errors,[]);result.payload.definition.courseCode='ic23';return result.payload;
}
test('P01–P04: quyền duyệt, khóa phiên bản, publish đồng thời/retry, trùng buổi và rollback nguyên tử',async()=>{
  const database=new PGlite();
  try {
    await initializeLearningDemoDatabase(database);
    for(const file of ['202609160002_learning_api_mapping_schema_usage.sql','202609160005_publisher_account_lookup.sql'])
      await database.exec(await readFile(new URL('../ops/learning-migrations/'+file,import.meta.url),'utf8'));
    await database.exec(await readFile(new URL('../ops/learning-migrations/202610010001_progress_log_form_drafts.sql',import.meta.url),'utf8'));
    await database.exec(`INSERT INTO mapping.classroom_course_mapping VALUES(1294,'Lớp kiểm thử','approved',NULL,NULL);
      INSERT INTO mapping.reviewer_account VALUES('owner@example.test','active'),('lead@example.test','active'),('stranger@example.test','active');
      INSERT INTO mapping.reviewer_class_access VALUES('owner@example.test',1294),('lead@example.test',1294);
      INSERT INTO mapping.student_mapping_review(erp_course_class_id,erp_student_contact_id,erp_student_name_snapshot) VALUES(1294,123,'Học viên giả');
      INSERT INTO mapping.erp_class_membership_snapshot VALUES(1294,123);
      INSERT INTO learning.course_content_authority(reviewer_email,course_code,grant_reference)
        VALUES('lead@example.test','ic23','Test fixture only');`);
    const pool=createPGlitePool(database),service=createLearningFormDraftService({pool});
    const create=async(sessionNumber=3)=>service.create({classId:'1294',sessionNumber,operationId:crypto.randomUUID(),...content(),reviewer:owner});
    const draft=await create();
    const approveInput={id:draft.id,expectedRevision:1,expectedHash:draft.contentHash,reviewer:owner};
    await assert.rejects(()=>service.approve(approveInput),e=>e.code==='DRAFT_APPROVAL_DENIED');
    const publishInput={id:draft.id,expectedRevision:1,operationId:crypto.randomUUID(),reviewer:owner};
    await assert.rejects(()=>service.publish(publishInput),e=>e.code==='DRAFT_APPROVAL_REQUIRED');
    await service.requestReview({id:draft.id,expectedRevision:1,reviewer:owner});
    assert.equal((await service.reviewQueue({classId:'1294',reviewer:lead})).length,1);
    assert.equal((await service.getReview({id:draft.id,reviewer:lead})).gradingKey.items[Object.keys(draft.gradingKey.items)[0]].expectedOptionId,'A');
    await assert.rejects(()=>service.getReview({id:draft.id,reviewer:{email:'stranger@example.test',canAccessAllClasses:false}}),e=>e.httpStatus===403);
    await service.approve({...approveInput,reviewer:lead});
    await database.exec(`UPDATE learning.course_content_authority SET status='revoked',revoked_at=now();`);
    await assert.rejects(()=>service.publish(publishInput),e=>e.code==='DRAFT_APPROVAL_REVOKED');
    await database.exec(`UPDATE learning.course_content_authority SET status='active',revoked_at=NULL;`);
    const duplicate=await create();await service.requestReview({id:duplicate.id,expectedRevision:1,reviewer:owner});
    await service.approve({id:duplicate.id,expectedRevision:1,expectedHash:duplicate.contentHash,reviewer:lead});
    const races=await Promise.allSettled([service.publish(publishInput),service.publish({...publishInput,id:duplicate.id,operationId:crypto.randomUUID()})]);
    assert.equal(races.filter(r=>r.status==='fulfilled').length,1);
    assert.equal(races.find(r=>r.status==='rejected').reason.code,'ASSIGNMENT_SESSION_CONFLICT');
    const published=races[0].value;assert.ok(published);assert.equal(published.rosterCount,1);assert.equal(published.blockCount,1);
    const retry=await service.publish(publishInput);assert.equal(retry.assignmentId,published.assignmentId);assert.equal(retry.replayed,true);
    await assert.rejects(()=>service.publish({...publishInput,operationId:crypto.randomUUID()}),e=>e.code==='DRAFT_ALREADY_PUBLISHED');
    await assert.rejects(()=>service.save({id:draft.id,expectedRevision:1,sessionNumber:3,definition:draft.definition,gradingKey:draft.gradingKey,reviewer:owner}),e=>e.code==='DRAFT_ALREADY_PUBLISHED');
    await assert.rejects(()=>database.query('UPDATE learning.form_version SET definition_hash=$2 WHERE id=$1::uuid',[published.formVersionId,'0'.repeat(64)]),e=>e.message.includes('PUBLISHED_FORM_IMMUTABLE'));
    await assert.rejects(()=>database.query('UPDATE learning.form_grading_key SET grader_version=2 WHERE form_version_id=$1::uuid',[published.formVersionId]),e=>e.message.includes('PUBLISHED_FORM_IMMUTABLE'));
    const before=await database.query('SELECT count(*)::integer AS n FROM learning.form_assignment;');assert.equal(before.rows[0].n,1);
    const next=await create(4);await service.requestReview({id:next.id,expectedRevision:1,reviewer:owner});
    await service.approve({id:next.id,expectedRevision:1,expectedHash:next.contentHash,reviewer:lead});
    const edited=structuredClone(next.definition);edited.title='Nội dung đổi sau khi duyệt';
    const saved=await service.save({id:next.id,expectedRevision:1,sessionNumber:4,definition:edited,gradingKey:next.gradingKey,reviewer:owner});
    await assert.rejects(()=>service.publish({id:next.id,expectedRevision:2,operationId:crypto.randomUUID(),reviewer:owner}),e=>e.code==='DRAFT_APPROVAL_REQUIRED');
    await service.requestReview({id:next.id,expectedRevision:2,reviewer:owner});await service.approve({id:next.id,expectedRevision:2,expectedHash:saved.contentHash,reviewer:lead});
    // Gây lỗi sau khi tạo assignment nhưng trước roster: transaction phải bỏ toàn bộ writes.
    const brokenPool={query:pool.query,async connect(){const client=await pool.connect();return {release:client.release,
      query(sql,params){if(sql.startsWith('INSERT INTO learning.form_assignment_roster'))throw new Error('Injected roster failure');return client.query(sql,params);}};}};
    const broken=createLearningFormDraftService({pool:brokenPool});
    await assert.rejects(()=>broken.publish({id:next.id,expectedRevision:2,operationId:crypto.randomUUID(),reviewer:owner}),/Injected roster failure/);
    assert.equal((await database.query('SELECT count(*)::integer AS n FROM learning.form_assignment;')).rows[0].n,1);
    assert.equal((await service.get({id:next.id,reviewer:owner})).status,'approved');
    assert.equal((await database.query('SELECT count(*)::integer AS n FROM learning.form_version;')).rows[0].n,1);
    const app=express();app.use(express.json({limit:'1mb'}));app.use('/api/learning',createLearningRouter({pool,authenticate(req,_res,next){req.reviewer=owner;next();}}));
    const publicForm=await request(app).post('/api/learning/assignments/open').send({publicToken:published.publicToken}).expect(200);
    assert.equal(publicForm.body.assignment.definition.formVersionId,published.formVersionId);assert.equal(publicForm.body.assignment.roster.length,1);
    assert.ok(!JSON.stringify(publicForm.body).includes('expectedOptionId'));assert.ok(!JSON.stringify(publicForm.body).includes('gradingKey'));
    const ownGet=await request(app).get('/api/learning/teacher/form-drafts/'+draft.id).expect(200);assert.equal(ownGet.headers['cache-control'],'no-store');
    assert.equal(ownGet.body.draft.publicToken,published.publicToken);
    await request(app).post('/api/learning/teacher/form-drafts/'+next.id+'/publish').send({expectedRevision:2,operationId:'bad'}).expect(400);
    // Dùng chính vai trò API để kiểm cổng GRANT, không chỉ chạy bằng chủ DB trong fixture.
    await database.exec('SET ROLE learning_api;');
    const actual=await service.publish({id:next.id,expectedRevision:2,operationId:crypto.randomUUID(),reviewer:owner});assert.equal(actual.rosterCount,1);
    await database.exec('RESET ROLE;');
    assert.equal((await database.query('SELECT count(*)::integer AS n FROM learning.outbox_job;')).rows[0].n,0);
    // Migration chạy lại không đổi nội dung đã publish, khóa chấm hoặc danh sách học viên.
    const migration=await readFile(new URL('../ops/learning-migrations/202610010001_progress_log_form_drafts.sql',import.meta.url),'utf8');
    await database.exec(migration);await database.exec(migration);
    assert.equal((await service.get({id:draft.id,reviewer:owner})).publicToken,published.publicToken);
    const legacy=createLearningService({pool});
    const legacyInput={reviewer:owner,title:'Phiếu thư viện',courseCode:'ic23',classId:'1294',sessionNumber:3,
      items:[{libraryItemId:'10000000-0000-4000-8000-000000000001',checkpoint:1,required:true}]};
    await assert.rejects(()=>legacy.publishReflectionForm(legacyInput),e=>e.code==='ASSIGNMENT_SESSION_CONFLICT'&&e.httpStatus===409);
    const unscored=content();for(const item of unscored.definition.blocks.flatMap(block=>block.items)){item.graderType='none';item.maxScore=0;}unscored.gradingKey.items={};
    for(const oldFirst of [false,true]) {
      const sessionNumber=oldFirst?6:5;
      const candidate=await service.create({classId:'1294',sessionNumber,operationId:crypto.randomUUID(),...structuredClone(unscored),reviewer:owner});
      await service.approve({id:candidate.id,expectedRevision:1,expectedHash:candidate.contentHash,reviewer:owner});
      const old=()=>legacy.publishReflectionForm({...legacyInput,sessionNumber});
      const modern=()=>service.publish({id:candidate.id,expectedRevision:1,operationId:crypto.randomUUID(),reviewer:owner});
      const calls=oldFirst?[old(),modern()]:[modern(),old()];const race=await Promise.allSettled(calls);
      assert.equal(race.filter(value=>value.status==='fulfilled').length,1);
      assert.equal(race.find(value=>value.status==='rejected').reason.code,'ASSIGNMENT_SESSION_CONFLICT');
      assert.equal((await database.query('SELECT count(*)::integer AS n FROM learning.form_assignment WHERE session_number=$1;',[sessionNumber])).rows[0].n,1);
    }
    // Luồng thay thế có kiểm riêng vẫn được tạo bản mới rồi retire bản cũ trong cùng transaction.
    const old=await legacy.publishReflectionForm({...legacyInput,sessionNumber:7});
    await database.exec('BEGIN;');
    const replacement=await database.query(`INSERT INTO learning.form_assignment(form_version_id,course_code,erp_course_class_id,
      class_name_snapshot,session_number,title,created_by_email) SELECT form_version_id,course_code,erp_course_class_id,
      class_name_snapshot,session_number,'Bản thay thế giả',created_by_email FROM learning.form_assignment WHERE id=$1::uuid RETURNING id;`,[old.assignmentId]);
    await database.query("UPDATE learning.form_assignment SET status='retired' WHERE id=$1::uuid;",[old.assignmentId]);
    await database.exec('COMMIT;');assert.ok(replacement.rows[0].id);
    assert.equal((await database.query("SELECT count(*)::integer AS n FROM learning.form_assignment WHERE session_number=7 AND status IN ('published','closed');")).rows[0].n,1);
    // Đổi mã của bản trùng trước COMMIT không được làm deferred guard mất dấu dòng.
    await database.exec('BEGIN;');
    const duplicateRow=await database.query(`INSERT INTO learning.form_assignment(form_version_id,course_code,erp_course_class_id,
      class_name_snapshot,session_number,title,created_by_email) SELECT form_version_id,course_code,erp_course_class_id,
      class_name_snapshot,session_number,'Bản trùng giả',created_by_email FROM learning.form_assignment WHERE id=$1::uuid RETURNING id;`,[replacement.rows[0].id]);
    await assert.rejects(()=>database.query('UPDATE learning.form_assignment SET id=$1::uuid WHERE id=$2::uuid;',
      [crypto.randomUUID(),duplicateRow.rows[0].id]),error=>error.code==='23514'&&error.message.includes('ASSIGNMENT_ID_IMMUTABLE'));
    await database.exec('ROLLBACK;');
    assert.equal((await database.query("SELECT count(*)::integer AS n FROM learning.form_assignment WHERE session_number=7 AND status IN ('published','closed');")).rows[0].n,1);
  }finally{await database.close();}
});
