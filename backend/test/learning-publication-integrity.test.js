// Dữ liệu giả: giữ đúng bản đã duyệt, phục hồi lỗi trim cũ và vẫn chặn thay đổi thật.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {createPGlitePool,initializeLearningDemoDatabase} from '../src/learning-demo.js';
import {createLearningFormDraftService} from '../src/learning-form-drafts.js';
import {createLearningFormLibrary} from '../src/learning-form-library.js';
import {previewFormImport} from '../src/learning-form-import.js';
import {sha256,stableStringify} from '../src/learning-domain.js';

const reviewer={email:'teacher@example.test',canAccessAllClasses:false};
const digest=(definition,gradingKey)=>sha256(stableStringify({definition,gradingKey}));
async function setup(){
  const db=new PGlite();
  await initializeLearningDemoDatabase(db);
  for(const file of ['202609160002_learning_api_mapping_schema_usage.sql','202609160005_publisher_account_lookup.sql',
    '202610010001_progress_log_form_drafts.sql','202610220002_form_library.sql','202610280001_form_publications.sql'])
    await db.exec(await readFile(new URL('../ops/learning-migrations/'+file,import.meta.url),'utf8'));
  await db.exec(`INSERT INTO mapping.classroom_course_mapping VALUES(1294,'Lớp giả','approved',NULL,NULL);
    INSERT INTO mapping.reviewer_account VALUES('teacher@example.test','active');
    INSERT INTO mapping.reviewer_class_access VALUES('teacher@example.test',1294);
    INSERT INTO mapping.student_mapping_review(erp_course_class_id,erp_student_contact_id,erp_student_name_snapshot)
      VALUES(1294,123,'Học viên giả');
    INSERT INTO mapping.erp_class_membership_snapshot VALUES(1294,123);`);
  const pool=createPGlitePool(db),drafts=createLearningFormDraftService({pool});
  return {db,pool,drafts,library:createLearningFormLibrary({pool,drafts})};
}
async function approved(drafts,sessionNumber=13){
  const payload=previewFormImport('type,prompt,skill\nreflection,Câu hỏi cần giữ nguyên,speaking').payload;
  payload.definition.courseCode='56';
  payload.definition.blocks[0].items[0].prompt='  Câu hỏi cần giữ nguyên? \n';
  const draft=await drafts.create({classId:'1294',sessionNumber,operationId:randomUUID(),...payload,reviewer});
  await drafts.approve({id:draft.id,expectedRevision:1,expectedHash:draft.contentHash,reviewer});
  return draft;
}
// Tạo đúng dữ liệu lịch sử: snapshot đã trim nhưng publication giữ hash nháp chưa trim.
async function legacy(db,drafts,mode='trim',session=13){
  const draft=await approved(drafts,session),definition=structuredClone(draft.definition),key=structuredClone(draft.gradingKey);
  definition.blocks[0].items[0].prompt=definition.blocks[0].items[0].prompt.trim();
  if(mode==='text')definition.blocks[0].items[0].prompt='Nội dung khác thật sự';
  if(mode==='key')key.graderVersion++;
  if(mode==='approval')await db.query('UPDATE learning.form_draft SET approved_hash=NULL WHERE id=$1::uuid',[draft.id]);
  const template=(await db.query("INSERT INTO learning.form_template(title,kind,created_by_email) VALUES($1,$2,$3) RETURNING id",
    [definition.title,definition.kind,reviewer.email])).rows[0];
  await db.query(`INSERT INTO learning.form_version(id,template_id,version,public_definition,definition_hash,status,
    created_by_email,approved_by_email,published_at) VALUES($1::uuid,$2::uuid,1,$3::jsonb,$4,'published',$5,$5,now())`,
    [definition.formVersionId,template.id,JSON.stringify(definition),sha256(stableStringify(definition)),reviewer.email]);
  await db.query(`INSERT INTO learning.form_grading_key(form_version_id,schema_version,grader_version,private_definition,content_hash)
    VALUES($1::uuid,'FormGradingKeyV1',$2,$3::jsonb,$4)`,[definition.formVersionId,key.graderVersion,JSON.stringify(key),sha256(stableStringify(key))]);
  const publication=(await db.query(`INSERT INTO learning.form_publication(operation_id,source_draft_id,source_revision,
    content_hash,form_version_id,owner_email) VALUES($1::uuid,$2::uuid,$3,$4,$5::uuid,$6) RETURNING *`,
    [randomUUID(),draft.id,mode==='revision'?2:1,mode==='hash'?'f'.repeat(64):draft.contentHash,definition.formVersionId,reviewer.email])).rows[0];
  return {draft,publication};
}
const assign=(drafts,id,sessionNumber=13,operationId=randomUUID())=>drafts.assignPublication({id,reviewer,operationId,
  targets:[{classId:'1294',sessionNumber}]});

