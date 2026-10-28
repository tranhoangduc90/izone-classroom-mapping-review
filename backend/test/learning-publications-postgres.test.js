import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {postgresFixture} from './learning-postgres-fixture.js';
import {createLearningFormDraftService} from '../src/learning-form-drafts.js';
import {createLearningFormLibrary} from '../src/learning-form-library.js';
import {previewFormImport} from '../src/learning-form-import.js';

test('R30 PostgreSQL: giao bản chụp đợi save đang commit, không khóa nhầm revision mới; hai lần giao cạnh tranh chỉ có một phiếu',{timeout:60000},async()=>{
  const f=await postgresFixture({asApplication:true});let resume;
  try{
    for(const file of ['202609160005_publisher_account_lookup.sql','202610010001_progress_log_form_drafts.sql','202610220002_form_library.sql','202610280001_form_publications.sql'])
      await f.pool.query(await readFile(new URL('../ops/learning-migrations/'+file,import.meta.url),'utf8'));
    await f.pool.query(`ALTER TABLE mapping.reviewer_account ADD COLUMN role text DEFAULT 'teacher';
      INSERT INTO mapping.erp_class_membership_snapshot SELECT erp_course_class_id,erp_student_contact_id FROM mapping.student_mapping_review;
      INSERT INTO learning.course_content_authority(reviewer_email,course_code,can_self_approve_scored_forms,grant_reference)
        VALUES('teacher@example.test','56',true,'Native isolated fixture only');`);
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
    while(Date.now()<deadline){const locks=await f.pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FROM learning.form_draft WHERE id=%'");if(locks.rowCount){waiting=true;break;}await new Promise(done=>setTimeout(done,20));}
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
    await f.pool.query("UPDATE learning.form_assignment SET closes_at='2020-01-01T00:00:00Z' WHERE id=$1",[assignment.id]);
    const closed=await f.service.getStudentCourseJourney(journeyInput);assert.equal(closed.sessions[1].submissionWindow.canSubmit,false);assert.equal(closed.sessions[1].submissionWindow.reason,'manual_cutoff');
    assert.equal((await f.service.listTeacherOptions(reviewer)).classes[0].student_count,18);
    assert.equal((await f.pool.query('SELECT count(*)::int n FROM learning.submission')).rows[0].n,0);
    assert.equal((await f.pool.query('SELECT count(*)::int n FROM learning.outbox_job')).rows[0].n,0);
  }finally{resume?.();await f.close();}
});
