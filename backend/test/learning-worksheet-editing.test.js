import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {createPGlitePool,initializeLearningDemoDatabase} from '../src/learning-demo.js';
import {createLearningFormDraftService} from '../src/learning-form-drafts.js';
import {previewFormImport} from '../src/learning-form-import.js';
import {createLearningFormLibrary} from '../src/learning-form-library.js';
import {validateAuthoringPayload} from '../src/learning-form-authoring.js';

test('Thẻ 22: sửa nhiều lần vẫn một phiếu, retry/đồng thời không nhân, bản đã giao giữ nguyên',async()=>{
 const db=new PGlite();
 try{
  await initializeLearningDemoDatabase(db);
  for(const file of ['202609160002_learning_api_mapping_schema_usage.sql','202609160005_publisher_account_lookup.sql','202610010001_progress_log_form_drafts.sql','202610220002_form_library.sql','202610280001_form_publications.sql'])
   await db.exec(await readFile(new URL('../ops/learning-migrations/'+file,import.meta.url),'utf8'));
  // Cùng ca chạy được trên base để chứng minh lỗi trước sửa; migration chỉ có trên head.
  try{await db.exec(await readFile(new URL('../ops/learning-migrations/202610300001_worksheet_revisions.sql',import.meta.url),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  await db.exec(`INSERT INTO mapping.classroom_course_mapping VALUES(1294,'Lớp giả','approved',NULL,NULL);
   INSERT INTO mapping.reviewer_account VALUES('owner@example.test','active'),('other@example.test','active');
   INSERT INTO mapping.reviewer_class_access VALUES('owner@example.test',1294),('other@example.test',1294);
   INSERT INTO mapping.student_mapping_review(erp_course_class_id,erp_student_contact_id,erp_student_name_snapshot) VALUES(1294,123,'Học viên giả');
   INSERT INTO mapping.erp_class_membership_snapshot VALUES(1294,123);`);
  const pool=createPGlitePool(db),service=createLearningFormDraftService({pool}),reviewer={email:'owner@example.test',canAccessAllClasses:false},library=createLearningFormLibrary({pool,drafts:service});
  const payload=previewFormImport('type,prompt,skill\nreflection,Câu phản hồi nguồn,speaking').payload;payload.definition.courseCode='56';
  const a=await service.create({...payload,classId:'1294',sessionNumber:1,operationId:randomUUID(),reviewer});
  await service.approve({id:a.id,expectedRevision:a.revision,expectedHash:a.contentHash,reviewer});
  const stored=await library.store({draftId:a.id,expectedRevision:a.revision,expectedHash:a.contentHash,scope:'personal',operationId:randomUUID(),reviewer});
  const first=await service.publishLibrary({id:a.id,expectedRevision:a.revision,operationId:randomUUID(),reviewer});
  const delivered=await service.assignPublication({id:first.id,operationId:randomUUID(),targets:[{classId:'1294',sessionNumber:1}],reviewer,origin:{source:'draft',id:a.id}});assert.equal(delivered.status,'success');
  assert.equal((await db.query('SELECT source_scope FROM learning.form_assignment_origin WHERE assignment_id=$1',[delivered.results[0].delivery.assignmentId])).rows[0].source_scope,'personal');
  const commonId=randomUUID();await db.query(`INSERT INTO learning.form_library_entry(id,operation_id,owner_email,sharing_scope,source_draft_id,source_revision,course_code,title,public_definition,private_definition,content_hash,approved_by_email,approval_hash,approved_at)
   SELECT $1::uuid,$2::uuid,owner_email,'izone',source_draft_id,source_revision,course_code,title,public_definition,private_definition,content_hash,approved_by_email,approval_hash,approved_at FROM learning.form_library_entry WHERE id=$3::uuid`,[commonId,randomUUID(),stored.id]);
  const common=await service.assignPublication({id:first.id,operationId:randomUUID(),targets:[{classId:'1294',sessionNumber:2}],reviewer,origin:{source:'library',id:commonId}});assert.equal(common.status,'success');
  assert.equal((await db.query('SELECT source_scope FROM learning.form_assignment_origin WHERE assignment_id=$1',[common.results[0].delivery.assignmentId])).rows[0].source_scope,'izone');
  const before=(await db.query('SELECT public_definition,definition_hash FROM learning.form_version WHERE id=$1',[first.formVersionId])).rows[0];
  const op=randomUUID();const edit=await service.editWorksheet({id:a.id,operationId:op,reviewer});
  const assignedEdit=await service.editAssignedWorksheet({assignmentId:delivered.results[0].delivery.assignmentId,operationId:randomUUID(),reviewer});assert.equal(assignedEdit.id,edit.id);
  assert.equal(edit.worksheetId,a.id);assert.notEqual(edit.id,a.id);
  assert.equal(edit.contentHash,validateAuthoringPayload({...edit,allowIncomplete:true}).contentHash);
  const entries=await library.list({scope:'personal',reviewer,worksheetHeads:true});assert.equal(entries[0].editableDraftId,edit.id);assert.equal(entries[0].worksheetId,a.id);
  assert.equal((await service.editWorksheet({id:a.id,operationId:op,reviewer})).id,edit.id);
  assert.equal((await service.editWorksheet({id:a.id,operationId:randomUUID(),reviewer})).id,edit.id);
  edit.definition.title='Tên đã sửa';edit.definition.blocks[0].items[0].prompt='Câu đã sửa';
  const saved=await service.save({id:edit.id,expectedRevision:edit.revision,sessionNumber:1,definition:edit.definition,gradingKey:edit.gradingKey,reviewer});
  const list=await service.list({classId:'1294',reviewer,worksheetHeads:true});assert.equal(list.length,1);assert.equal(list[0].id,edit.id);assert.equal(list[0].worksheetId,a.id);
  await service.approve({id:edit.id,expectedRevision:saved.revision,expectedHash:saved.contentHash,reviewer});
  await service.publishLibrary({id:edit.id,expectedRevision:saved.revision,operationId:randomUUID(),reviewer});
  const again=await service.editWorksheet({id:edit.id,operationId:randomUUID(),reviewer});assert.equal(again.worksheetId,a.id);
  assert.equal((await service.list({classId:'1294',reviewer,worksheetHeads:true})).length,1);
  assert.deepEqual((await db.query('SELECT public_definition,definition_hash FROM learning.form_version WHERE id=$1',[first.formVersionId])).rows[0],before);
  assert.equal((await db.query('SELECT count(*)::int n FROM learning.form_assignment')).rows[0].n,2);
  assert.equal((await db.query('SELECT count(*)::int n FROM learning.submission')).rows[0].n,0);
  assert.equal((await db.query('SELECT count(*)::int n FROM learning.outbox_job')).rows[0].n,0);
  await assert.rejects(()=>service.editWorksheet({id:a.id,operationId:randomUUID(),reviewer:{...reviewer,email:'other@example.test'}}),e=>e.code==='DRAFT_NOT_FOUND');
  await assert.rejects(()=>db.query('UPDATE learning.form_version SET definition_hash=repeat(\'a\',64) WHERE id=$1',[first.formVersionId]),/IMMUTABLE/);
  const otherPayload=previewFormImport('type,prompt,skill\nreflection,Phiếu trong kho cho trình độ khác,general').payload;otherPayload.definition.courseCode='67';
  const other=await service.create({...otherPayload,classId:'1294',sessionNumber:3,operationId:randomUUID(),reviewer});
  const approval={id:other.id,expectedRevision:1,expectedHash:other.contentHash,reviewer};
  await assert.rejects(()=>service.approve(approval),e=>e.code==='DRAFT_COURSE_MISMATCH');
  await service.approve({...approval,libraryOnly:true});
  const otherPub=await service.publishLibrary({id:other.id,expectedRevision:1,operationId:randomUUID(),reviewer});
  const wrongCourse=await service.assignPublication({id:otherPub.id,operationId:randomUUID(),targets:[{classId:'1294',sessionNumber:3}],reviewer,origin:{source:'draft',id:other.id}});
  assert.equal(wrongCourse.results[0].error,'DRAFT_COURSE_MISMATCH');
 }finally{await db.close();}
});
