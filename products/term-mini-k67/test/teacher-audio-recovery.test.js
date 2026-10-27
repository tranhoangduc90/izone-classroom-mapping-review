import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import request from 'supertest';
import {createMiniFixture} from './helpers/mini-answer-sheet-fixture.js';
import {readTeacherSavedProgress} from '../src/teacher-saved-progress.js';
import {createTeacherAudioRecovery} from '../src/teacher-audio-recovery.js';

const ref='11111111-1111-4111-8111-111111111111',input={class:'IC2304',test:'mini-test-lesson-5',student:ref};
const email='teacher@fixture.test',authorization={source:'google_bearer',googleSubject:'subject-fixture'},actor={reviewer:{email}};
async function fixture(started=false){
 const f=await createMiniFixture({examOrder:true,completeSchema:true});
 const schema=await readFile(new URL('../db/001-context.sql',import.meta.url),'utf8');
 for(const name of ['reviewer_account','reviewer_class_access','reviewer_session'])await f.db.exec(schema.match(new RegExp(`CREATE TABLE mapping\\.${name} \\([\\s\\S]*?\\n\\);`))[0].replace('CREATE TABLE mapping.','CREATE TABLE IF NOT EXISTS mapping.'));
 await f.db.exec(await readFile(new URL('../db/013-audio-owner-recovery.sql',import.meta.url),'utf8'));
 await f.db.query(`INSERT INTO mapping.reviewer_account(email,google_subject,role,status) VALUES($1,$2,'teacher','active')`,[email,authorization.googleSubject]);
 await f.db.query('INSERT INTO mapping.reviewer_class_access VALUES($1,1293)',[email]);
 const id=randomUUID(),ownerId=randomUUID(),proof='a'.repeat(64),page=randomUUID();
 await f.db.query(`INSERT INTO assessment.term_test_exam_session(id,test_slug,definition_version,erp_course_class_id,class_name_snapshot,
   erp_student_contact_id,student_name_snapshot,attempt_mode,listening_started_at,listening_deadline_at,listening_draft,listening_draft_revision,
   audio_owner_protocol,audio_owner_id,audio_owner_page_id,audio_owner_proof_hash,audio_owner_epoch)
   VALUES($1,'mini-test-lesson-5',1,1293,'IC2304',900001,'Học viên mô phỏng','cbt',$2,CASE WHEN $2::timestamptz IS NULL THEN NULL ELSE now()+interval '30 minutes' END,'{"11":"B"}',3,1,$3,$4,$5,4)`,
 [id,started?new Date():null,ownerId,page,createHash('sha256').update(proof).digest('hex')]);
 const service=createTeacherAudioRecovery({pool:f.pool,readScope:(db,x,req)=>readTeacherSavedProgress(db,x,req.reviewer.email,authorization)});
 const readRow=()=>f.db.query('SELECT * FROM assessment.term_test_exam_session WHERE id=$1',[id]).then(r=>r.rows[0]);
 const action=async(kind='release-preparation')=>({...input,requestId:randomUUID(),expectedVersion:(await service.read(input,actor)).state.version,action:kind,oldDeviceStopped:true,reason:'Thiết bị cũ đã được đóng trước khi hỗ trợ'});
 return {...f,id,service,readRow,action};
}

for(const started of [false,true])test(`teacher ${started?'active transfer':'preparation release'} preserves every non-owner field and audits once`,async()=>{
 const f=await fixture(started);try{
  const before=await f.readRow(),payload=await f.action(started?'transfer-active':'release-preparation');
  const response=await f.service.recover(payload,actor);assert.equal(response.recovered,true);
  const after=await f.readRow();
  for(const key of Object.keys(before).filter(k=>!['audio_owner_id','audio_owner_page_id','audio_owner_proof_hash','audio_owner_epoch'].includes(k)))assert.deepEqual(after[key],before[key],key);
  assert.equal(after.audio_owner_id,null);assert.equal(Number(after.audio_owner_epoch),5);
  assert.equal((await f.db.query('SELECT count(*)::int n FROM assessment.term_test_audio_owner_recovery')).rows[0].n,1);
  // Lost reply retries must not release the next owner or create another audit.
  const next=randomUUID();await f.db.query('UPDATE assessment.term_test_exam_session SET audio_owner_id=$2,audio_owner_epoch=audio_owner_epoch+1 WHERE id=$1',[f.id,next]);
  assert.equal((await f.service.recover(payload,actor)).replayed,true);assert.equal((await f.readRow()).audio_owner_id,next);
  assert.equal((await f.db.query('SELECT count(*)::int n FROM assessment.term_test_audio_owner_recovery')).rows[0].n,1);
  assert.equal((await f.db.query('SELECT count(*)::int n FROM assessment.term_test_attempt')).rows[0].n,0);
  // Existing synthetic demo reset deletes the parent session; the audit must not
  // make that legitimate operation fail with a foreign-key error.
  await f.db.query('DELETE FROM assessment.term_test_exam_session WHERE id=$1',[f.id]);
  assert.equal((await f.db.query('SELECT count(*)::int n FROM assessment.term_test_audio_owner_recovery')).rows[0].n,0);
 }finally{await f.db.close();}
});

test('stale state, unconfirmed active device and revoked class access cannot mutate ownership',async()=>{
 const f=await fixture(true);try{
  const payload=await f.action('transfer-active'),before=await f.readRow();
  await assert.rejects(f.service.recover({...payload,oldDeviceStopped:false},actor),e=>e.code==='OLD_DEVICE_STOP_REQUIRED');
  await assert.rejects(f.service.recover({...payload,action:'release-preparation'},actor),e=>e.code==='RECOVERY_NOT_ALLOWED');
  await f.db.query('UPDATE assessment.term_test_exam_session SET audio_owner_epoch=audio_owner_epoch+1 WHERE id=$1',[f.id]);
  await assert.rejects(f.service.recover(payload,actor),e=>e.code==='RECOVERY_STATE_CHANGED');
  await f.db.query('DELETE FROM mapping.reviewer_class_access WHERE reviewer_email=$1',[email]);
  await assert.rejects(f.service.recover(payload,actor),e=>e.status===403);
  assert.equal((await f.readRow()).audio_owner_id,before.audio_owner_id);
  assert.equal((await f.db.query('SELECT count(*)::int n FROM assessment.term_test_audio_owner_recovery')).rows[0].n,0);
  await request(f.app).get('/api/term-tests/teacher/audio-recovery').query(input).expect(401);
 }finally{await f.db.close();}
});
