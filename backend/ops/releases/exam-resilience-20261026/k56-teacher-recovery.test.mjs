import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {createMiniFixture} from '../../../../products/term-mini-k67/test/helpers/mini-answer-sheet-fixture.js';
import {createTeacherAudioRecovery} from '../../../../products/term-mini-k67/src/teacher-audio-recovery.js';
const source=process.env.K56_RUNTIME_SOURCE;
if(!source)throw Error('K56_RUNTIME_SOURCE must point to an isolated captured native runtime');
const {readTeacherSavedProgress}=await import(pathToFileURL(source+'/k56-teacher-saved-progress.js'));
const {checkpointK56ListeningAudio}=await import(pathToFileURL(source+'/k56-listening-audio-recovery.js'));
for(const schemaName of ['assessment','assessment_k56'])test(`native K56 teacher guard + ${schemaName}: release preserves rows, audit and immediate class revocation`,async()=>{
 const f=await createMiniFixture({examOrder:true,completeSchema:true});
 const email='teacher@fixture.test',ref='11111111-1111-4111-8111-111111111111',id=randomUUID();
 try{
  const sql=await readFile(new URL('../../../../products/term-mini-k67/db/001-context.sql',import.meta.url),'utf8');
  for(const name of ['reviewer_account','reviewer_class_access','reviewer_session'])await f.db.exec(sql.match(new RegExp(`CREATE TABLE mapping\\.${name} \\([\\s\\S]*?\\n\\);`))[0].replace('CREATE TABLE mapping.','CREATE TABLE IF NOT EXISTS mapping.'));
  await f.db.exec('CREATE TABLE mapping.reviewer_class_assignment(reviewer_email text NOT NULL,class_name text NOT NULL,PRIMARY KEY(reviewer_email,class_name));');
  await f.db.query(`INSERT INTO mapping.reviewer_account(email,google_subject,role,status) VALUES($1,'fixture-subject','teacher','active')`,[email]);
  await f.db.query('INSERT INTO mapping.reviewer_class_access VALUES($1,1293)',[email]);
  await f.db.exec(`ALTER TABLE assessment.term_test_exam_session ADD COLUMN listening_audio_owner_id uuid,ADD COLUMN audio_state_revision bigint NOT NULL DEFAULT 0;
   INSERT INTO assessment.test_definition(slug,title,version,listening_definition,reading_definition,is_active)
   SELECT 'mini-test-k56','K56 fixture',1,listening_definition,reading_definition,true FROM assessment.test_definition WHERE slug='mini-test-lesson-5';`);
  await f.db.query(`INSERT INTO assessment.term_test_exam_session(id,test_slug,definition_version,erp_course_class_id,class_name_snapshot,erp_student_contact_id,student_name_snapshot,
   attempt_mode,listening_started_at,listening_deadline_at,listening_draft,listening_draft_revision,listening_audio_owner_id,audio_state_revision)
   VALUES($1,'mini-test-k56',1,1293,'IC2304',900001,'Fictional','cbt',now(),now()+interval '30 minutes','{"11":"saved"}',7,$2,4)`,[id,randomUUID()]);
  await f.db.exec(await readFile(new URL('../../../../products/term-mini-k67/db/013-audio-owner-recovery.sql',import.meta.url),'utf8'));
  if(schemaName!=='assessment')await f.db.exec('ALTER SCHEMA assessment RENAME TO assessment_k56;');
  const rewrite=text=>text.replaceAll('assessment.',schemaName+'.');
  const pool={query:(sql,args)=>f.pool.query(rewrite(sql),args),connect:async()=>{const db=await f.pool.connect();return {query:(sql,args)=>db.query(rewrite(sql),args),release:()=>db.release()};}};
  const service=createTeacherAudioRecovery({pool,profile:'k56',readScope:(db,input,req)=>readTeacherSavedProgress(db,input,req)});
  const req={authSource:'google_bearer',reviewer:{email,canAccessAllClasses:false}},input={class:'IC2304',test:'mini-test-k56',student:ref};
  const before=(await pool.query('SELECT * FROM assessment.term_test_exam_session WHERE id=$1',[id])).rows[0];
  await assert.rejects(checkpointK56ListeningAudio(pool,{token:id,slug:input.test,heardSeconds:0,state:'resume',recoveryId:randomUUID(),
    generation:0,audioStateRevision:4,audioOwnerId:randomUUID(),listeningDurationSeconds:120}),e=>e.code==='AUDIO_OWNER_CONFLICT');
  assert.deepEqual((await pool.query('SELECT * FROM assessment.term_test_exam_session WHERE id=$1',[id])).rows[0],before);
  const payload={...input,requestId:randomUUID(),expectedVersion:(await service.read(input,req)).state.version,action:'transfer-active',oldDeviceStopped:true,reason:'Confirmed old device is closed'};
  assert.equal((await service.recover(payload,req)).recovered,true);
  const after=(await pool.query('SELECT * FROM assessment.term_test_exam_session WHERE id=$1',[id])).rows[0];
  for(const key of Object.keys(before).filter(k=>!['listening_audio_owner_id','audio_state_revision'].includes(k)))assert.deepEqual(after[key],before[key],key);
  assert.equal(after.listening_audio_owner_id,null);assert.equal(Number(after.audio_state_revision),5);
  assert.equal((await service.recover(payload,req)).replayed,true);
  assert.equal((await pool.query('SELECT count(*)::int n FROM assessment.term_test_audio_owner_recovery')).rows[0].n,1);
  await f.db.query('DELETE FROM mapping.reviewer_class_access WHERE reviewer_email=$1',[email]);
  await assert.rejects(service.read(input,req),e=>e.status===403);
 }finally{await f.db.close();}
});
