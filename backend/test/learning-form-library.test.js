// Kho giả kiểm quyền cá nhân/chung, bản đã duyệt, copy đúng nguồn và không tạo assignment.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {createPGlitePool,initializeLearningDemoDatabase} from '../src/learning-demo.js';
import {createLearningFormDraftService} from '../src/learning-form-drafts.js';
import {createLearningFormLibrary} from '../src/learning-form-library.js';
import {previewFormImport} from '../src/learning-form-import.js';
test('Kho phiếu: không tự coi phiếu đã dùng là chuẩn; bản chụp riêng và retry đúng nguồn',async()=>{
 const db=new PGlite();try{
  await initializeLearningDemoDatabase(db);
  for(const f of ['202609160002_learning_api_mapping_schema_usage.sql','202609160005_publisher_account_lookup.sql','202610010001_progress_log_form_drafts.sql','202610220002_form_library.sql'])await db.exec(await readFile(new URL('../ops/learning-migrations/'+f,import.meta.url),'utf8'));
  await db.exec(`ALTER TABLE mapping.reviewer_account ADD COLUMN role text DEFAULT 'teacher';
   INSERT INTO mapping.classroom_course_mapping VALUES(1294,'Lớp giả','approved',NULL,NULL);
   INSERT INTO mapping.reviewer_account(email,status) VALUES('owner@example.test','active'),('other@example.test','active');
   INSERT INTO mapping.reviewer_class_access VALUES('owner@example.test',1294),('other@example.test',1294);`);
  const reviewer={email:'owner@example.test',canAccessAllClasses:false},other={email:'other@example.test',canAccessAllClasses:false},pool=createPGlitePool(db),drafts=createLearningFormDraftService({pool}),library=createLearningFormLibrary({pool,drafts});
  const payload=previewFormImport('type,prompt,skill\nreflection,Câu nguồn A,speaking').payload;payload.definition.courseCode='56';
  const draft=await drafts.create({classId:'1294',sessionNumber:11,operationId:randomUUID(),...payload,reviewer});
  const input={draftId:draft.id,expectedRevision:1,expectedHash:draft.contentHash,scope:'personal',operationId:randomUUID(),reviewer};
  assert.deepEqual(await library.list({scope:'izone',reviewer}),[]);
  const own=await library.store(input);assert.equal((await library.store(input)).id,own.id);
  assert.equal((await library.list({scope:'personal',reviewer:other})).length,0);
  await assert.rejects(()=>library.get({id:own.id,reviewer:other}),e=>e.code==='LIBRARY_ENTRY_NOT_FOUND');
  await assert.rejects(()=>library.store({...input,scope:'izone',operationId:randomUUID()}),e=>e.code==='LIBRARY_APPROVAL_REQUIRED');
  await drafts.approve({id:draft.id,expectedRevision:1,expectedHash:draft.contentHash,reviewer});
  await assert.rejects(()=>library.store({...input,scope:'izone',operationId:randomUUID()}),e=>e.code==='LIBRARY_APPROVAL_DENIED');
  await db.query("INSERT INTO learning.progress_log_admin(reviewer_email,status,grant_reference) VALUES($1,'active','Explicit test fixture authority')",[reviewer.email]);
  const shared=await library.store({...input,scope:'izone',operationId:randomUUID()});
  assert.equal((await library.list({scope:'izone',reviewer:other,skill:'speaking'})).length,1);
  const request={id:shared.id,classId:'1294',sessionNumber:12,operationId:randomUUID(),reviewer:other};
  const copy=await library.copy(request),retry=await library.copy(request);assert.equal(copy.id,retry.id);
  assert.notEqual(copy.definition.formVersionId,draft.definition.formVersionId);
  assert.equal((await library.get({id:shared.id,reviewer:other})).definition.blocks[0].items[0].prompt,'Câu nguồn A');
  assert.equal((await pool.query('SELECT count(*)::int n FROM learning.form_assignment')).rows[0].n,0);
 }finally{await db.close();}
});
