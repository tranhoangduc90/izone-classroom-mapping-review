import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {postgresFixture} from './learning-postgres-fixture.js';
import {createLearningFormDraftService} from '../src/learning-form-drafts.js';
import {createLearningFormLibrary} from '../src/learning-form-library.js';
import {previewFormImport} from '../src/learning-form-import.js';
import {createLearningService} from '../src/learning-service.js';

test('Kho chung PostgreSQL: quyền khóa, lưu cách ly và rollback xuất bản khi mục kho lỗi',{timeout:60000},async()=>{
  const fixture=await postgresFixture({asApplication:true});
  try{
    for(const file of ['202610010001_progress_log_form_drafts.sql','202610220002_form_library.sql','202610280001_form_publications.sql','202611090002_shared_course_drafts.sql'])
      await fixture.pool.query(await readFile(new URL('../ops/learning-migrations/'+file,import.meta.url),'utf8'));
    await fixture.pool.query(`INSERT INTO mapping.reviewer_account VALUES('lead67@example.test','active');
      INSERT INTO learning.course_content_authority(reviewer_email,course_code,can_self_approve_scored_forms,grant_reference)
      VALUES('lead67@example.test','67',true,'Isolated fixture only')`);
    const reviewer={email:'lead67@example.test',canAccessAllClasses:false};
    const drafts=createLearningFormDraftService({pool:fixture.clockPool});
    const payload=previewFormImport('type,prompt,skill\nreflection,Câu Kho chung,reading').payload;
    payload.definition.courseCode='67';
    const draft=await drafts.create({...payload,scope:'izone',operationId:randomUUID(),reviewer});
    assert.equal(draft.classId,null);
    await assert.rejects(()=>drafts.save({...payload,definition:{...payload.definition,courseCode:'56'},
      id:draft.id,expectedRevision:1,reviewer}),{code:'SHARED_COURSE_ACCESS_DENIED'});
    const review={id:draft.id,expectedRevision:1,expectedHash:draft.contentHash,reviewer};
    await drafts.requestReview(review);
    await drafts.approve(review);
    await fixture.pool.query(`ALTER TABLE learning.form_library_entry ADD CONSTRAINT fixture_reject_shared CHECK(sharing_scope<>'izone')`);
    const operation={...review,operationId:randomUUID()};
    await assert.rejects(()=>drafts.publishLibrary(operation),{code:'23514'});
    assert.equal((await fixture.pool.query('SELECT 1 FROM learning.form_publication WHERE source_draft_id=$1',[draft.id])).rowCount,0);
    assert.equal((await fixture.pool.query('SELECT 1 FROM learning.form_version WHERE id=$1',[draft.definition.formVersionId])).rowCount,0);
    await fixture.pool.query('ALTER TABLE learning.form_library_entry DROP CONSTRAINT fixture_reject_shared');
    const [one,two]=await Promise.all([drafts.publishLibrary(operation),drafts.publishLibrary({...operation,operationId:randomUUID()})]);
    assert.equal(one.libraryEntryId,two.libraryEntryId);
    assert.equal((await fixture.pool.query('SELECT 1 FROM learning.form_library_entry WHERE source_draft_id=$1',[draft.id])).rowCount,1);
    assert.equal((await fixture.pool.query('SELECT 1 FROM learning.form_assignment')).rowCount,0);
    await fixture.pool.query("UPDATE learning.course_content_authority SET status='revoked',revoked_at=now() WHERE reviewer_email=$1",[reviewer.email]);
    await assert.rejects(()=>drafts.get({id:draft.id,reviewer}),{code:'SHARED_COURSE_ACCESS_DENIED'});
  }finally{await fixture.close();}
});

