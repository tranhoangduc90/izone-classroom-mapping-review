import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {postgresFixture} from './learning-postgres-fixture.js';
import {createLearningFormDraftService} from '../src/learning-form-drafts.js';
import {previewFormImport} from '../src/learning-form-import.js';

test('Thẻ 22 PostgreSQL role API: hai edit/save đồng thời, một head, publication và assignment bất biến',{timeout:60000},async()=>{
 const f=await postgresFixture({asApplication:true});
 try{
  for(const file of ['202609160005_publisher_account_lookup.sql','202610010001_progress_log_form_drafts.sql','202610220002_form_library.sql','202610280001_form_publications.sql','202610300001_worksheet_revisions.sql'])await f.pool.query(await readFile(new URL('../ops/learning-migrations/'+file,import.meta.url),'utf8'));
  await f.pool.query(`ALTER TABLE mapping.reviewer_account ADD COLUMN role text DEFAULT 'teacher';INSERT INTO mapping.erp_class_membership_snapshot SELECT erp_course_class_id,erp_student_contact_id FROM mapping.student_mapping_review;`);
  const service=createLearningFormDraftService({pool:f.clockPool}),reviewer={email:'teacher@example.test',canAccessAllClasses:false},payload=previewFormImport('type,prompt,skill\nreflection,Nội dung gốc,speaking').payload;payload.definition.courseCode='56';
  const a=await service.create({...payload,classId:'2139',sessionNumber:1,operationId:randomUUID(),reviewer});await service.approve({id:a.id,expectedRevision:1,expectedHash:a.contentHash,reviewer});
  const pub=await service.publishLibrary({id:a.id,expectedRevision:1,operationId:randomUUID(),reviewer}),delivery=await service.assignPublication({id:pub.id,targets:[{classId:'2139',sessionNumber:1}],operationId:randomUUID(),reviewer,origin:{source:'draft',id:a.id}});assert.equal(delivery.status,'success');
  const before=(await f.pool.query('SELECT public_definition,definition_hash FROM learning.form_version WHERE id=$1',[pub.formVersionId])).rows[0];
  const edited=await Promise.all([1,2].map(()=>service.editWorksheet({id:a.id,operationId:randomUUID(),reviewer})));assert.equal(edited[0].id,edited[1].id);
  const save=title=>service.save({id:edited[0].id,expectedRevision:1,sessionNumber:1,definition:{...edited[0].definition,title},gradingKey:edited[0].gradingKey,reviewer});
  const saves=await Promise.allSettled([save('Tab A'),save('Tab B')]);assert.equal(saves.filter(s=>s.status==='fulfilled').length,1);assert.equal(saves.find(s=>s.status==='rejected').reason.code,'DRAFT_STALE');
  assert.equal((await service.list({classId:'2139',reviewer,worksheetHeads:true})).length,1);
  assert.deepEqual((await f.pool.query('SELECT public_definition,definition_hash FROM learning.form_version WHERE id=$1',[pub.formVersionId])).rows[0],before);
  assert.equal((await f.pool.query('SELECT count(*)::int n FROM learning.form_assignment')).rows[0].n,1);assert.equal((await f.pool.query('SELECT count(*)::int n FROM learning.submission')).rows[0].n,0);assert.equal((await f.pool.query('SELECT count(*)::int n FROM learning.outbox_job')).rows[0].n,0);
  await f.pool.query(await readFile(new URL('../ops/learning-migrations/202610300001_worksheet_revisions.sql',import.meta.url),'utf8'));
  assert.equal((await service.list({classId:'2139',reviewer,worksheetHeads:true})).length,1);
 }finally{await f.close();}
});
