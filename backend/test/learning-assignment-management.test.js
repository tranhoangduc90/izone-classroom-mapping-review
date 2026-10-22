// Kiểm dữ liệu giả: gia hạn sau mốc tự khóa, giữ nháp/nộp/điểm danh và chỉ GV đọc bài thu hồi.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {initializeLearningDemoDatabase,createPGlitePool} from '../src/learning-demo.js';
import {createLearningFormDraftService} from '../src/learning-form-drafts.js';
import {previewFormImport} from '../src/learning-form-import.js';
import {createLearningService} from '../src/learning-service.js';
import {createLearningAssignmentManagement} from '../src/learning-assignment-management.js';
import {readSubmissionWindow} from '../src/learning-submission-deadline.js';
test('Gia hạn/thu hồi: quyền, revision, retry, giữ dữ liệu và mở phiếu thay đúng buổi',async()=>{
 const db=new PGlite();try{
  await initializeLearningDemoDatabase(db);
  for(const file of ['202609160002_learning_api_mapping_schema_usage.sql','202609160005_publisher_account_lookup.sql'])
    await db.exec(await readFile(new URL('../ops/learning-migrations/'+file,import.meta.url),'utf8'));
  await db.exec(await readFile(new URL('../ops/learning-migrations/202610010001_progress_log_form_drafts.sql',import.meta.url),'utf8'));
  await db.exec(`INSERT INTO mapping.classroom_course_mapping VALUES(1294,'Lớp fixture','approved',NULL,NULL);
   INSERT INTO mapping.reviewer_account VALUES('owner@example.test','active');
   INSERT INTO mapping.reviewer_class_access VALUES('owner@example.test',1294);
   INSERT INTO mapping.student_mapping_review(erp_course_class_id,erp_student_contact_id,erp_student_name_snapshot) VALUES(1294,123,'Người thử');
   INSERT INTO mapping.erp_class_membership_snapshot VALUES(1294,123);`);
  const pool=createPGlitePool(db),reviewer={email:'owner@example.test',canAccessAllClasses:false},drafts=createLearningFormDraftService({pool});
  const publish=async()=>{const payload=previewFormImport('type,prompt\nreflection,Nhìn lại bài học').payload;
   const d=await drafts.create({classId:'1294',sessionNumber:11,operationId:randomUUID(),...payload,reviewer});
   await drafts.approve({id:d.id,expectedRevision:1,expectedHash:d.contentHash,reviewer});
   return drafts.publish({id:d.id,expectedRevision:1,operationId:randomUUID(),reviewer});};
  const p=await publish(),service=createLearningService({pool}),management=createLearningAssignmentManagement({pool});
  const form=await service.getPublicAssignment(p.publicToken),studentRef=form.roster[0].studentRef;
  const attempt=await service.startAttempt({publicToken:p.publicToken,studentRef,clientIdempotencyKey:randomUUID(),identityConfirmed:true});
  const item=form.definition.blocks[0].items[0];
  await service.saveDraft({attemptToken:attempt.attemptToken,revision:1,definitionHash:form.definitionHash,responses:{[item.itemVersionId]:'Nháp cần giữ'}});
  await db.query(`UPDATE learning.form_assignment SET auto_submission_threshold_at=now()-interval '2 days',auto_submission_closes_at=now()-interval '1 day' WHERE id=$1`,[p.assignmentId]);
  assert.equal((await readSubmissionWindow(pool,p.assignmentId)).canSubmit,false);
  const closesAt=new Date(Date.now()+86400000).toISOString(),change={assignmentId:p.assignmentId,action:'extend',closesAt,reason:'Mạng lớp gián đoạn',expectedRevision:0,operationId:randomUUID(),reviewer};
  await assert.rejects(()=>management.change({...change,reviewer:{email:'stranger@example.test',canAccessAllClasses:false}}),e=>e.code==='ASSIGNMENT_ACCESS_DENIED');
  await db.exec('SET ROLE learning_api');
  const extended=await management.change(change);assert.equal(extended.revision,1);
  assert.equal((await management.change(change)).replayed,true);
  await assert.rejects(()=>management.change({...change,operationId:randomUUID()}),e=>e.code==='MANAGEMENT_STALE');
  assert.equal((await readSubmissionWindow(pool,p.assignmentId)).canSubmit,true);
  await service.submitCheckpoint({attemptToken:attempt.attemptToken,checkpointSubmissionId:randomUUID(),blockId:form.definition.blocks[0].blockId,checkpoint:1,draftRevision:1,definitionHash:form.definitionHash,responses:{[item.itemVersionId]:'Nháp cần giữ'},idempotencyKey:randomUUID()});
  const counts=async()=> (await pool.query(`SELECT (SELECT count(*)::int FROM learning.attempt) attempts,
   (SELECT count(*)::int FROM learning.checkpoint_submission) checkpoints,(SELECT count(*)::int FROM learning.attendance_event) attendance,
   (SELECT count(*)::int FROM learning.outbox_job) jobs`)).rows[0];
  const before=await counts();assert.equal(before.checkpoints,1);assert.equal(before.attendance,1);
  await management.change({assignmentId:p.assignmentId,action:'withdraw',reason:'Giao nhầm phiếu',expectedRevision:1,operationId:randomUUID(),reviewer});
  assert.deepEqual(await counts(),before);
  await assert.rejects(()=>service.getPublicAssignment(p.publicToken),e=>e.code==='ASSIGNMENT_NOT_AVAILABLE');
  assert.equal((await management.history({classId:'1294',reviewer})).length,1);
  const live=await service.getTeacherLiveDrafts({assignmentId:p.assignmentId,reviewer});assert.ok(JSON.stringify(live).includes('Nháp cần giữ'));
  await db.exec('RESET ROLE');const replacement=await publish();assert.notEqual(replacement.assignmentId,p.assignmentId);
  assert.equal((await service.getPublicAssignment(replacement.publicToken)).roster.length,1);
  assert.equal((await management.get({assignmentId:p.assignmentId,reviewer})).history.length,2);
 }finally{await db.close();}
});
