import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import express from 'express';
import request from 'supertest';
import {postgresFixture} from './learning-postgres-fixture.js';
import {createLearningRouter} from '../src/learning-routes.js';
import {previewFormImport} from '../src/learning-form-import.js';

test('Kho chung: sửa bài có điểm, xuất bản và giao phiên bản mới; phiếu đã giao giữ điểm cũ', {timeout:60000}, async () => {
  const fixture=await postgresFixture({asApplication:true,studentCount:1});
  try {
    for(const name of ['202609160005_publisher_account_lookup.sql','202610010001_progress_log_form_drafts.sql',
      '202610220002_form_library.sql','202610280001_form_publications.sql','202610300001_worksheet_revisions.sql',
      '202611090002_shared_course_drafts.sql','202611170001_shared_library_revisions.sql']) {
      await fixture.pool.query(await readFile(new URL('../ops/learning-migrations/'+name,import.meta.url),'utf8'));
    }
    await fixture.pool.query(`INSERT INTO mapping.reviewer_account VALUES('other56@example.test','active'),('lead67@example.test','active'),
      ('admin@example.test','active'),('plain@example.test','active');
      ALTER TABLE mapping.reviewer_account ADD COLUMN role text DEFAULT 'teacher';
      INSERT INTO mapping.erp_class_membership_snapshot SELECT erp_course_class_id,erp_student_contact_id FROM mapping.student_mapping_review;
      INSERT INTO learning.course_content_authority(reviewer_email,course_code,can_self_approve_scored_forms,grant_reference)
      VALUES('teacher@example.test','56',true,'Isolated fixture only'),('other56@example.test','56',true,'Isolated fixture only'),
      ('lead67@example.test','67',true,'Isolated fixture only');
      INSERT INTO learning.progress_log_admin(reviewer_email,status,grant_reference) VALUES('admin@example.test','active','Isolated fixture only')`);
    const app=express();
    const events=[],demoSourceSecret='tab7-authoring-preview-fixture-secret';
    app.use(express.json());
    app.use(createLearningRouter({pool:fixture.clockPool,sharedRevisionCatalog:true,demoSourceSecret,logger:{info:line=>events.push(JSON.parse(line))},authenticate(req,_res,next){
      req.reviewer={email:`${req.get('x-actor')||'teacher'}@example.test`,canAccessAllClasses:false};next();
    }}));
    const api=request(app);
    const checked=async (call,status=200)=>{
      const reply=await call;
      assert.equal(reply.status,status,JSON.stringify(reply.body));
      return reply.body;
    };
    const payload=previewFormImport('type,prompt,options,answer,skill\nmcq,"Chọn A","[{""id"":""A"",""label"":""Đúng""},{""id"":""B"",""label"":""Sai""}]",A,listening').payload;
    payload.definition.courseCode='56';
    const {draft:original}=await checked(api.post('/teacher/form-drafts').send({...payload,scope:'izone',operationId:randomUUID()}),201);
    const publish=async draft=>{
      await checked(api.post(`/teacher/form-drafts/${draft.id}/approve`).send({expectedRevision:draft.revision,expectedHash:draft.contentHash}));
      return (await checked(api.post(`/teacher/form-drafts/${draft.id}/publish-library`).send({expectedRevision:draft.revision,operationId:randomUUID()}),201)).publication;
    };
    const old=await publish(original);
    const deliver=async (publication,sessionNumber,operationId=randomUUID())=>{
      const {delivery}=await checked(api.post(`/teacher/form-publications/${publication.id}/assign`).send({operationId,
        origin:{source:'library',id:publication.libraryEntryId},targets:[{classId:'2139',sessionNumber}]}));
      assert.equal(delivery.status,'success',JSON.stringify(delivery));
      return delivery.results[0].delivery;
    };
    const firstOperation=randomUUID();
    const first=await deliver(old,1,firstOperation);
    const submit=async (delivery,response='A')=>{
      const published=await fixture.service.getPublicAssignment(delivery.publicToken);
      const attempt=await fixture.service.startAttempt({publicToken:delivery.publicToken,studentRef:published.roster[0].studentRef,
        identityConfirmed:true,clientIdempotencyKey:randomUUID()});
      const itemId=published.definition.blocks[0].items[0].itemVersionId;
      return fixture.service.submit({attemptToken:attempt.attemptToken,submissionId:randomUUID(),
        definitionHash:published.definitionHash,draftRevision:0,responses:{[itemId]:response}});
    };
    await submit(first);
    const snapshot=async version=>{
      const {rows}=await fixture.pool.query(`SELECT v.definition_hash,k.content_hash AS key_hash,
        (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM learning.submission s) AS submissions,
        (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.assignment_id,a.student_ref) FROM learning.attendance_record a) AS attendance,
        (SELECT jsonb_agg(to_jsonb(g) ORDER BY g.id) FROM learning.grading_run g) AS grading,
        (SELECT jsonb_agg(to_jsonb(j) ORDER BY j.id) FROM learning.outbox_job j) AS jobs
        FROM learning.form_version v JOIN learning.form_grading_key k ON k.form_version_id=v.id WHERE v.id=$1`,[version]);
      return rows[0];
    };
    const before=await snapshot(old.formVersionId);
    assert.equal(before.submissions.length,1);
    assert.equal(before.attendance.length,1);
    const begin=(publication,actor='teacher',operationId=randomUUID())=>api.post(`/teacher/form-library/${publication.libraryEntryId}/edit`)
      .set('x-actor',actor).send({expectedRevision:publication.revision,expectedHash:publication.contentHash,operationId});
    const {draft:editing}=await checked(begin(old),201);
    const item=editing.definition.blocks[0].items[0];
    item.prompt='Chọn B';
    const key=editing.gradingKey.items[item.itemVersionId];
    assert.ok(key);
    key.expectedOptionId='B';
    const {draft:saved}=await checked(api.put(`/teacher/form-drafts/${editing.id}`).send({expectedRevision:editing.revision,
      definition:editing.definition,gradingKey:editing.gradingKey}));
    const revised=await publish(saved);
    assert.deepEqual(await snapshot(old.formVersionId),before);
    const {entries}=await checked(api.get('/teacher/form-library?scope=izone'));
    assert.deepEqual(entries.map(entry=>entry.id),[revised.libraryEntryId]);
    const second=await deliver(revised,2);
    assert.equal((await fixture.service.getPublicAssignment(first.publicToken)).formVersionId,old.formVersionId);
    assert.equal((await fixture.service.getPublicAssignment(second.publicToken)).formVersionId,revised.formVersionId);
    await submit(second);
    const grades=(await fixture.pool.query(`SELECT i.score_earned AS score FROM learning.grading_result_item i
      JOIN learning.grading_run g ON g.id=i.grading_run_id JOIN learning.submission s ON s.id=g.submission_id
      JOIN learning.form_assignment a ON a.id=s.assignment_id ORDER BY a.session_number`)).rows;
    assert.deepEqual(grades.map(row=>Number(row.score)),[1,0]);

    const stopped=express();
    stopped.use(express.json());
    stopped.use(createLearningRouter({pool:fixture.clockPool,sharedRevisionCatalog:true,sharedEditingEnabled:false,
      authenticate(req,_res,next){req.reviewer={email:'teacher@example.test',canAccessAllClasses:false};next();}}));
    const frozenApi=request(stopped);
    const stoppedList=await checked(frozenApi.get('/teacher/form-library?scope=izone'));
    assert.deepEqual(stoppedList.entries.map(entry=>[entry.id,entry.canEditShared]),[[revised.libraryEntryId,false]]);
    const stoppedEdit=await checked(frozenApi.post(`/teacher/form-library/${revised.libraryEntryId}/edit`).send({
      expectedRevision:revised.revision,expectedHash:revised.contentHash,operationId:randomUUID()}),409);
    assert.equal(stoppedEdit.error,'SHARED_EDIT_UNAVAILABLE');

    for(const [actor,allowed] of [['admin',true],['other56',true],['lead67',false],['plain',false]]){
      const {entries:visible}=await checked(api.get('/teacher/form-library?scope=izone').set('x-actor',actor));
      assert.equal(visible[0].canEditShared,allowed);
      if(!allowed)assert.equal((await checked(begin(revised,actor),403)).error,'SHARED_COURSE_ACCESS_DENIED');
    }
    assert.equal((await checked(begin(old),409)).error,'LIBRARY_SOURCE_STALE');
    const {delivery:partial}=await checked(api.post(`/teacher/form-publications/${old.id}/assign`).send({operationId:firstOperation,
      origin:{source:'library',id:old.libraryEntryId},targets:[{classId:'2139',sessionNumber:1},{classId:'2139',sessionNumber:3}]}));
    assert.equal(partial.results[0].delivery.assignmentId,first.assignmentId);
    assert.equal(partial.results[0].delivery.replayed,true);
    assert.equal(partial.results[1].error,'LIBRARY_SOURCE_STALE');
    const {delivery:withoutOrigin}=await checked(api.post(`/teacher/form-publications/${old.id}/assign`).send({operationId:randomUUID(),
      targets:[{classId:'2139',sessionNumber:3}]}));
    assert.equal(withoutOrigin.results[0].error,'LIBRARY_SOURCE_STALE');

    const beginOperation=randomUUID();
    const [openedA,openedB,other,admin]=await Promise.all([
      checked(begin(revised,'teacher',beginOperation),201),checked(begin(revised),201),
      checked(begin(revised,'other56'),201),checked(begin(revised,'admin'),201),
    ]);
    assert.equal(openedA.draft.id,openedB.draft.id);
    assert.equal((await checked(begin(revised,'teacher',beginOperation),201)).draft.id,openedA.draft.id);
    assert.notEqual(openedA.draft.id,other.draft.id);
    const approve=(draft,actor)=>api.post(`/teacher/form-drafts/${draft.id}/approve`).set('x-actor',actor)
      .send({expectedRevision:draft.revision,expectedHash:draft.contentHash});
    assert.equal((await checked(approve(admin.draft,'admin'),409)).error,'DRAFT_REVIEW_REQUIRED');
    await checked(api.post(`/teacher/form-drafts/${admin.draft.id}/request-review`).set('x-actor','admin')
      .send({expectedRevision:admin.draft.revision}));
    await checked(approve(admin.draft,'other56'));
    await checked(approve(other.draft,'other56'));
    const changing=await checked(api.put(`/teacher/form-drafts/${admin.draft.id}`).set('x-actor','admin').send({
      expectedRevision:admin.draft.revision,definition:{...admin.draft.definition,courseCode:'67'},gradingKey:admin.draft.gradingKey}),409);
    assert.equal(changing.error,'SHARED_COURSE_MISMATCH');
    const publishRevision=(draft,actor,operationId)=>api.post(`/teacher/form-drafts/${draft.id}/publish-library`).set('x-actor',actor)
      .send({expectedRevision:draft.revision,operationId});
    const adminOp=randomUUID(),otherOp=randomUUID();
    const writes=await Promise.all([publishRevision(admin.draft,'admin',adminOp),publishRevision(other.draft,'other56',otherOp)]);
    assert.deepEqual(writes.map(result=>result.status).sort(),[201,409]);
    const winning=writes.find(result=>result.status===201).body.publication;
    assert.equal(writes.find(result=>result.status===409).body.error,'LIBRARY_SOURCE_STALE');
    const adminWon=writes[0].status===201;
    const replay=(await checked(adminWon?publishRevision(admin.draft,'admin',adminOp):publishRevision(other.draft,'other56',otherOp),201)).publication;
    assert.equal(replay.libraryEntryId,winning.libraryEntryId);
    assert.equal(replay.replayed,true);

    const {draft:toArchive}=await checked(begin(winning),201);
    const {draft:revoked}=await checked(begin(winning,'other56'),201);
    await fixture.pool.query(`UPDATE learning.course_content_authority SET status='revoked',revoked_at=now() WHERE reviewer_email='other56@example.test'`);
    const rejected=await checked(api.put(`/teacher/form-drafts/${revoked.id}`).set('x-actor','other56').send({
      expectedRevision:revoked.revision,definition:revoked.definition,gradingKey:revoked.gradingKey}),403);
    assert.equal(rejected.error,'SHARED_COURSE_ACCESS_DENIED');
    await checked(approve(toArchive,'teacher'));
    await checked(api.post(`/teacher/form-catalog/${winning.libraryEntryId}/archive`).set('x-actor','admin')
      .send({source:'izone',operationId:randomUUID()}));
    assert.equal((await checked(publishRevision(toArchive,'teacher',randomUUID()),409)).error,'CATALOG_ARCHIVED');
    // Câu kiểu Tab 7 đi trọn từ nháp Khảo sát đến điểm chấm của 8 ô.
    const writing=previewFormImport('type,prompt,skill\nreflection,Các tiêu chí ... và ...,writing').payload;
    writing.definition.courseCode='56';
    const originalWriting=writing.definition.blocks[0].items[0],writingId=originalWriting.itemVersionId;
    originalWriting.kind='survey';
    writing.gradingKey.referenceAnswers={[writingId]:['Ý kiến tham khảo của giảng viên']};
    const {draft:survey}=await checked(api.post('/teacher/form-drafts')
      .send({...writing,scope:'izone',operationId:randomUUID()}),201);
    const converted=survey.definition.blocks[0].items[0];
    converted.prompt='Mục 1 ... và ...\nMục 2 ... và ...\nMục 3 ... và ...\nMục 4 ... và ...';
    Object.assign(converted,{kind:'exercise',layoutType:'numbered_short_texts',interactionType:'short_text',
      pedagogicalTypeCode:'sentence_completion',graderType:'accepted_text_sequence',maxScore:8,
      interactionConfig:{responseCount:8,blankIds:Array.from({length:8},randomUUID),
        sentenceLines:converted.prompt.split('\n').map(line=>({title:'',parts:line.split('...')}))}});
    survey.gradingKey.referenceAnswersBySlot={[writingId]:Array.from({length:8},()=>[])};
    const saveWriting=draft=>api.put('/teacher/form-drafts/'+draft.id).send({expectedRevision:draft.revision,
      definition:draft.definition,gradingKey:draft.gradingKey});
    const {draft:convertedWriting}=await checked(saveWriting(survey));
    const {draft:reopenedWriting}=await checked(api.get('/teacher/form-drafts/'+survey.id));
    assert.equal(reopenedWriting.revision,convertedWriting.revision);
    assert.deepEqual(reopenedWriting.definition.blocks[0].items[0].interactionConfig.blankIds,converted.interactionConfig.blankIds);
    assert.deepEqual(reopenedWriting.gradingKey.referenceAnswers[writingId],['Ý kiến tham khảo của giảng viên']);
    const {grant}=await checked(api.post('/teacher/form-drafts/'+survey.id+'/preview-grant')
      .send({expectedRevision:reopenedWriting.revision}));
    const {source}=await checked(api.post('/assignments/demo-source').set('x-learning-demo-source',demoSourceSecret).send({grant}));
    assert.equal(source.definition.blocks[0].items[0].interactionConfig.responseCount,8);
    const missing=await checked(approve(reopenedWriting,'teacher'),400);
    assert.equal(missing.error,'DRAFT_ANSWER_REQUIRED');
    const keyBySlot=Array.from({length:8},(_,i)=>['đáp án '+(i+1)]);
    reopenedWriting.gradingKey.items[writingId]={graderType:'accepted_text_sequence',acceptedBySlot:keyBySlot,normalization:{}};
    const {draft:markedWriting}=await checked(saveWriting(reopenedWriting));
    const writingPublication=await publish(markedWriting);
    const writingDelivery=await deliver(writingPublication,4);
    await submit(writingDelivery,keyBySlot.map(([answer])=>answer));
    const {rows:[earned]}=await fixture.pool.query(`SELECT i.score_earned AS score FROM learning.grading_result_item i
      JOIN learning.grading_run g ON g.id=i.grading_run_id JOIN learning.submission s ON s.id=g.submission_id
      WHERE s.assignment_id=$1`,[writingDelivery.assignmentId]);
    assert.equal(Number(earned.score),8);

    assert.deepEqual((await checked(api.get('/teacher/form-library?scope=izone'))).entries,[]);
    assert.equal((await deliver(old,1,firstOperation)).assignmentId,first.assignmentId);
    assert.equal((await fixture.service.getPublicAssignment(first.publicToken)).formVersionId,old.formVersionId);
    assert.ok(events.some(event=>event.status===201&&event.draftId===editing.id&&event.libraryEntryId===old.libraryEntryId));
    assert.ok(events.some(event=>event.status===403&&event.errorCode==='SHARED_COURSE_ACCESS_DENIED'));
    assert.ok(events.some(event=>event.status===409&&event.errorCode==='LIBRARY_SOURCE_STALE'));
  } finally {await fixture.close();}
});
