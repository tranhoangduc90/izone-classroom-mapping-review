// Nguồn cũ đã duyệt: giữ nguyên bản được giao và bản chụp cũ dù nháp nguồn tiếp tục đổi.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {createPGlitePool,initializeLearningDemoDatabase} from '../src/learning-demo.js';
import {createLearningFormDraftService} from '../src/learning-form-drafts.js';
import {createLearningFormLibrary} from '../src/learning-form-library.js';
import {previewFormImport} from '../src/learning-form-import.js';
import {validateAuthoringPayload} from '../src/learning-form-authoring.js';
import {sha256,stableStringify} from '../src/learning-domain.js';
import {insertLearningAssignmentSql} from '../src/learning-sql.js';
test('R30: giao lại nguồn đã phát và bản chụp đã duyệt, không lấy nhầm revision mới hoặc bỏ quyền',{timeout:60000},async()=>{
  const db=new PGlite();try{
    await initializeLearningDemoDatabase(db);
    for(const file of ['202609160002_learning_api_mapping_schema_usage.sql','202609160005_publisher_account_lookup.sql','202610010001_progress_log_form_drafts.sql','202610220002_form_library.sql','202610280001_form_publications.sql'])
      await db.exec(await readFile(new URL('../ops/learning-migrations/'+file,import.meta.url),'utf8'));
    await db.exec(`ALTER TABLE mapping.reviewer_account ADD COLUMN role text DEFAULT 'teacher';
      INSERT INTO mapping.classroom_course_mapping VALUES(1294,'Lớp giả A','approved',NULL,NULL),(1295,'Lớp giả B','approved',NULL,NULL);
      INSERT INTO mapping.reviewer_account(email,status) VALUES('owner@example.test','active'),('reader@example.test','active');
      INSERT INTO mapping.reviewer_class_access VALUES('owner@example.test',1294),('owner@example.test',1295),('reader@example.test',1295);
      INSERT INTO mapping.student_mapping_review(erp_course_class_id,erp_student_contact_id,erp_student_name_snapshot) VALUES(1294,123,'Học viên giả A'),(1295,124,'Học viên giả B');
      INSERT INTO mapping.erp_class_membership_snapshot VALUES(1294,123),(1295,124);
      INSERT INTO learning.course_content_authority(reviewer_email,course_code,can_self_approve_scored_forms,grant_reference) VALUES('owner@example.test','56',true,'Test fixture only');`);
    const pool=createPGlitePool(db),drafts=createLearningFormDraftService({pool}),library=createLearningFormLibrary({pool,drafts});
    const owner={email:'owner@example.test',canAccessAllClasses:false},reader={email:'reader@example.test',canAccessAllClasses:false};
    const content=()=>{const p=previewFormImport('type,prompt,options,answer,skill\nmcq,Câu cũ,"[{""id"":""A"",""label"":""Một""},{""id"":""B"",""label"":""Hai""}]",A,reading').payload;p.definition.courseCode='56';return p;};
    const make=async sessionNumber=>{const draft=await drafts.create({classId:'1294',sessionNumber,operationId:randomUUID(),...content(),reviewer:owner});await drafts.approve({id:draft.id,expectedRevision:1,expectedHash:draft.contentHash,reviewer:owner});return draft;};
    const old=await make(1),legacy=await drafts.publish({id:old.id,expectedRevision:1,operationId:randomUUID(),reviewer:owner});
    const input={source:'assignment',id:legacy.assignmentId,operationId:randomUUID(),reviewer:owner};
    await db.exec('SET ROLE learning_api');const adopted=await drafts.publicationFromSource(input);await db.exec('RESET ROLE');
    assert.equal(adopted.formVersionId,legacy.formVersionId);assert.equal((await drafts.publicationFromSource(input)).id,adopted.id);
    assert.equal((await db.query('SELECT count(*)::int n FROM learning.form_assignment')).rows[0].n,1);
    const assigned=await drafts.assignPublication({id:adopted.id,operationId:randomUUID(),reviewer:owner,targets:[{classId:'1295',sessionNumber:2}]});assert.equal(assigned.status,'success');
    assert.ok((await drafts.listPublications({reviewer:reader})).some(p=>p.id===adopted.id));
    const original=await make(3),stored=await library.store({draftId:original.id,expectedRevision:1,expectedHash:original.contentHash,scope:'izone',operationId:randomUUID(),reviewer:owner});
    const edited=structuredClone(original.definition);edited.title='Nháp revision 2';edited.blocks[0].items[0].prompt='Câu mới khác bản chụp';
    await drafts.save({id:original.id,expectedRevision:1,sessionNumber:3,definition:edited,gradingKey:original.gradingKey,reviewer:owner});
    const snapshotInput={source:'library',id:stored.id,operationId:randomUUID(),reviewer:reader};
    await db.exec('SET ROLE learning_api');const snapshot=await drafts.publicationFromSource(snapshotInput);await db.exec('RESET ROLE');
    assert.notEqual(snapshot.formVersionId,original.definition.formVersionId);assert.equal((await drafts.publicationFromSource(snapshotInput)).id,snapshot.id);
    const frozen=(await db.query('SELECT public_definition FROM learning.form_version WHERE id=$1::uuid',[snapshot.formVersionId])).rows[0].public_definition;
    assert.equal(frozen.title,original.definition.title);assert.equal(frozen.blocks[0].items[0].prompt,'Câu cũ');
    const current=await drafts.get({id:original.id,reviewer:owner});assert.equal(current.revision,2);
    const another=await drafts.save({id:current.id,expectedRevision:2,sessionNumber:3,definition:current.definition,gradingKey:current.gradingKey,reviewer:owner});assert.equal(another.revision,3);
    // Dạng gạch chân lịch sử vẫn giao lại nguyên bản; danh mục tạo mới tiếp tục cấm dạng này.
    const historical=structuredClone(old.definition),historicalKey=structuredClone(old.gradingKey);historical.formVersionId=randomUUID();historicalKey.formVersionId=historical.formVersionId;historicalKey.items={};
    Object.assign(historical.blocks[0].items[0],{interactionType:'multi_choice_group',layoutType:'keyword_selection',graderType:'none',maxScore:0,
      options:[{id:'w1',label:'same'},{id:'w2',label:'word'}],interactionConfig:{maxSelections:1}});
    assert.throws(()=>validateAuthoringPayload({definition:historical,gradingKey:historicalKey}),e=>e.code==='DRAFT_TYPE_NOT_ALLOWED');
    const template=(await db.query("INSERT INTO learning.form_template(title,kind,created_by_email) VALUES('Lịch sử','mixed',$1) RETURNING id",[owner.email])).rows[0];
    await db.query(`INSERT INTO learning.form_version(id,template_id,version,public_definition,definition_hash,status,created_by_email,approved_by_email,published_at)
      VALUES($1::uuid,$2::uuid,1,$3::jsonb,$4,'published',$5,$5,now())`,[historical.formVersionId,template.id,JSON.stringify(historical),sha256(stableStringify(historical)),owner.email]);
    await db.query(`INSERT INTO learning.form_grading_key(form_version_id,schema_version,grader_version,private_definition,content_hash)
      VALUES($1::uuid,'FormGradingKeyV1',$2,$3::jsonb,$4)`,[historical.formVersionId,historicalKey.graderVersion,JSON.stringify(historicalKey),sha256(stableStringify(historicalKey))]);
    const source=(await db.query(insertLearningAssignmentSql,[historical.formVersionId,'56','1294','Lớp giả A',8,historical.title,null,null,owner.email])).rows[0];
    const fromHistory=await drafts.publicationFromSource({source:'assignment',id:source.assignment_id,operationId:randomUUID(),reviewer:owner});
    assert.equal(fromHistory.formVersionId,historical.formVersionId);
    assert.equal((await drafts.assignPublication({id:fromHistory.id,operationId:randomUUID(),reviewer:owner,targets:[{classId:'1295',sessionNumber:9}]})).status,'success');
    const notApproved=await drafts.create({classId:'1294',sessionNumber:5,operationId:randomUUID(),...content(),reviewer:owner});
    const privateEntry=await library.store({draftId:notApproved.id,expectedRevision:1,expectedHash:notApproved.contentHash,scope:'personal',operationId:randomUUID(),reviewer:owner});
    await assert.rejects(()=>drafts.publicationFromSource({source:'library',id:privateEntry.id,operationId:randomUUID(),reviewer:owner}),e=>e.code==='LIBRARY_APPROVAL_REQUIRED');
    await assert.rejects(()=>drafts.publicationFromSource({source:'library',id:privateEntry.id,operationId:randomUUID(),reviewer:reader}),e=>e.code==='PUBLICATION_SOURCE_DENIED');
    await db.query('DELETE FROM mapping.reviewer_class_access WHERE reviewer_email=$1',[reader.email]);
    await assert.rejects(()=>drafts.assignPublication({id:adopted.id,operationId:randomUUID(),reviewer:reader,targets:[{classId:'1295',sessionNumber:4}]}),e=>e.code==='PUBLICATION_NOT_FOUND');
    assert.equal((await db.query('SELECT count(*)::int n FROM learning.submission')).rows[0].n,0);assert.equal((await db.query('SELECT count(*)::int n FROM learning.outbox_job')).rows[0].n,0);
  }finally{await db.close();}
});
