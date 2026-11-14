// Kho giả kiểm quyền cá nhân/chung, bản đã duyệt, copy đúng nguồn và không tạo assignment.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import pg from 'pg';
import {createPGlitePool,initializeLearningDemoDatabase} from '../src/learning-demo.js';
import {createLearningFormDraftService} from '../src/learning-form-drafts.js';
import {createLearningFormLibrary} from '../src/learning-form-library.js';
import {archiveCatalog} from '../src/learning-catalog-archive.js';
import {previewFormImport} from '../src/learning-form-import.js';
import {createLearningLibraryDemoGrant,verifyLearningDemoGrant} from '../src/learning-demo-grant.js';
async function openLibraryFixture(){
 if(!process.env.PROGRESS_LOG_FIXTURE_URL){
  const db=new PGlite();
  return {db,pool:createPGlitePool(db),close:()=>db.close()};
 }
 const url=new URL(process.env.PROGRESS_LOG_FIXTURE_URL);
 assert.equal(url.origin,'null');
 assert.equal(url.hostname,'127.0.0.1');
 assert.equal(url.port,'16547');
 assert.equal(url.pathname,'/progress_log_fixture');
 const admin=new pg.Pool({connectionString:url.toString()});
 const name='pl_library_'+randomUUID().replaceAll('-','');
 try{await admin.query('CREATE DATABASE '+name);}catch(error){await admin.end();throw error;}
 url.pathname='/'+name;
 const setup=new pg.Pool({connectionString:url.toString()});
 const app=new pg.Pool({connectionString:url.toString(),options:'-c role=learning_api'});
 return {
  db:{query:(sql,params)=>setup.query(sql,params),exec:sql=>setup.query(sql)},
  pool:app,
  async close(){
   try{
    await Promise.all([app.end(),setup.end()]);
    await admin.query('DROP DATABASE '+name);
   }finally{await admin.end();}
  }
 };
}