test('Xuất bản câu có khoảng trắng giữ đúng bản đã duyệt; giao/retry bằng quyền GV không tạo bài nộp',async()=>{
  const {db,drafts}=await setup();try{
    const draft=await approved(drafts),input={id:draft.id,expectedRevision:1,operationId:randomUUID(),reviewer};
    await db.exec('SET ROLE learning_api');
    const publication=await drafts.publishLibrary(input);
    const stored=(await db.query('SELECT public_definition FROM learning.form_version WHERE id=$1::uuid',[publication.formVersionId])).rows[0];
    assert.deepEqual(stored.public_definition,draft.definition,'Snapshot phải giữ nguyên nội dung đã được duyệt');
    assert.equal(publication.contentHash,digest(stored.public_definition,draft.gradingKey));
    const operationId=randomUUID(),result=await assign(drafts,publication.id,13,operationId);
    assert.equal(result.status,'success');assert.equal(result.results[0].delivery.rosterCount,1);
    const retry=await assign(drafts,publication.id,13,operationId);
    assert.equal(retry.results[0].delivery.replayed,true);
    assert.equal(retry.results[0].delivery.assignmentId,result.results[0].delivery.assignmentId);
    assert.equal((await db.query('SELECT count(*)::int n FROM learning.submission')).rows[0].n,0);
    assert.equal((await db.query('SELECT count(*)::int n FROM learning.outbox_job')).rows[0].n,0);
  }finally{await db.close();}
});

test('Bản xuất bản cũ chỉ được phục hồi khi snapshot khớp chính xác nháp đã duyệt sau trim; nguồn bất biến',async()=>{
  const {db,drafts}=await setup();try{
    const {draft,publication}=await legacy(db,drafts);
    const before=await db.query('SELECT row_to_json(d) AS value FROM learning.form_draft d WHERE id=$1::uuid',[draft.id]);
    await db.exec('SET ROLE learning_api');
    assert.equal((await assign(drafts,publication.id)).status,'success');
    const denied=await drafts.assignPublication({id:publication.id,reviewer,operationId:randomUUID(),targets:[{classId:'1296',sessionNumber:13}]});
    assert.equal(denied.results[0].error,'DRAFT_CLASS_ACCESS_DENIED');
    assert.deepEqual((await db.query('SELECT row_to_json(d) AS value FROM learning.form_draft d WHERE id=$1::uuid',[draft.id])).rows,before.rows);
    await db.exec('RESET ROLE');
    assert.deepEqual((await db.query('SELECT * FROM learning.form_publication WHERE id=$1::uuid',[publication.id])).rows[0],publication);
    await assert.rejects(()=>db.query("UPDATE learning.form_publication SET content_hash=$2 WHERE id=$1::uuid",[publication.id,'0'.repeat(64)]),/FORM_PUBLICATION_IMMUTABLE/);
    for(const [index,mode]of ['text','key','hash','revision','approval'].entries()){
      const bad=await legacy(db,drafts,mode,20+index);
      await assert.rejects(()=>assign(drafts,bad.publication.id,20+index),error=>error.code==='PUBLICATION_CONTENT_MISMATCH',mode);
    }
    assert.equal((await db.query('SELECT count(*)::int n FROM learning.form_assignment')).rows[0].n,1);
  }finally{await db.close();}
});

test('Kho cá nhân xem thử được câu có khoảng trắng và vẫn chặn bản chụp bị sửa thật',async()=>{
  const {db,drafts,library}=await setup();try{
    const draft=await approved(drafts);
    const entry=await library.store({draftId:draft.id,expectedRevision:1,expectedHash:draft.contentHash,scope:'personal',operationId:randomUUID(),reviewer});
    const preview=await library.previewInfo({id:entry.id,reviewer});
    const source=await library.demoSource({grant:{ownerEmail:reviewer.email,entryId:entry.id,contentHash:preview.contentHash,revision:1}});
    assert.equal(digest(source.definition,source.gradingKey),preview.contentHash);
    assert.equal(source.definition.blocks[0].items[0].prompt,draft.definition.blocks[0].items[0].prompt);
    await db.query("UPDATE learning.form_library_entry SET public_definition=jsonb_set(public_definition,'{blocks,0,items,0,prompt}','\"Câu bị sửa\"') WHERE id=$1::uuid",[entry.id]);
    await assert.rejects(()=>library.previewInfo({id:entry.id,reviewer}),error=>error.code==='LIBRARY_CONTENT_MISMATCH');
  }finally{await db.close();}
});