test('R30 PostgreSQL: giao bản chụp đợi save đang commit, không khóa nhầm revision mới; hai lần giao cạnh tranh chỉ có một phiếu',{timeout:60000},async()=>{
  const f=await postgresFixture({asApplication:true});let resume;
  try{
    for(const file of ['202609160005_publisher_account_lookup.sql','202610010001_progress_log_form_drafts.sql','202610220002_form_library.sql','202610280001_form_publications.sql'])
      await f.pool.query(await readFile(new URL('../ops/learning-migrations/'+file,import.meta.url),'utf8'));
    await f.pool.query(`ALTER TABLE mapping.reviewer_account ADD COLUMN role text DEFAULT 'teacher';
      INSERT INTO mapping.erp_class_membership_snapshot SELECT erp_course_class_id,erp_student_contact_id FROM mapping.student_mapping_review;
      INSERT INTO learning.course_content_authority(reviewer_email,course_code,can_self_approve_scored_forms,grant_reference)
        VALUES('teacher@example.test','56',true,'Native isolated fixture only');`);
    await f.pool.query("INSERT INTO learning.progress_log_admin(reviewer_email,status,grant_reference) VALUES('teacher@example.test','active','Explicit shared catalog fixture authority')");
    const reviewer={email:'teacher@example.test',canAccessAllClasses:false},drafts=createLearningFormDraftService({pool:f.clockPool}),library=createLearningFormLibrary({pool:f.clockPool,drafts});
    const payload=previewFormImport('type,prompt,skill\nreflection,Câu của bản chụp,reading').payload;payload.definition.courseCode='56';
    const draft=await drafts.create({classId:'2139',sessionNumber:1,operationId:randomUUID(),...payload,reviewer});
    await drafts.approve({id:draft.id,expectedRevision:1,expectedHash:draft.contentHash,reviewer});
    const entry=await library.store({draftId:draft.id,expectedRevision:1,expectedHash:draft.contentHash,scope:'izone',operationId:randomUUID(),reviewer});
    let savedBeforeCommit;const beforeCommit=new Promise(done=>{savedBeforeCommit=done;}),gate=new Promise(done=>{resume=done;});
    const slowPool={query:(...args)=>f.clockPool.query(...args),async connect(){const client=await f.clockPool.connect();return {release:()=>client.release(),async query(sql,params){
      if(sql.trim()==='COMMIT'){savedBeforeCommit();await gate;}return client.query(sql,params);
    }};}};
    const slowDrafts=createLearningFormDraftService({pool:slowPool}),definition=structuredClone(draft.definition);definition.title='Nháp mới vẫn được sửa';definition.blocks[0].items[0].prompt='Câu mới sau bản chụp';
    const saving=slowDrafts.save({id:draft.id,expectedRevision:1,sessionNumber:1,definition,gradingKey:draft.gradingKey,reviewer});await beforeCommit;
    let completed=false;const adopting=drafts.publicationFromSource({source:'library',id:entry.id,operationId:randomUUID(),reviewer}).then(value=>{completed=true;return value;});
    const deadline=Date.now()+5000;let waiting=false;
    while(Date.now()<deadline){const locks=await f.pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND (query LIKE '%FROM learning.form_draft WHERE id=%' OR query LIKE '%FROM learning.form_publication_lock%')");if(locks.rowCount){waiting=true;break;}await new Promise(done=>setTimeout(done,20));}
    assert.equal(waiting,true,'Adapter phải đợi khóa của save thật');assert.equal(completed,false);resume();await saving;const publication=await adopting;
    assert.notEqual(publication.formVersionId,draft.definition.formVersionId);
    const current=await drafts.get({id:draft.id,reviewer});assert.equal(current.revision,2);assert.equal(current.definition.title,definition.title);
    assert.equal((await drafts.save({id:draft.id,expectedRevision:2,sessionNumber:1,definition:current.definition,gradingKey:current.gradingKey,reviewer})).revision,3);
    const args={id:publication.id,reviewer,targets:[{classId:'2139',sessionNumber:2}]};
    const outcomes=await Promise.all([drafts.assignPublication({...args,operationId:randomUUID()}),drafts.assignPublication({...args,operationId:randomUUID()})]);
    assert.deepEqual(outcomes.map(o=>o.status).sort(),['failure','success']);
    assert.equal((await f.pool.query('SELECT count(*)::int n FROM learning.form_assignment')).rows[0].n,1);
    const assignment=(await f.pool.query('SELECT id,public_token FROM learning.form_assignment')).rows[0],student=(await f.pool.query('SELECT student_ref FROM learning.form_assignment_roster WHERE assignment_id=$1 LIMIT 1',[assignment.id])).rows[0];
    const journeyInput={publicToken:assignment.public_token,studentRef:student.student_ref};
    const journey=await f.service.getStudentCourseJourney(journeyInput);assert.equal(journey.sessions[1].submissionWindow.canSubmit,true);assert.equal(journey.sessions[1].submissionWindowSource,undefined);
    assert.equal(journey.sessions[1].firstBlockStatus,'open');assert.equal(journey.sessions[0].firstBlockStatus,null);
    await f.pool.query("UPDATE learning.form_assignment SET closes_at='2020-01-01T00:00:00Z' WHERE id=$1",[assignment.id]);
    const closed=await f.service.getStudentCourseJourney(journeyInput);assert.equal(closed.sessions[1].submissionWindow.canSubmit,false);assert.equal(closed.sessions[1].submissionWindow.reason,'manual_cutoff');
    assert.equal((await f.service.listTeacherOptions(reviewer)).classes[0].student_count,18);
    assert.equal((await f.pool.query('SELECT count(*)::int n FROM learning.submission')).rows[0].n,0);
    assert.equal((await f.pool.query('SELECT count(*)::int n FROM learning.outbox_job')).rows[0].n,0);
  }finally{resume?.();await f.close();}
});

test('PostgreSQL learning_api: lọc buổi theo ngày Việt Nam, giao và nhận bài vào đúng ID Portal',{timeout:60000},async t=>{
  const f=await postgresFixture({asApplication:true,studentCount:2});
  try{
    for(const file of ['202609160005_publisher_account_lookup.sql','202610010001_progress_log_form_drafts.sql',
      '202610220002_form_library.sql','202610280001_form_publications.sql','202611040001_form_assignment_portal_target.sql'])
      await f.pool.query(await readFile(new URL('../ops/learning-migrations/'+file,import.meta.url),'utf8'));
    await f.pool.query(`ALTER TABLE mapping.reviewer_account ADD COLUMN role text DEFAULT 'teacher';
      INSERT INTO mapping.erp_class_membership_snapshot SELECT erp_course_class_id,erp_student_contact_id FROM mapping.student_mapping_review;
      INSERT INTO learning.course_content_authority(reviewer_email,course_code,can_self_approve_scored_forms,grant_reference)
        VALUES('teacher@example.test','56',true,'Native isolated fixture only');`);
    const startsAt='2026-11-04 18:30:00',endsAt='2026-10-29 21:00:00';
    const slot={erpSessionId:'71901',startsAt,endsAt,date:'2026-11-04',statusCode:1};
    const prior={erpSessionId:'71900',startsAt:'2026-11-03 18:30:00',endsAt:'2026-11-03 21:00:00',date:'2026-11-03',statusCode:1};
    const upcoming={erpSessionId:'71902',startsAt:'2026-11-05 18:30:00',endsAt:'2026-11-05 21:00:00',date:'2026-11-05',statusCode:0};
    const schedule={classId:'2139',sessions:[prior,slot,upcoming]};
    const portalAssignmentReader=async()=>schedule;
    const reviewer={email:'teacher@example.test',canAccessAllClasses:false};
    const drafts=createLearningFormDraftService({pool:f.clockPool,portalAssignmentReader});
    const service=createLearningService({pool:f.clockPool,portalAssignmentReader});
    const payload=previewFormImport('type,prompt,skill\nreflection,Phiếu kiểm thử Portal,reading').payload;
    payload.definition.courseCode='56';
    const draft=await drafts.create({classId:'2139',sessionNumber:1,operationId:randomUUID(),...payload,reviewer});
    await drafts.approve({id:draft.id,expectedRevision:1,expectedHash:draft.contentHash,reviewer});
    const publication=await drafts.publishLibrary({id:draft.id,expectedRevision:1,operationId:randomUUID(),reviewer});
    const readOptions=()=>service.getTeacherAssignmentSessions({classId:'2139',source:'portal',reviewer});
    t.mock.timers.enable({apis:['Date'],now:new Date('2026-11-03T16:59:59Z')});
    assert.deepEqual((await readOptions()).sessions.map(s=>s.sessionNumber),[1,2,3]);
    t.mock.timers.setTime(Date.parse('2026-11-03T17:00:00Z'));
    assert.deepEqual((await readOptions()).sessions.map(s=>[s.sessionNumber,s.date]),[[2,'2026-11-04'],[3,'2026-11-05']]);
    const assignmentInput={id:publication.id,reviewer,operationId:randomUUID()};
    const target={classId:'2139',sessionNumber:2,portalTarget:{id:'71901',startsAt}};
    const stale=await drafts.assignPublication({...assignmentInput,targets:[{...target,portalTarget:{...target.portalTarget,startsAt:'2026-11-04 17:00:00'}}]});
    assert.equal(stale.results[0].error,'ERP_SESSION_REVIEW_REQUIRED');
    const delivery=(await drafts.assignPublication({...assignmentInput,targets:[target]})).results[0];
    assert.equal(delivery.ok,true,JSON.stringify(delivery));
    assert.equal((await drafts.assignPublication({...assignmentInput,targets:[target]})).results[0].delivery.replayed,true);
    assert.deepEqual((await readOptions()).sessions.map(s=>s.sessionNumber),[3]);
    assert.equal((await f.pool.query('SELECT count(*)::int n FROM learning.class_journey_plan')).rows[0].n,0);
    assert.equal((await f.pool.query('SELECT count(*)::int n FROM learning.outbox_job')).rows[0].n,0);
    const assignment=await service.getPublicAssignment(delivery.delivery.publicToken);
    const start=student=>service.startAttempt({publicToken:delivery.delivery.publicToken,studentRef:student.studentRef,
      identityConfirmed:true,clientIdempotencyKey:randomUUID()});
    const attempt=await start(assignment.roster[0]);
    await service.submit({attemptToken:attempt.attemptToken,submissionId:randomUUID(),definitionHash:assignment.definitionHash,draftRevision:0,responses:{}});
    const binding=(await f.pool.query('SELECT target_session_id::text,schedule_fingerprint FROM learning.portal_attendance_binding')).rows[0];
    assert.equal(binding.target_session_id,'71901');
    assert.deepEqual(JSON.parse(binding.schedule_fingerprint),['2139',
      [[prior.erpSessionId,prior.startsAt,prior.endsAt,1],['71901',startsAt,endsAt,1],
        [upcoming.erpSessionId,upcoming.startsAt,upcoming.endsAt,0]]]);
    assert.equal((await f.pool.query("SELECT count(*)::int n FROM learning.outbox_job WHERE job_type='sync_portal_attendance'")).rows[0].n,1);
    slot.startsAt='2026-11-04 19:00:00';
    await start(assignment.roster[1]);
    const journey=await service.getStudentCourseJourney({publicToken:delivery.delivery.publicToken,studentRef:assignment.roster[1].studentRef});
    const lesson=journey.sessions.find(row=>row.assignmentId===assignment.assignmentId);
    assert.equal(lesson.erpSessionId,'71901');assert.equal(lesson.sessionStartTime,'19:00:00');
    await assert.rejects(()=>f.clockPool.query('UPDATE learning.form_assignment_portal_target SET portal_session_id=71902'),{code:'42501'});
  }finally{await f.close();}
});
