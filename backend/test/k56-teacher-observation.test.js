import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import express from 'express';
import request from 'supertest';
import pg from 'pg';
import {createK56TeacherObservation,mountK56TeacherObservation,k56TeacherAuthorization} from '../src/k56-teacher-observation.js';
const input={class:'IC2304',test:'term-test-1-k56'},ref='11111111-1111-4111-8111-111111111111';
const email='teacher@fixture.test',proof={source:'google_bearer',canAccessAllClasses:false};
async function fixture(t){
 let f;
 if(process.env.K56_OBSERVE_NATIVE_VARIANT){
  const {createNativeK56ObservationFixture}=await import('./helpers/k56-native-observation-fixture.mjs');
  f=await createNativeK56ObservationFixture();
 }else{
  const {createMiniFixture}=await import('../../products/term-mini-k67/test/helpers/mini-answer-sheet-fixture.js');
  f=await createMiniFixture({examOrder:true,completeSchema:true});
 }
 t.after(async()=>{await f.app.locals.termTeacherObservation.close();await f.app.locals.termTestResultStream?.close();await f.db.close();});
 if(!process.env.K56_OBSERVE_NATIVE_VARIANT){
 const schema=await readFile(new URL('../../products/term-mini-k67/db/001-context.sql',import.meta.url),'utf8');
 for(const name of ['reviewer_account','reviewer_class_access','reviewer_session'])await f.db.exec(schema.match(new RegExp(`CREATE TABLE mapping\\.${name} \\([\\s\\S]*?\\n\\);`))[0].replace('CREATE TABLE mapping.','CREATE TABLE IF NOT EXISTS mapping.'));
 // Mô hình cột K56 đã đọc từ server; không thêm các cột K67 để làm truy vấn qua.
 await f.db.exec(`DROP TABLE mapping.k67_context_state;
  ALTER TABLE assessment.test_definition DROP CONSTRAINT test_definition_slug_check;
  ALTER TABLE assessment.test_definition ADD CONSTRAINT test_definition_slug_check
   CHECK ((slug ~ '^(term-test-[1-9][0-9]*(-k[1-9][0-9]*)?|mini-test-[a-z0-9-]+)$'::text));
  ALTER TABLE assessment.term_test_attempt DROP COLUMN writing_scope,DROP COLUMN writing_source_attempt_id,DROP COLUMN exam_delivery;
  ALTER TABLE assessment.term_test_exam_session DROP COLUMN exam_mode;
  ALTER TABLE mapping.reviewer_account ADD CONSTRAINT reviewer_account_status_check CHECK(status IN ('active','inactive'));
  ALTER TABLE mapping.reviewer_session ADD CONSTRAINT reviewer_session_expiry_order_check CHECK(created_at<=idle_expires_at AND idle_expires_at<=absolute_expires_at);
  ALTER TABLE mapping.reviewer_session ADD CONSTRAINT reviewer_session_revocation_check CHECK((revoked_at IS NULL)=(revoked_reason IS NULL));
  ALTER TABLE mapping.reviewer_session ADD CONSTRAINT reviewer_session_token_hash_length_check CHECK(octet_length(token_hash)=32);
  CREATE TABLE mapping.reviewer_class_assignment(reviewer_email text,class_name text);`);
 const q={questions:[{number:1,accepted:['A']}]};
 await f.db.query(`INSERT INTO assessment.test_definition(slug,title,version,listening_definition,reading_definition,is_active)
  VALUES($1,'Đề K56 mô phỏng',1,$2,$2,true)`,[input.test,JSON.stringify(q)]);
 }
 await f.db.query("INSERT INTO mapping.reviewer_account(email,google_subject,role,status) VALUES($1,'fixture-subject','teacher','active')",[email]);
 const service=createK56TeacherObservation({pool:f.pool});t.after(()=>service.hub.close());
 const watch=(scope=input,authorization=proof)=>service.guard(scope,email,authorization);
 const read=async(scope=input,authorization=proof)=>{const w=watch(scope,authorization);return service.hub.readOnce(w.scope,w.guard);};
 return{...f,service,read,watch};
}
test('K56 metadata SQL: direct normalized class assignment and materialized access are both preserved',async t=>{
 const f=await fixture(t);await assert.rejects(f.read(),e=>e.status===403);
 await f.db.query("INSERT INTO mapping.reviewer_class_assignment(reviewer_email,class_name) VALUES($1,' ic2304 ')",[email]);const direct=await f.read();
 assert.equal(direct.testSlug,input.test);assert.equal(direct.className,input.class);
 await f.db.query('DELETE FROM mapping.reviewer_class_assignment');await assert.rejects(f.read(),e=>e.status===403);
 await f.db.query('INSERT INTO mapping.reviewer_class_access(reviewer_email,erp_course_class_id) VALUES($1,1293)',[email]);const materialized=await f.read();
 assert.equal(materialized.contentRevision,direct.contentRevision);assert.equal(materialized.accessRevision,direct.accessRevision);
 await f.db.query('DELETE FROM mapping.reviewer_class_access');await assert.rejects(f.read(),e=>e.status===403);
});
test('K56 metadata SQL: current admin rights remain capped by the originally authenticated native request',async t=>{
 const f=await fixture(t);await f.db.query("UPDATE mapping.reviewer_account SET role='admin'");
 await assert.rejects(f.read(),e=>e.status===403);
 const adminProof={...proof,canAccessAllClasses:true};await f.read(input,adminProof);
 await f.db.query("UPDATE mapping.reviewer_account SET role='teacher'");await assert.rejects(f.read(input,adminProof),e=>e.status===403);
 await f.db.query('UPDATE mapping.reviewer_account SET can_access_all_classes=true');await f.read(input,adminProof);
 await assert.rejects(f.read(),e=>e.status===403);
 await f.db.query("UPDATE mapping.reviewer_account SET status='inactive'");await assert.rejects(f.read(input,adminProof),e=>e.status===401);
});
test('K56 metadata SQL: native cookie subject, revocation and expiry are rechecked without touching the session',async t=>{
 const f=await fixture(t),token='A'.repeat(43);await f.db.query("INSERT INTO mapping.reviewer_class_assignment(reviewer_email,class_name) VALUES($1,'IC2304')",[email]);
 const auth=k56TeacherAuthorization({authSource:'session',teacherSessionToken:token,reviewer:{email,canAccessAllClasses:false}});
 await f.db.query(`INSERT INTO mapping.reviewer_session(token_hash,reviewer_email,google_subject,idle_expires_at,absolute_expires_at)
  VALUES(decode($1,'hex'),$2,'fixture-subject',now()+interval '1 day',now()+interval '2 days')`,[auth.tokenHash,email]);
 const before=(await f.db.query('SELECT to_jsonb(s) AS value FROM mapping.reviewer_session s')).rows;
 const value=await f.read(input,auth);assert.deepEqual((await f.db.query('SELECT to_jsonb(s) AS value FROM mapping.reviewer_session s')).rows,before);
 assert.equal(JSON.stringify(value).includes(token),false);assert.equal(JSON.stringify(value).includes(auth.tokenHash),false);
 await f.db.query("UPDATE mapping.reviewer_session SET revoked_at=now(),revoked_reason='fixture-revoked'");await assert.rejects(f.read(input,auth),e=>e.status===401);
 await f.db.query("UPDATE mapping.reviewer_session SET revoked_at=NULL,revoked_reason=NULL,created_at=now()-interval '2 days',idle_expires_at=now()-interval '1 second'");await assert.rejects(f.read(input,auth),e=>e.status===401);
 await f.db.query("UPDATE mapping.reviewer_session SET idle_expires_at=now()+interval '1 day',google_subject='other-subject'");await assert.rejects(f.read(input,auth),e=>e.status===401);
 assert.deepEqual(k56TeacherAuthorization({authSource:'unknown',reviewer:{email,canAccessAllClasses:true}}),{source:'none',canAccessAllClasses:false});
});
test('K56 metadata SQL: selected drafts do not invalidate the class and need no K67 context or Writing-scope column',async t=>{
 const f=await fixture(t);await f.db.query("INSERT INTO mapping.reviewer_class_assignment(reviewer_email,class_name) VALUES($1,'IC2304')",[email]);
 const selected={...input,student:ref},beforeClass=await f.read(),beforeStudent=await f.read(selected),session='60000000-0000-4000-8000-000000000001';
 await f.db.query(`INSERT INTO assessment.term_test_exam_session(id,test_slug,definition_version,erp_course_class_id,class_name_snapshot,
  erp_student_contact_id,student_name_snapshot,attempt_mode,listening_draft,listening_draft_updated_at)
  VALUES($1,$2,1,1293,'IC2304',900001,'Học viên giả','cbt','{"1":"A"}','2026-11-01T00:00:00Z')`,[session,input.test]);
 const saved=await f.read(selected);assert.notEqual(saved.contentRevision,beforeStudent.contentRevision);assert.equal((await f.read()).contentRevision,beforeClass.contentRevision);
 await f.db.query(`UPDATE assessment.term_test_exam_session SET listening_draft='{"1":"B"}' WHERE id=$1`,[session]);
 assert.notEqual((await f.read(selected)).contentRevision,saved.contentRevision);assert.equal((await f.read()).contentRevision,beforeClass.contentRevision);
});
test('K56 metadata HTTP: native request proof and exact K56 slug allowlists, never K67 permission/context adapters',async t=>{
 const f=await fixture(t);await f.db.query("INSERT INTO mapping.reviewer_class_assignment(reviewer_email,class_name) VALUES($1,'IC2304')",[email]);
 const app=express(),authenticate=(req,_res,next)=>{req.authSource='google_bearer';req.reviewer={email,canAccessAllClasses:false};next();};
 const mounted=mountK56TeacherObservation(app,{pool:f.pool,authenticate,limiter:(_req,_res,next)=>next()});t.after(()=>mounted.close());
 const response=await request(app).get('/api/term-tests/teacher/state').query(input).expect(200);
 assert.equal(response.body.state.kind,'term-teacher-state-v1');assert.equal(response.body.state.testSlug,input.test);
 await request(app).get('/api/term-tests/teacher/state').query({...input,test:'term-test-1'}).expect(400);
 for(const testSlug of ['term-test-1-k56','term-test-2-k56','mini-test-k56'])assert.equal(f.watch({...input,test:testSlug}).scope.testSlug,testSlug);
 assert.throws(()=>f.watch({...input,test:'term-test-1'}),e=>e.status===400);
});

