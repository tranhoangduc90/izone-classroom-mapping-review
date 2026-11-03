import test from 'node:test';
import assert from 'node:assert/strict';
import {createTermTeacherObservation,teacherObservationBatchSql} from '../src/term-test-teacher-observation.js';
import {createMiniFixture} from './helpers/mini-answer-sheet-fixture.js';
import {readFile} from 'node:fs/promises';

const ref='11111111-1111-4111-8111-111111111111',other='44444444-4444-4444-8444-444444444444';
const input={class:'IC2304',test:'mini-test-lesson-5'},email='teacher@fixture.test';
const authorization={source:'google_bearer',googleSubject:'fixture-subject'};
const requestOf=(service,scope=input,actor=email,proof=authorization)=>service.guard(scope,actor,proof);
const read=(service,watch=requestOf(service))=>service.hub.readOnce(watch.scope,watch.guard);
const rowFor=(w,extra={})=>({key:w.key,scope_key:w.scope_key,context_fresh:true,login_valid:true,
 class_count:1,allowed_count:1,definition_version:1,identity_count:w.student_ref?1:0,revision:'a'.repeat(32),access_revision:'c'.repeat(32),...extra});
const fixturePool=run=>({commands:[],async connect(){const pool=this;return{async query(q){pool.commands.push(typeof q==='string'?q:'metadata');return typeof q==='string'?{rows:[]}:run(q);},release(){pool.commands.push('release');}};}});

test('Teacher state: one SQL batch for overlapping readers, stable keys survive reversed rows, no content in frames',async t=>{
 const calls=[],pool=fixturePool(async query=>{const w=JSON.parse(query.values[0]);calls.push(w);return{rows:w.map(x=>rowFor(x,{revision:(x.student_ref?'b':'a').repeat(32)})).reverse()};});
 const service=createTermTeacherObservation({pool});
 t.after(()=>service.hub.close());
 const scopes=[input,input,{...input,student:ref},{...input,student:other}];
 const values=await Promise.all(scopes.map(scope=>read(service,requestOf(service,scope))));
 assert.equal(calls.length,1);assert.equal(calls[0].length,3);
 assert.deepEqual(values.map(v=>v.studentRef),[null,null,ref,other]);
 assert.equal(values[0].contentRevision,'a'.repeat(32));assert.equal(values[2].contentRevision,'b'.repeat(32));
 assert.deepEqual(Object.keys(values[0]).sort(),['kind','className','testSlug','studentRef','definitionVersion','contentRevision','accessRevision','epoch','sequence','revision'].sort());
 assert.equal(JSON.stringify(values).includes(email),false);assert.equal(service.hub.snapshot().connections,0);
 assert.deepEqual(pool.commands,['BEGIN READ ONLY','SET LOCAL jit=off',"SET LOCAL statement_timeout='4s'",'metadata','COMMIT','release']);
});

test('Teacher state: foreign, missing, duplicate or mismatched keys fail closed',async t=>{
 for(const mutate of [rows=>rows.slice(1),rows=>[rows[0],rows[0]],rows=>[...rows.slice(1),{...rows[0],key:'foreign'}],rows=>rows.map(r=>({...r,scope_key:'wrong'}))]){
  const service=createTermTeacherObservation({pool:fixturePool(async q=>({rows:mutate(JSON.parse(q.values[0]).map(x=>rowFor(x)))}))});
  t.after(()=>service.hub.close());
  const outcomes=await Promise.allSettled([read(service),read(service,requestOf(service,{...input,student:ref}))]);
  assert.ok(outcomes.every(x=>x.status==='rejected'&&x.reason.code==='STATE_DATA_INVALID'));
 }
});

test('Teacher state: revoked reader cannot poison a permitted reader sharing the same scope',async t=>{
 const service=createTermTeacherObservation({pool:fixturePool(async q=>({rows:JSON.parse(q.values[0]).map(w=>rowFor(w,w.email==='revoked@fixture.test'?{allowed_count:0,revision:'d'.repeat(32)}:{})).reverse()}))});
 t.after(()=>service.hub.close());
 const result=await Promise.allSettled([read(service),read(service,requestOf(service,input,'revoked@fixture.test'))]);
 assert.equal(result[0].status,'fulfilled');assert.equal(result[1].reason.status,403);
});

