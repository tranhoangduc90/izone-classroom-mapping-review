import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {createPGlitePool,initializeLearningDemoDatabase} from '../src/learning-demo.js';
import {createLearningFormDraftService} from '../src/learning-form-drafts.js';
import {copyAuthoringPayload} from '../src/learning-form-authoring.js';
import {sha256,stableStringify} from '../src/learning-domain.js';
const forms=JSON.parse(await readFile(new URL('./fixtures/progress-log-authoring-public-definitions.json',import.meta.url),'utf8'));
function payload() {
  const definition=structuredClone(forms[2].definition);
  return copyAuthoringPayload({definition,gradingKey:{schemaVersion:'FormGradingKeyV1',formVersionId:definition.formVersionId,
    graderVersion:1,items:Object.fromEntries(definition.blocks.flatMap(block=>block.items)
      .filter(item=>item.graderType==='exact_option').map(item=>[item.itemVersionId,{graderType:'exact_option',expectedOptionId:item.options[0].id}])),groups:{}}});
}
test('D01/D03/D05: nháp lưu trên DB, quyền owner/lớp, conflict, retry và import preview không ghi phiếu',async()=>{
  const database=new PGlite();
  try {
    await initializeLearningDemoDatabase(database);
    await database.exec(await readFile(new URL('../ops/learning-migrations/202610010001_progress_log_form_drafts.sql',import.meta.url),'utf8'));
    await database.exec(`INSERT INTO mapping.classroom_course_mapping VALUES (1294,'Lớp fixture','approved',NULL,NULL);
      INSERT INTO mapping.reviewer_account VALUES ('teacher@example.test','active'),('other@example.test','active');
      INSERT INTO mapping.reviewer_class_access VALUES ('teacher@example.test',1294),('other@example.test',1294);`);
    const pool=createPGlitePool(database),service=createLearningFormDraftService({pool});
    const reviewer={email:'teacher@example.test',canAccessAllClasses:false},checked=payload();
    const input={classId:'1294',sessionNumber:3,operationId:crypto.randomUUID(),definition:checked.definition,gradingKey:checked.gradingKey,reviewer};
    const created=await service.create(input),retry=await service.create(input);
    assert.equal(created.id,retry.id);assert.equal(retry.replayed,true);assert.equal(created.revision,1);
    assert.ok(Object.keys(created.gradingKey.items).length);
    const list=await service.list({classId:'1294',reviewer});assert.equal(list.length,1);
    assert.ok(!JSON.stringify(list).includes('expectedOptionId'));
    await assert.rejects(()=>service.get({id:created.id,reviewer:{email:'other@example.test',canAccessAllClasses:false}}),error=>error.code==='DRAFT_NOT_FOUND');
    await assert.rejects(()=>service.create({...input,classId:'999'}),error=>error.code==='DRAFT_CLASS_ACCESS_DENIED');
    const next=structuredClone(checked.definition);next.title='Nháp sửa từ tab một';
    const next2=structuredClone(checked.definition);next2.title='Nháp sửa từ tab hai';
    const results=await Promise.allSettled([next,next2].map(definition=>service.save({id:created.id,expectedRevision:1,
      sessionNumber:3,definition,gradingKey:checked.gradingKey,reviewer})));
    assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
    assert.equal(results.find(result=>result.status==='rejected').reason.code,'DRAFT_STALE');
    const saved=await service.get({id:created.id,reviewer});assert.equal(saved.definition.title,next.title);assert.equal(saved.revision,2);
    assert.equal((await service.save({id:created.id,expectedRevision:1,sessionNumber:3,definition:next,gradingKey:checked.gradingKey,reviewer})).replayed,true);
    const preview=await service.previewImport({id:created.id,expectedRevision:2,text:'type,prompt\nreflection,Câu nhập thêm có dấu',reviewer});
    assert.deepEqual(preview.errors,[]);assert.ok(preview.payload.definition.blocks.length>saved.definition.blocks.length);
    assert.equal((await service.get({id:created.id,reviewer})).revision,2);
    const bad=await service.previewImport({id:created.id,expectedRevision:2,text:'type,prompt\nessay_ai,Chưa hỗ trợ',reviewer});
    assert.equal(bad.payload,null);assert.equal(bad.errors.length,1);
    const counts=await database.query(`SELECT (SELECT count(*) FROM learning.form_assignment)::integer AS assignments,
      (SELECT count(*) FROM learning.outbox_job)::integer AS jobs,(SELECT count(*) FROM learning.form_draft)::integer AS drafts;`);
    assert.deepEqual(counts.rows[0],{assignments:0,jobs:0,drafts:1});
    // Lưu lại nội dung đã duyệt phải xóa toàn bộ metadata duyệt, kể cả khi đổi buổi.
    await database.query(`UPDATE learning.form_draft SET status='approved',approved_hash=content_hash,
      approved_revision=revision,approved_by_email='lead@example.test',approved_at=now() WHERE id=$1::uuid`,[created.id]);
    const reset=await service.save({id:created.id,expectedRevision:2,sessionNumber:4,definition:next,gradingKey:checked.gradingKey,reviewer});
    assert.equal(reset.status,'draft');assert.equal(reset.approvedRevision,null);assert.equal(reset.revision,3);
    // Tạo nguồn published giả để kiểm sao chép/retry/remap; không có bài học viên thật.
    const source=payload(),assignmentId=crypto.randomUUID();
    const template=await database.query(`INSERT INTO learning.form_template(title,kind,created_by_email)
      VALUES ('Nguồn fixture','quiz','teacher@example.test') RETURNING id;`);
    await database.query(`INSERT INTO learning.form_version(id,template_id,version,schema_version,public_definition,
      definition_hash,status,created_by_email,approved_by_email,published_at)
      VALUES ($1::uuid,$2::uuid,1,'FormDefinitionV1',$3::jsonb,$4,'published','teacher@example.test','source-approver@example.test',now());`,
      [source.definition.formVersionId,template.rows[0].id,JSON.stringify(source.definition),sha256(stableStringify(source.definition))]);
    await database.query(`INSERT INTO learning.form_grading_key(form_version_id,schema_version,grader_version,private_definition,content_hash)
      VALUES ($1::uuid,'FormGradingKeyV1',1,$2::jsonb,$3);`,[source.definition.formVersionId,JSON.stringify(source.gradingKey),sha256(stableStringify(source.gradingKey))]);
    await database.query(`INSERT INTO learning.form_assignment(id,form_version_id,erp_course_class_id,class_name_snapshot,
      session_number,title,status,created_by_email) VALUES ($1::uuid,$2::uuid,1294,'Lớp fixture',2,'Nguồn fixture','published','teacher@example.test');`,
      [assignmentId,source.definition.formVersionId]);
    const copyInput={assignmentId,classId:'1294',sessionNumber:5,operationId:crypto.randomUUID(),reviewer};
    const copy=await service.copyAssignment(copyInput),copyRetry=await service.copyAssignment(copyInput);
    assert.equal(copy.id,copyRetry.id);assert.equal(copyRetry.replayed,true);
    assert.notEqual(copy.definition.formVersionId,source.definition.formVersionId);
    assert.equal(copy.definition.blocks[1].items.find(item=>item.interactionConfig.sentenceLines).interactionConfig.responseCount,8);
    await assert.rejects(()=>service.copyAssignment({...copyInput,sessionNumber:6}),error=>error.code==='DRAFT_OPERATION_CONFLICT');
  } finally {await database.close();}
});