test('Native K56 app: exact profile/options/state, native schema boundary, fixture Google exchange then cookie revocation',
 {skip:!process.env.K56_OBSERVE_NATIVE_VARIANT},async t=>{
 const f=await fixture(t);
 await f.db.query("INSERT INTO mapping.reviewer_class_assignment(reviewer_email,class_name) VALUES($1,'IC2304')",[email]);
 await request(f.app).get('/api/term-tests/teacher/options').expect(401);
 const options=await request(f.app).get('/api/term-tests/teacher/options').set('x-review-token','fixture-only-key').expect(200);
 assert.equal(options.body.capabilities.teacherStateVersion,1);assert.ok(options.body.tests.some(row=>row.slug===input.test));
 const state=await request(f.app).get('/api/term-tests/teacher/state').set('x-review-token','fixture-only-key').query(input).expect(200);
 assert.equal(state.body.state.testSlug,input.test);assert.equal(state.body.state.className,input.class);
 if(f.variant==='real'){
  const raw=new pg.Pool({connectionString:process.env.DATABASE_URL,max:1});
  try{await assert.rejects(raw.query('SELECT slug FROM assessment.test_definition'),error=>error.code==='42501');}finally{await raw.end();}
 }
 const googleApp=f.createApp({pool:f.pool,config:{...f.config,authMode:'google',googleClientId:'fixture-client'},
  verifyGoogleToken:async credential=>{assert.equal(credential,'fixture-native-google-credential');return{email,sub:'fixture-subject',email_verified:true};}});
 t.after(()=>googleApp.locals.termTeacherObservation.close());
 const login=await request(googleApp).post('/api/auth/session').set('Origin','https://fixture.invalid').send({credential:'fixture-native-google-credential'}).expect(201);
 const cookie=login.headers['set-cookie'].map(value=>value.split(';')[0]).join('; ');
 await request(googleApp).get('/api/term-tests/teacher/state').set('Cookie',cookie).query(input).expect(200);
 await f.db.query("UPDATE mapping.reviewer_session SET revoked_at=now(),revoked_reason='fixture-native-revoked'");
 await request(googleApp).get('/api/term-tests/teacher/state').set('Cookie',cookie).query(input).expect(401);
 assert.equal((await f.db.query('SELECT count(*)::int AS n FROM assessment.term_test_attempt')).rows[0].n,0);
});