test('Teacher state: context, session, class, test and selected identity retain distinct errors',async t=>{
 for(const [change,status,code] of [
  [{context_fresh:false},503,'CONTEXT_UNAVAILABLE'],[{login_valid:false},401,'TEACHER_LOGIN_REQUIRED'],
  [{class_count:2},404,'CLASS_NOT_FOUND'],[{definition_version:null},404,'TEST_NOT_FOUND'],
  [{allowed_count:0},403,'ACCESS_DENIED'],[{identity_count:2},404,'STUDENT_NOT_FOUND']]){
  const service=createTermTeacherObservation({pool:fixturePool(async q=>({rows:JSON.parse(q.values[0]).map(w=>rowFor(w,change))}))});
  t.after(()=>service.hub.close());
  await assert.rejects(read(service,requestOf(service,{...input,student:ref})),error=>error.status===status&&error.code===code);
 }
});

test('Teacher state SQL: drafts only change the selected student revision; deletion, same-timestamp content and permissions remain visible',async t=>{
 const f=await createMiniFixture({examOrder:true,completeSchema:true});t.after(()=>f.db.close());
 const schema=await readFile(new URL('../db/001-context.sql',import.meta.url),'utf8');
 for(const name of ['reviewer_account','reviewer_class_access','reviewer_session'])await f.db.exec(schema.match(new RegExp(`CREATE TABLE mapping\\.${name} \\([\\s\\S]*?\\n\\);`))[0].replace('CREATE TABLE mapping.','CREATE TABLE IF NOT EXISTS mapping.'));
 await f.db.query("INSERT INTO mapping.reviewer_account(email,google_subject,role,status) VALUES($1,$2,'teacher','active')",[email,authorization.googleSubject]);
 await f.db.query('INSERT INTO mapping.reviewer_class_access VALUES($1,1293)',[email]);
 const service=createTermTeacherObservation({pool:f.pool});t.after(()=>service.hub.close());
 const selected=requestOf(service,{...input,student:ref}),unrelated=requestOf(service,{...input,student:other});
 const plan=(await f.pool.query('EXPLAIN (FORMAT JSON) '+teacherObservationBatchSql,[JSON.stringify([selected.guard.watched])])).rows[0]['QUERY PLAN'][0];
 t.diagnostic(JSON.stringify({estimatedTotalCost:plan.Plan['Total Cost'],jit:plan.JIT?.Options||null}));
 const initial=await read(service),selectedBefore=await read(service,selected),unrelatedBefore=await read(service,unrelated);
 const id='60000000-0000-4000-8000-000000000001';
 await f.db.query(`INSERT INTO assessment.term_test_exam_session(id,test_slug,definition_version,erp_course_class_id,class_name_snapshot,
  erp_student_contact_id,student_name_snapshot,attempt_mode,listening_draft,listening_draft_updated_at)
  VALUES($1,$2,1,1293,'IC2304',900001,'Học viên mô phỏng','cbt','{"11":"A"}','2026-11-01T00:00:00Z')`,[id,input.test]);
 const firstSelected=await read(service,selected);
 assert.notEqual(firstSelected.contentRevision,selectedBefore.contentRevision);
 assert.equal((await read(service)).contentRevision,initial.contentRevision);
 await f.db.query(`UPDATE assessment.term_test_exam_session SET listening_draft='{"11":"B"}' WHERE id=$1`,[id]);
 assert.notEqual((await read(service,selected)).contentRevision,firstSelected.contentRevision);
 assert.equal((await read(service,unrelated)).contentRevision,unrelatedBefore.contentRevision);
 assert.equal((await read(service)).contentRevision,initial.contentRevision);
 await f.db.query('DELETE FROM assessment.term_test_exam_session WHERE id=$1',[id]);
 assert.equal((await read(service,selected)).contentRevision,selectedBefore.contentRevision);
 await f.db.query('DELETE FROM mapping.reviewer_class_access WHERE reviewer_email=$1',[email]);
 await assert.rejects(read(service),error=>error.status===403);
});