test('Kho phiếu: không tự coi phiếu đã dùng là chuẩn; bản chụp riêng và retry đúng nguồn',async()=>{
 const {db,pool,close}=await openLibraryFixture();try{
  await initializeLearningDemoDatabase(db);
  for(const f of ['202609160002_learning_api_mapping_schema_usage.sql','202609160005_publisher_account_lookup.sql','202610010001_progress_log_form_drafts.sql','202610220002_form_library.sql','202610280001_form_publications.sql','202610300001_worksheet_revisions.sql','202611040001_form_assignment_portal_target.sql','202611090001_class_draft_delivery.sql','202611090002_shared_course_drafts.sql','202611140001_personal_library_drafts.sql'])await db.exec(await readFile(new URL('../ops/learning-migrations/'+f,import.meta.url),'utf8'));
  await db.exec(`ALTER TABLE mapping.reviewer_account ADD COLUMN role text DEFAULT 'teacher';
   INSERT INTO mapping.classroom_course_mapping VALUES(1294,'Lớp giả','approved',NULL,NULL);
   INSERT INTO mapping.reviewer_account(email,status) VALUES('owner@example.test','active'),('other@example.test','active');
   INSERT INTO mapping.reviewer_class_access VALUES('owner@example.test',1294),('other@example.test',1294);
   GRANT USAGE ON SCHEMA mapping TO learning_api;
   GRANT SELECT ON ALL TABLES IN SCHEMA mapping TO learning_api;`);
  const reviewer={email:'owner@example.test',canAccessAllClasses:false},other={email:'other@example.test',canAccessAllClasses:false};
  const startsAt='2026-11-14 18:30:00',portalId='123456';
  const portalAssignmentReader=async classId=>({classId,sessions:[{erpSessionId:portalId,startsAt,endsAt:'2026-11-14 21:00:00',date:'2026-11-14',statusCode:1}]});
  const drafts=createLearningFormDraftService({pool,portalAssignmentReader}),library=createLearningFormLibrary({pool,drafts});
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
  const preview=await library.previewInfo({id:shared.id,reviewer:other}),secret='test-library-preview-secret-only-not-production';
  const token=createLearningLibraryDemoGrant({entry:preview,reviewer:other,secret}),grant=verifyLearningDemoGrant(token,secret);
  assert.equal(grant.kind,'library');assert.equal(grant.entryId,shared.id);
  const source=await library.demoSource({grant});assert.equal(source.sourceLibraryId,shared.id);assert.equal(source.title,draft.definition.title);
  await assert.rejects(()=>library.demoSource({grant:{...grant,contentHash:'0'.repeat(64)}}),e=>e.code==='LIBRARY_PREVIEW_STALE');
  await db.query("UPDATE mapping.reviewer_account SET status='inactive' WHERE email=$1",[other.email]);
  await assert.rejects(()=>library.demoSource({grant}),e=>e.code==='LIBRARY_PREVIEW_DENIED');
  await db.query("UPDATE mapping.reviewer_account SET status='active' WHERE email=$1",[other.email]);
  assert.equal((await library.list({scope:'izone',reviewer:other,skill:'speaking'})).length,1);
  const request={id:shared.id,classId:'1294',sessionNumber:12,operationId:randomUUID(),reviewer:other};
  const copy=await library.copy(request),retry=await library.copy(request);assert.equal(copy.id,retry.id);
  assert.notEqual(copy.definition.formVersionId,draft.definition.formVersionId);
  assert.equal((await library.get({id:shared.id,reviewer:other})).definition.blocks[0].items[0].prompt,'Câu nguồn A');
  const personalRequest={id:shared.id,expectedRevision:preview.revision,expectedHash:preview.contentHash,title:'Bản sao riêng',operationId:randomUUID(),reviewer:other};
  const [personal,parallelRetry]=await Promise.all([library.copyToPersonal(personalRequest),library.copyToPersonal(personalRequest)]);
  assert.equal(parallelRetry.id,personal.id);
  assert.equal(personal.scope,'personal');
  assert.equal(personal.classId,null);
  assert.equal(personal.sessionNumber,null);
  assert.notEqual(personal.definition.formVersionId,draft.definition.formVersionId);
  assert.equal((await library.copyToPersonal(personalRequest)).id,personal.id);
  await assert.rejects(()=>library.copyToPersonal({...personalRequest,title:'Yêu cầu khác'}),e=>e.code==='LIBRARY_OPERATION_CONFLICT');
  await assert.rejects(()=>library.copyToPersonal({...personalRequest,operationId:randomUUID(),expectedHash:'0'.repeat(64)}),e=>e.code==='LIBRARY_SOURCE_STALE');
  await assert.rejects(()=>drafts.get({id:personal.id,reviewer}),e=>e.code==='DRAFT_NOT_FOUND');
  const editable=await drafts.editWorksheet({id:personal.id,operationId:randomUUID(),reviewer:other});
  editable.definition.title='Bản cá nhân đã sửa';
  editable.definition.blocks[0].items[0].prompt='Câu đã sửa';
  const saved=await drafts.save({id:editable.id,expectedRevision:editable.revision,definition:editable.definition,gradingKey:editable.gradingKey,reviewer:other});
  const stored=await library.list({scope:'personal',reviewer:other,worksheetHeads:true});
  assert.equal(stored.length,1);
  assert.equal(stored[0].editableDraftId,personal.id);
  assert.equal(stored[0].title,'Bản cá nhân đã sửa');
  assert.equal((await drafts.get({id:personal.id,reviewer:other})).definition.blocks[0].items[0].prompt,'Câu đã sửa');
  assert.equal((await library.get({id:shared.id,reviewer:other})).definition.blocks[0].items[0].prompt,'Câu nguồn A');
  assert.equal((await pool.query('SELECT count(*)::int n FROM learning.form_assignment')).rows[0].n,0);
  await db.exec(`INSERT INTO mapping.student_mapping_review(erp_course_class_id,erp_student_contact_id,erp_student_name_snapshot) VALUES(1294,123,'Học viên giả');
   INSERT INTO mapping.erp_class_membership_snapshot VALUES(1294,123);`);
  const delivered=await drafts.assignOwnedDraft({id:saved.id,expectedRevision:saved.revision,expectedHash:saved.contentHash,confirmedAnswers:true,
   targets:[{classId:'1294',sessionNumber:1,portalTarget:{id:portalId,startsAt}}],operationId:randomUUID(),reviewer:other});
  assert.equal(delivered.status,'success',JSON.stringify(delivered.results));
  const assigned=(await db.query(`SELECT a.erp_course_class_id::text AS class_id,a.session_number,v.public_definition FROM learning.form_assignment a
    JOIN learning.form_version v ON v.id=a.form_version_id WHERE a.id=$1`,[delivered.results[0].delivery.assignmentId])).rows[0];
  assert.equal(assigned.class_id,'1294');assert.equal(assigned.session_number,1);
  assert.equal(assigned.public_definition.blocks[0].items[0].prompt,'Câu đã sửa');
  assert.equal((await drafts.get({id:personal.id,reviewer:other})).classId,null);
  const counts=async()=> (await pool.query(`SELECT
   (SELECT count(*)::int FROM learning.form_draft) drafts,
   (SELECT count(*)::int FROM learning.form_library_entry) entries,
   (SELECT count(*)::int FROM learning.form_worksheet) worksheets,
   (SELECT count(*)::int FROM learning.form_worksheet_revision) revisions`)).rows[0];
  const before=await counts();
  await db.exec(`CREATE FUNCTION learning.test_stop_copy() RETURNS trigger LANGUAGE plpgsql AS
   $$ BEGIN RAISE EXCEPTION 'fixture stop before worksheet'; END; $$;
   CREATE TRIGGER test_stop_copy BEFORE INSERT ON learning.form_worksheet
   FOR EACH ROW EXECUTE FUNCTION learning.test_stop_copy();`);
  const interrupted={...personalRequest,operationId:randomUUID()};
  await assert.rejects(()=>library.copyToPersonal(interrupted),/fixture stop before worksheet/);
  assert.deepEqual(await counts(),before);
  await db.exec('DROP TRIGGER test_stop_copy ON learning.form_worksheet;');
  const recovered=await library.copyToPersonal(interrupted);
  assert.notEqual(recovered.id,personal.id);
  await archiveCatalog({pool,id:shared.id,source:'izone',operationId:randomUUID(),reviewer});
  await assert.rejects(()=>library.copyToPersonal({...personalRequest,operationId:randomUUID()}),
   e=>e.code==='LIBRARY_ENTRY_NOT_FOUND');
  assert.equal((await library.copyToPersonal(interrupted)).id,recovered.id);
  assert.equal((await drafts.get({id:personal.id,reviewer:other})).definition.title,'Bản cá nhân đã sửa');
 }finally{await close();}
});
