import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import request from 'supertest';
import {readTeacherSavedProgress} from '../src/k56-teacher-saved-progress.js';

const native=Boolean(process.env.K56_OBSERVE_NATIVE_VARIANT);
const input={class:'IC2304',test:'term-test-1-k56',student:'11111111-1111-4111-8111-111111111111'};
const session='60000000-0000-4000-8000-000000000001';
const legacy={authSource:'legacy',reviewer:{email:'legacy@mapping.local',canAccessAllClasses:true}};
async function fixture(t){
 const {createNativeK56ObservationFixture}=await import('./helpers/k56-native-observation-fixture.mjs');
 const f=await createNativeK56ObservationFixture();t.after(()=>f.db.close());
 await f.db.query(`INSERT INTO assessment.term_test_exam_session(id,test_slug,definition_version,erp_course_class_id,class_name_snapshot,
  erp_student_contact_id,student_name_snapshot,attempt_mode,listening_draft,listening_draft_updated_at)
  VALUES($1,$2,1,1293,'IC2304',900001,'Học viên mô phỏng','cbt','{"1":"B"}','2026-11-01T00:00:00Z')`,[session,input.test]);
 return {...f,read:(extra={},req=legacy)=>readTeacherSavedProgress(f.pool,{...input,...extra},req)};
}

test('Native K56 saved progress: index/view preserve legacy and native schema while detecting same-timestamp drafts', {skip:!native},async t=>{
 const f=await fixture(t),legacyData=await f.read(),index=await f.read({mode:'index'}),summary=index.attempts[0];
 assert.equal(index.format,'saved-progress-index-v1');assert.equal(summary.viewId,legacyData.attempts[0].viewId);
 assert.match(summary.revision,/^[a-f0-9]{32}$/);
 for(const key of ['listening','reading','writing'])assert.equal(Object.hasOwn(summary,key),false);
 const before=(await f.db.query('SELECT to_jsonb(s) AS value FROM assessment.term_test_exam_session s')).rows;
 const result=await f.read({mode:'view',viewId:summary.viewId}),{revision,...original}=result.attempts[0];
 assert.deepEqual(original,legacyData.attempts[0]);assert.equal(revision,summary.revision);
 assert.deepEqual((await f.db.query('SELECT to_jsonb(s) AS value FROM assessment.term_test_exam_session s')).rows,before);
 await f.db.query(`UPDATE assessment.term_test_exam_session SET listening_draft='{"1":"Vừa sửa"}' WHERE id=$1`,[session]);
 const changed=await f.read({mode:'index'});assert.notEqual(changed.attempts[0].revision,revision);
 const detail=await f.read({mode:'view',viewId:summary.viewId});
 assert.equal(detail.attempts[0].listening.savedAt,result.attempts[0].listening.savedAt);
 assert.equal(detail.attempts[0].listening.answers['1'],'Vừa sửa');
 assert.equal(JSON.stringify(detail).includes(session),false);
 await assert.rejects(f.read({mode:'view',viewId:'a'.repeat(64)}),e=>e.status===404&&e.code==='SAVED_VIEW_NOT_FOUND');
 const other='44444444-4444-4444-8444-444444444444';
 await f.db.query(`INSERT INTO mapping.student_mapping_review(public_id,erp_course_class_id,erp_student_contact_id,erp_student_name_snapshot,status)
  VALUES($1,1293,900002,'Người khác','approved')`,[other]);
 await assert.rejects(f.read({mode:'view',student:other,viewId:summary.viewId}),e=>e.status===404);
});

test('Native K56 saved progress: direct class assignment and cookie/session revocation protect both compact reads', {skip:!native},async t=>{
 const f=await fixture(t),email='teacher@fixture.test',token='A'.repeat(43),hash=createHash('sha256').update(token).digest();
 await f.db.query("INSERT INTO mapping.reviewer_account(email,google_subject,role,status) VALUES($1,'fixture-subject','teacher','active')",[email]);
 await f.db.query("INSERT INTO mapping.reviewer_class_assignment(reviewer_email,class_name) VALUES($1,' ic2304 ')",[email]);
 await f.db.query(`INSERT INTO mapping.reviewer_session(token_hash,reviewer_email,google_subject,idle_expires_at,absolute_expires_at)
  VALUES($1,$2,'fixture-subject',now()+interval '1 day',now()+interval '2 days')`,[hash,email]);
 const req={authSource:'session',teacherSessionToken:token,reviewer:{email,canAccessAllClasses:false}};
 const before=(await f.db.query('SELECT to_jsonb(s) AS value FROM mapping.reviewer_session s')).rows;
 const index=await f.read({mode:'index'},req),viewId=index.attempts[0].viewId;await f.read({mode:'view',viewId},req);
 assert.deepEqual((await f.db.query('SELECT to_jsonb(s) AS value FROM mapping.reviewer_session s')).rows,before);
 await f.db.query('DELETE FROM mapping.reviewer_class_assignment');
 for(const extra of [{mode:'index'},{mode:'view',viewId}])await assert.rejects(f.read(extra,req),e=>e.status===403);
 await f.db.query("INSERT INTO mapping.reviewer_class_assignment(reviewer_email,class_name) VALUES($1,'IC2304')",[email]);
 await f.db.query("UPDATE mapping.reviewer_session SET revoked_at=now(),revoked_reason='fixture-revoked'");
 for(const extra of [{mode:'index'},{mode:'view',viewId}])await assert.rejects(f.read(extra,req),e=>e.httpStatus===401);
});

test('Native K56 saved progress HTTP: exact native profile, strict compact selectors and unchanged old client response', {skip:!native},async t=>{
 const f=await fixture(t),url='/api/term-tests/teacher/saved-progress';
 const api=()=>request(f.app).get(url).set('x-review-token','fixture-only-key');
 await request(f.app).get(url).query({...input,mode:'index'}).expect(401);
 for(const extra of [{mode:'view'},{viewId:'a'.repeat(64)},{mode:'index',viewId:'a'.repeat(64)},
  {mode:'view',viewId:session},{mode:'index',extra:'unknown'}])await api().query({...input,...extra}).expect(400);
 await api().query({...input,test:'term-test-1',mode:'index'}).expect(400);
 const original=await api().query(input).expect(200),index=await api().query({...input,mode:'index'}).expect(200);
 assert.match(index.headers['cache-control'],/no-store/);assert.equal(Object.hasOwn(original.body,'format'),false);
 const selected=await api().query({...input,mode:'view',viewId:index.body.attempts[0].viewId}).expect(200);
 const {revision,...body}=selected.body.attempts[0];assert.equal(revision,index.body.attempts[0].revision);assert.deepEqual(body,original.body.attempts[0]);
 const options=await request(f.app).get('/api/term-tests/teacher/options').set('x-review-token','fixture-only-key').expect(200);
 assert.equal(options.body.capabilities.teacherSavedProgressVersion,1);
});