test('Teacher state SQL: native session revocation, expiry, subject, current admin rights and stale context are rechecked without writes',async t=>{
 const f=await createMiniFixture({examOrder:true,completeSchema:true});t.after(()=>f.db.close());
 const schema=await readFile(new URL('../db/001-context.sql',import.meta.url),'utf8');
 for(const name of ['reviewer_account','reviewer_class_access','reviewer_session'])await f.db.exec(schema.match(new RegExp(`CREATE TABLE mapping\\.${name} \\([\\s\\S]*?\\n\\);`))[0].replace('CREATE TABLE mapping.','CREATE TABLE IF NOT EXISTS mapping.'));
 await f.db.query("INSERT INTO mapping.reviewer_account(email,google_subject,role,status) VALUES($1,$2,'admin','active')",[email,authorization.googleSubject]);
 const proof={source:'session',tokenHash:'a'.repeat(64)};
 await f.db.query(`INSERT INTO mapping.reviewer_session(token_hash,reviewer_email,google_subject,idle_expires_at,absolute_expires_at)
  VALUES(decode($1,'hex'),$2,$3,now()+interval '1 day',now()+interval '2 days')`,[proof.tokenHash,email,authorization.googleSubject]);
 const nativeSettings=[];
 const observedPool={async connect(){const client=await f.pool.connect();return{async query(q){
  if(typeof q==='object')nativeSettings.push((await client.query("SELECT current_setting('transaction_read_only') AS readonly,current_setting('jit') AS jit")).rows[0]);
  return client.query(q);
 },release:()=>client.release()};}};
 const service=createTermTeacherObservation({pool:observedPool});t.after(()=>service.hub.close());
 const watch=requestOf(service,input,email,proof);
 const snapshot=()=>f.db.query(`SELECT
  (SELECT jsonb_agg(to_jsonb(r)) FROM mapping.reviewer_account r) AS accounts,
  (SELECT jsonb_agg(to_jsonb(r)) FROM mapping.reviewer_session r) AS sessions,
  (SELECT jsonb_agg(to_jsonb(r)) FROM assessment.term_test_attempt r) AS attempts,
  (SELECT jsonb_agg(to_jsonb(r)) FROM assessment.term_test_exam_session r) AS exams`);
 const before=await snapshot(),jitBefore=(await f.pool.query('SHOW jit')).rows;
 const initial=await read(service,watch);await read(service,watch);
 assert.deepEqual((await snapshot()).rows,before.rows);assert.deepEqual((await f.pool.query('SHOW jit')).rows,jitBefore);
 assert.ok(nativeSettings.every(s=>s.readonly==='on'&&s.jit==='off'));
 await f.db.query("UPDATE mapping.reviewer_account SET role='teacher' WHERE email=$1",[email]);
 await assert.rejects(read(service,watch),e=>e.status===403);
 await f.db.query('INSERT INTO mapping.reviewer_class_access VALUES($1,1293)',[email]);const assigned=await read(service,watch);
 assert.equal(assigned.contentRevision,initial.contentRevision);assert.notEqual(assigned.accessRevision,initial.accessRevision);
 await f.db.query('UPDATE mapping.reviewer_session SET revoked_at=now() WHERE token_hash=decode($1,\'hex\')',[proof.tokenHash]);
 await assert.rejects(read(service,watch),e=>e.status===401);
 await f.db.query("UPDATE mapping.reviewer_session SET revoked_at=NULL,idle_expires_at=now()-interval '1 second'");
 await assert.rejects(read(service,watch),e=>e.status===401);
 await f.db.query("UPDATE mapping.reviewer_session SET idle_expires_at=now()+interval '1 day',absolute_expires_at=now()-interval '1 second'");
 await assert.rejects(read(service,watch),e=>e.status===401);
 await f.db.query("UPDATE mapping.reviewer_session SET absolute_expires_at=now()+interval '2 days',google_subject='changed-subject'");
 await assert.rejects(read(service,watch),e=>e.status===401);
 await f.db.query('UPDATE mapping.reviewer_session SET google_subject=$1',[authorization.googleSubject]);await read(service,watch);
 await f.db.query("UPDATE mapping.k67_context_state SET captured_at=now()-interval '121 seconds'");
 await assert.rejects(read(service,watch),e=>e.status===503&&e.code==='CONTEXT_UNAVAILABLE');
});

test('Teacher state: a failed SQL batch rolls back and releases its connection before retry',async t=>{
 let failed=true;const pool=fixturePool(async q=>{if(failed)throw Object.assign(Error('fixture query failed'),{code:'57014'});return{rows:JSON.parse(q.values[0]).map(w=>rowFor(w))};});
 const service=createTermTeacherObservation({pool});t.after(()=>service.hub.close());
 await assert.rejects(read(service),e=>e.code==='57014');assert.deepEqual(pool.commands.slice(-2),['ROLLBACK','release']);
 failed=false;await read(service);assert.deepEqual(pool.commands.slice(-2),['COMMIT','release']);
});

test('Teacher state: failed rollback discards the broken connection and a fresh connection recovers',async t=>{
 let broken=true;const released=[];
 const pool={async connect(){return{async query(q){if(broken&&(typeof q==='object'||q==='ROLLBACK'))throw Object.assign(Error('broken fixture connection'),{code:'08006'});
  return typeof q==='string'?{rows:[]}:{rows:JSON.parse(q.values[0]).map(w=>rowFor(w))};},release(discard){released.push(discard);}};}};
 const service=createTermTeacherObservation({pool});t.after(()=>service.hub.close());
 await assert.rejects(read(service),e=>e.code==='08006');assert.deepEqual(released,[true]);
 broken=false;await read(service);assert.deepEqual(released,[true,false]);
});
