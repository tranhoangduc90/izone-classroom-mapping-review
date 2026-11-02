import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import express from 'express';
import {createServer} from 'node:http';
import {pathToFileURL} from 'node:url';
import {createIndependentSource} from '../src/speaking-independent-source.js';
import {speakingSourceScopeKey as key,expandSpeakingSourceBatch} from '../src/speaking-source-batch.js';
import {createIndependentSourceClient} from '../src/speaking-independent-server.js';
import {createSpeakingHomeworkRouter} from '../src/speaking-homework-routes.js';
import {createSpeakingTeacherProgress} from '../src/speaking-teacher-progress.js';

const code='67-speaking-lam_ro',modern='67-speaking-fixture6';
const uuid=n=>`72000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const secret='fixture-source-secret-at-least-32-characters';
// Native excludedStudents không có ORDER BY; chỉ trường này được so như tập ID.
const comparable=value=>({...value,...(value.excludedStudents?{excludedStudents:[...value.excludedStudents]
 .sort((a,b)=>a.google_user_id.localeCompare(b.google_user_id))}:{})});
const scopes=[{assignmentCode:code,classCode:'IC2304'},{assignmentCode:code,classCode:'IC2305'},
 {assignmentCode:modern,classCode:'IC2304'},{assignmentCode:modern},
 {assignmentCode:'unknown-fixture',classCode:'IC2304'},{assignmentCode:code,classCode:'WRONG'}];
const nativeUrl=process.env.PRACTICE_FIXTURE_DATABASE_URL;
const baselineFactory=process.env.SPEAKING_SOURCE_BASE_FILE
 ?(await import(pathToFileURL(process.env.SPEAKING_SOURCE_BASE_FILE).href)).createIndependentSource:createIndependentSource;

// Cùng SQL/ca kiểm chạy trên PGlite local hoặc PostgreSQL riêng của task.
// Đường native bắt buộc host/role/database fixture; dịch vụ chỉ có quyền SELECT.
async function fixture(){
 let db,application,close;
 if(nativeUrl){
  const target=new URL(nativeUrl);
  assert.equal(process.env.PRACTICE_FIXTURE_CONFIRM,'test-services-optimization-20261101');
  assert.match(target.hostname,/^tsto-practice-pg-[a-z0-9]+$/);assert.equal(target.username,'fixture');assert.equal(target.pathname,'/postgres');
  const {default:pg}=await import('pg');const admin=new pg.Client({connectionString:target.href});await admin.connect();
  const database='speaking_source_fixture_'+randomUUID().replaceAll('-','');
  try{
   await admin.query("DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='speaking_source_fixture_api') THEN CREATE ROLE speaking_source_fixture_api LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;END IF;END $$");
   await admin.query('CREATE DATABASE '+database);target.pathname='/'+database;
   const owner=new pg.Pool({connectionString:target.href,max:2});
   target.username='speaking_source_fixture_api';application=new pg.Pool({connectionString:target.href,max:4});
   db={query:(sql,params)=>owner.query(sql,params),exec:sql=>owner.query(sql)};
   close=async()=>{await application.end();await owner.end();await admin.query('DROP DATABASE '+database);await admin.end();};
  }catch(error){await admin.end();throw error;}
 }else{
  const {PGlite}=await import('@electric-sql/pglite');db=new PGlite();application=db;close=()=>db.close();
 }
 try{
  await db.exec(`CREATE SCHEMA mapping;CREATE SCHEMA speaking_homework;
   CREATE TABLE mapping.classroom_course_mapping(erp_course_class_id bigint,erp_class_name_snapshot text,classroom_course_id text,status text);
   CREATE TABLE mapping.student_mapping_review(public_id uuid,erp_course_class_id bigint,erp_student_contact_id bigint,erp_student_name_snapshot text,classroom_user_id text,status text);
   CREATE TABLE mapping.erp_class_membership_snapshot(erp_course_class_id bigint,erp_student_contact_id bigint,source_state text,registration_status text);
   CREATE TABLE mapping.reviewer_class_access(reviewer_email text,erp_course_class_id bigint);
   CREATE TABLE mapping.reviewer_class_assignment(reviewer_email text,class_name text);
   CREATE TABLE speaking_homework.assignment_template(assignment_code text,page_path text,title text,parts jsonb,required_practice_count integer,doctor_course_key text,course_key text,active boolean);
   CREATE TABLE speaking_homework.class_scope(class_id bigint,class_code text,course_key text,active boolean);
   CREATE TABLE speaking_homework.doctor_exercise(id uuid,title text,exercise_url text,active boolean,course_key text);
   CREATE TABLE speaking_homework.doctor_recommendation(class_id bigint,student_ref uuid,exercise_id uuid,
    recommendation_count integer,practice_count integer,waiting boolean,proposed_at timestamptz,last_practiced_at timestamptz);
   CREATE TABLE speaking_homework.assignment(id uuid,class_id bigint,course_id text,assignment_code text,status text,required_practice_count integer,doctor_course_key text);
   CREATE TABLE speaking_homework.assignment_part(assignment_id uuid,part_key text,display_title text,practice_url text,min_questions integer,position integer);
   INSERT INTO mapping.classroom_course_mapping VALUES(2304,'IC2304','100','approved'),(2305,'IC2305','200','approved'),(9999,'OTHER','999','approved');
   INSERT INTO speaking_homework.class_scope VALUES(2304,'IC2304','67',true),(2305,'IC2305','67',true),(9999,'OTHER','56',true);
   INSERT INTO mapping.student_mapping_review VALUES
    ('${uuid(1)}',2304,1,'Tên trùng','google-a','approved'),('${uuid(2)}',2305,2,'Tên trùng','google-b','approved'),
    ('${uuid(3)}',2304,3,'Tên trùng',NULL,'pending_review'),('${uuid(4)}',2304,4,'Đã nghỉ','google-d','approved'),
    ('${uuid(5)}',2304,5,'Tạm dừng','google-e','approved'),('${uuid(6)}',2304,6,'Mất nguồn','google-f','approved'),
    ('${uuid(7)}',2304,7,'Trạng thái rỗng','google-g','approved'),('${uuid(8)}',2304,8,'Chưa Google',NULL,'approved');
   INSERT INTO mapping.erp_class_membership_snapshot VALUES(2304,1,'active','on_going'),(2305,2,'active','on_going'),
    (2304,3,'active','on_going'),(2304,4,'active',' dropped '),(2304,5,'active','ON_HOLD'),(2304,6,'missing','on_going'),
    (2304,7,'active',NULL),(2304,8,'active','on_going');
   INSERT INTO mapping.reviewer_class_access VALUES('teacher@fixture.test',2304);
   INSERT INTO mapping.reviewer_class_assignment VALUES('assigned@fixture.test',' ic2305 ');
   INSERT INTO speaking_homework.assignment_template VALUES
    ('${code}','lesson-3.html','Mẫu giả 3','[{"part_key":"clarify_1","min_questions":3}]',2,'67','67',true),
    ('${modern}','lesson-6.html','Mẫu giả 6','[{"part_key":"main","min_questions":0}]',0,NULL,'67',true),
    ('bad-page-fixture','lesson-1.html','Không hỗ trợ','[]',0,NULL,'67',true);
   INSERT INTO speaking_homework.assignment VALUES('${uuid(101)}',2304,'100','${code}','closed',1,NULL),('${uuid(102)}',2305,'200','${code}','open',2,'67');
   INSERT INTO speaking_homework.assignment_part VALUES('${uuid(101)}','clarify_1','Lớp A','https://fixture.invalid/a',4,1),
    ('${uuid(102)}','clarify_1','Lớp B','https://fixture.invalid/b',3,1);
   INSERT INTO speaking_homework.doctor_exercise VALUES('${uuid(201)}','Bài giả','https://fixture.invalid/doctor',true,'67');`);
  await db.exec(`INSERT INTO mapping.classroom_course_mapping VALUES(1333,'IC1333','133','approved'),(1345,'IC1345','145','approved');
   INSERT INTO speaking_homework.class_scope VALUES(1333,'IC1333','67',true),(1345,'IC1345','67',true);
   INSERT INTO mapping.student_mapping_review VALUES
    ('${uuid(20)}',1333,20,'Tên trùng','stale-unapproved-google','pending_review'),('${uuid(21)}',1333,21,'Tên trùng',NULL,'rejected'),
    ('${uuid(22)}',1333,22,'Chưa Google',NULL,'approved'),('${uuid(23)}',1333,23,'Chưa học','google-23','approved'),
    ('${uuid(24)}',1333,24,'Sai chuẩn trạng thái','google-24','approved'),('${uuid(25)}',1345,25,'Tên trùng',NULL,'pending_review');
   INSERT INTO mapping.erp_class_membership_snapshot VALUES(1333,20,'active','on_going'),(1333,21,'active','on_going'),
    (1333,22,'active','on_going'),(1333,23,'active','sign_up'),(1333,24,'active',' ON_GOING '),(1345,25,'active','on_going');`);
  await db.exec(`ALTER TABLE mapping.erp_class_membership_snapshot ADD COLUMN erp_student_name_snapshot text;
   UPDATE mapping.erp_class_membership_snapshot e SET erp_student_name_snapshot=(SELECT m.erp_student_name_snapshot
    FROM mapping.student_mapping_review m WHERE m.erp_course_class_id=e.erp_course_class_id AND m.erp_student_contact_id=e.erp_student_contact_id);
   UPDATE mapping.erp_class_membership_snapshot SET erp_student_name_snapshot='Tên Portal chuẩn 20' WHERE erp_student_contact_id=20;`);
  if(nativeUrl)await db.exec('GRANT USAGE ON SCHEMA mapping,speaking_homework TO speaking_source_fixture_api;GRANT SELECT ON ALL TABLES IN SCHEMA mapping,speaking_homework TO speaking_source_fixture_api');
  const calls=[],state={failed:false};
  const pool={async query(sql,params){calls.push(sql);if(state.failed)throw Error('SOURCE_SQL_UNAVAILABLE');return application.query(sql,params);}};
  return {db,pool,calls,state,source:createIndependentSource({pool}),baseline:baselineFactory({pool}),close};
 }catch(error){await close();throw error;}
}

async function liveApp(f,run){
 const app=express();app.use(express.json());let authentications=0;
 app.use('/speaking',createSpeakingHomeworkRouter({pool:f.pool,workerSecret:secret,accessSecret:secret,
  authenticate(req,res,next){authentications++;if(req.get('cookie')!=='teacher=fixture')return res.status(401).json({ok:false,error:'TEACHER_LOGIN_REQUIRED'});
   req.reviewer={email:'teacher@fixture.test',canAccessAllClasses:false};next();}}));
 app.use((error,_req,res,_next)=>res.status(error.httpStatus||503).json({ok:false,error:error.code||'SOURCE_SQL_UNAVAILABLE'}));
 const server=createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{await run({base:`http://127.0.0.1:${server.address().port}/speaking`,get authentications(){return authentications;}});}
 finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}

test('Speaking source batch: cùng ngữ nghĩa native, sáu SELECT dùng chung theo bài/lớp, roster theo ID',async t=>{
 const f=await fixture();try{
  const snapshot=await f.source.contexts([...scopes,...Array.from({length:100},()=>scopes[0])]);
  const batchQueries=f.calls.length;assert.equal(batchQueries,6);assert.equal(snapshot.entries.length,scopes.length);
  assert.equal(snapshot.rosters.length,2);assert.equal(snapshot.exercises.length,1);
  const result=expandSpeakingSourceBatch(scopes,snapshot);
  for(const input of scopes){
   const entry=result.get(key(input));
   if(entry.ok){
    assert.deepEqual(comparable(entry.context),comparable(await f.baseline.context(input)));
   }
   else await assert.rejects(f.baseline.context(input),error=>error.code===entry.error&&error.httpStatus===entry.status);
  }
  const a=result.get(key(scopes[0])).context,b=result.get(key(scopes[1])).context;
  assert.equal(a.template.requiredPracticeCount,1);assert.equal(a.template.assignmentStatus,'closed');assert.equal(a.template.doctorEnabled,false);
  assert.equal(b.template.parts[0].display_title,'Lớp B');assert.equal(b.students[0].student_ref,uuid(2));
  assert.deepEqual(a.students.map(row=>row.student_ref).sort(),[uuid(1),uuid(7)]);
  assert.deepEqual(a.selectionStudents.map(row=>row.student_ref).sort(),[uuid(1),uuid(3),uuid(7),uuid(8)]);
  assert.deepEqual(a.excludedStudents.map(row=>row.google_user_id).sort(),['google-d','google-e','google-f']);
  assert.ok(f.calls.every(sql=>sql.trimStart().startsWith('SELECT')));
  if(nativeUrl)await assert.rejects(f.pool.query('CREATE TABLE speaking_homework.forbidden_fixture(id integer)'),{code:'42501'});
  t.diagnostic(JSON.stringify({event:'speaking_source_batch_shape',batchQueries,scopeCount:scopes.length,duplicateWatchers:100,engine:nativeUrl?'postgresql':'pglite',writes:0}));
 }finally{await f.close();}
});

test('Speaking source batch: không giữ quyền/cấu hình qua lượt đọc, phân biệt Google và tên tự chọn',async()=>{
 const f=await fixture();try{
  const input=scopes[0],read=async()=>expandSpeakingSourceBatch([input],await f.source.contexts([input])).get(key(input)).context;
  const before=await read();
  await f.db.query("UPDATE mapping.student_mapping_review SET status='rejected',classroom_user_id=NULL WHERE public_id=$1",[uuid(1)]);
  const unapproved=await read();assert.equal(unapproved.students.some(row=>row.student_ref===uuid(1)),false);
  assert.equal(unapproved.selectionStudents.some(row=>row.student_ref===uuid(1)),true);
  await assert.rejects(f.source.context({...input,studentRef:uuid(1)}),{code:'STUDENT_NOT_ACTIVE'});
  await f.db.query("UPDATE mapping.erp_class_membership_snapshot SET source_state='missing' WHERE erp_student_contact_id=1");
  assert.equal((await read()).selectionStudents.some(row=>row.student_ref===uuid(1)),false);
  await f.db.query("UPDATE speaking_homework.assignment_part SET min_questions=8 WHERE assignment_id=$1",[uuid(101)]);
  assert.notEqual((await read()).template.digest,before.template.digest);
  await f.db.query("UPDATE mapping.classroom_course_mapping SET classroom_course_id='new-course' WHERE erp_course_class_id=2304");
  assert.equal((await read()).template.assignmentStatus,undefined);
  await f.db.query('UPDATE speaking_homework.class_scope SET active=false WHERE class_id=2304');
  const unavailable=expandSpeakingSourceBatch([input],await f.source.contexts([input])).get(key(input));
  assert.equal(unavailable.error,'CLASS_SCOPE_INVALID');assert.equal(unavailable.status,403);
 }finally{await f.close();}
});

test('Speaking source batch: lỗi một scope không trộn scope khác; lỗi SQL vẫn là lỗi, không giả quyền/roster rỗng',async()=>{
 const f=await fixture();try{
  await f.db.query(`INSERT INTO speaking_homework.assignment VALUES($1,2304,'100',$2,'open',2,'67')`,[uuid(103),code]);
  await f.db.query('UPDATE speaking_homework.assignment_part SET part_key=$1 WHERE assignment_id=$2',['wrong-part',uuid(102)]);
  const inputs=[...scopes,{assignmentCode:'bad-page-fixture'}],result=expandSpeakingSourceBatch(inputs,await f.source.contexts(inputs));
  assert.equal(result.get(key(scopes[0])).error,'ASSIGNMENT_AMBIGUOUS');assert.equal(result.get(key(scopes[1])).error,'ASSIGNMENT_CONFIGURATION_CONFLICT');
  assert.equal(result.get(key(scopes[2])).ok,true);assert.equal(result.get(key(inputs.at(-1))).error,'UNSUPPORTED_ASSIGNMENT');
  f.state.failed=true;await assert.rejects(f.source.contexts(inputs),/SOURCE_SQL_UNAVAILABLE/);
  f.state.failed=false;assert.equal(expandSpeakingSourceBatch([scopes[2]],await f.source.contexts([scopes[2]])).get(key(scopes[2])).ok,true);
 }finally{await f.close();}
});

test('Speaking source batch: giữ ERP web hai lớp đã mở, tách Docs/Google và không gộp nhầm chế độ',async()=>{
 const f=await fixture();try{
  const inputs=['IC1333','IC1345','IC2304'].flatMap(classCode=>[false,true].map(webEntry=>({assignmentCode:modern,classCode,webEntry})));
  const snapshot=await f.source.contexts(inputs),batch=expandSpeakingSourceBatch(inputs,snapshot);
  assert.equal(batch.size,6);assert.equal(snapshot.rosters.length,3);
  for(const input of inputs)assert.deepEqual(comparable(batch.get(key(input)).context),comparable(await f.baseline.context(input)));
  const web=inputs.find(input=>input.classCode==='IC1333'&&input.webEntry),doc={...web,webEntry:false};
  assert.notEqual(key(web),key(doc));
  assert.deepEqual(batch.get(key(web)).context.students.map(row=>row.student_ref).sort(),[uuid(20),uuid(22)]);
  assert.ok(batch.get(key(web)).context.students.every(row=>row.google_user_id===null));
  assert.equal(batch.get(key(web)).context.students.find(row=>row.student_ref===uuid(20)).name,'Tên Portal chuẩn 20');
  assert.equal(batch.get(key(doc)).context.selectionStudents.find(row=>row.student_ref===uuid(20)).name,'Tên Portal chuẩn 20');
  assert.equal(batch.get(key(doc)).context.students.some(row=>row.student_ref===uuid(20)),false);
  assert.equal(batch.get(key({...web,classCode:'IC2304'})).context.students.some(row=>row.student_ref===uuid(3)),false);
  assert.equal((await f.source.context({...web,studentRef:uuid(20)})).member.student_ref,uuid(20));
  await assert.rejects(f.source.context({...doc,studentRef:uuid(20)}),{code:'STUDENT_NOT_ACTIVE'});
  await liveApp(f,async server=>{
   const client=createIndependentSourceClient({base:server.base,secret});
   const [webRead,docRead]=await Promise.all([client.context(web),client.context(doc)]);
   assert.equal(webRead.students.some(row=>row.student_ref===uuid(20)),true);assert.equal(docRead.students.some(row=>row.student_ref===uuid(20)),false);
   const actual=await client.contexts([doc,web]);assert.equal(actual.get(key(web)).context.students.some(row=>row.student_ref===uuid(20)),true);
  });
  await f.db.query("UPDATE mapping.erp_class_membership_snapshot SET registration_status='on_hold' WHERE erp_student_contact_id=20");
  const next=expandSpeakingSourceBatch([web],await f.source.contexts([web]));
  assert.equal(next.get(key(web)).context.students.some(row=>row.student_ref===uuid(20)),false);
  await assert.rejects(f.source.context({...web,studentRef:uuid(20)}),{code:'STUDENT_NOT_ACTIVE'});
  const malformed=structuredClone(snapshot);const entry=malformed.entries.find(row=>row.key===key(web));entry.webEntry=false;
  assert.throws(()=>expandSpeakingSourceBatch(inputs,malformed),{code:'SOURCE_BATCH_INVALID'});
 }finally{await f.close();}
});

test('Speaking teacher batch: cùng quyền native từng lớp, phân công tên lớp và thu hồi; không biến phiên hợp lệ thành quyền toàn khóa',async()=>{
 const f=await fixture();try{
  const classIds=['2305','2304','9999','unlinked','2304'];
  for(const email of ['teacher@fixture.test','assigned@fixture.test','unknown@fixture.test']){
   const reviewer={email,canAccessAllClasses:false},allowed=await f.source.teachers({classIds,reviewer});
   const expected=[];for(const classId of new Set(classIds))if(await f.baseline.teacher({classId,reviewer}))expected.push(classId);
   assert.deepEqual(allowed,expected);
  }
  const reviewer={email:'teacher@fixture.test',canAccessAllClasses:false};
  await f.db.query('DELETE FROM mapping.reviewer_class_access');assert.deepEqual(await f.source.teachers({classIds,reviewer}),[]);
  assert.deepEqual(await f.source.teachers({classIds,reviewer:{canAccessAllClasses:true}}),[...new Set(classIds)]);
  await f.db.query("INSERT INTO mapping.classroom_course_mapping VALUES(2305,'IC2305','201','approved')");
  assert.equal(await f.source.teacher({classId:'2305',reviewer:{email:'assigned@fixture.test'}}),false);
  assert.deepEqual(await f.source.teachers({classIds:['2305'],reviewer:{email:'assigned@fixture.test'}}),[]);
  assert.ok(f.calls.every(sql=>sql.trimStart().startsWith('SELECT')));
 }finally{await f.close();}
});

test('Speaking source HTTP: khóa nội bộ, Google và schema giữ riêng; bộ nối/class picker kiểm quyền một lần theo nhóm',async()=>{
 const f=await fixture();try{await liveApp(f,async server=>{
  const source=createIndependentSourceClient({base:server.base,secret});
  const contexts=await source.contexts(scopes);assert.equal(contexts.size,scopes.length);assert.equal(server.authentications,0);
  const teacher=createSpeakingTeacherProgress({pool:f.pool,source});
  const classes=await teacher.classes({assignmentCode:code},{cookie:'teacher=fixture'});
  assert.deepEqual(classes.classes,[{classId:'2304',classCode:'IC2304'}]);assert.equal(server.authentications,1);
  await f.db.query('DELETE FROM mapping.reviewer_class_access');
  await assert.rejects(teacher.classes({assignmentCode:code},{cookie:'teacher=fixture'}),{code:'TEACHER_ACCESS_DENIED'});
  assert.equal(server.authentications,2);
  const reads=f.calls.length;
  for(const [path,body,headers,status] of [
   ['contexts',{scopes:[scopes[0]]},{},401],
   ['teacher-access',{classIds:['2304']},{cookie:'teacher=fixture'},401],
   ['teacher-access',{classIds:['2304']},{'x-speaking-worker-secret':secret},401],
   ['contexts',{scopes:[{...scopes[0],studentRef:uuid(1)}]},{'x-speaking-worker-secret':secret},400],
   ['teacher-access',{classIds:['2304 OR true']},{cookie:'teacher=fixture','x-speaking-worker-secret':secret},400],
   ['contexts',{scopes:Array.from({length:1001},()=>scopes[0])},{'x-speaking-worker-secret':secret},400]
  ]){
   const response=await fetch(server.base+'/internal/independent/'+path,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
   assert.equal(response.status,status);
  }
  assert.equal(f.calls.length,reads);
 });}finally{await f.close();}
});

test('Speaking source batch protocol: reorder theo khóa; thiếu/trùng/lạc nguồn không thể đổi chủ',async()=>{
 const f=await fixture();try{
  const inputs=scopes.slice(0,3),batch=await f.source.contexts(inputs),copy=()=>structuredClone(batch);
  const reordered=copy();reordered.entries.reverse();reordered.rosters.reverse();
  assert.equal(expandSpeakingSourceBatch(inputs,reordered).get(key(inputs[0])).context.scope.class_code,'IC2304');
  for(const mutate of [b=>b.entries.pop(),b=>{b.entries[1]=b.entries[0];},b=>{b.entries[0].key=key({assignmentCode:code,classCode:'OTHER'});},
   b=>{b.entries[0].scope=b.entries[1].scope;},b=>{b.entries[0].template.assignmentCode='other-code';},
   b=>b.rosters.push(b.rosters[0]),b=>{b.entries[0]={...b.entries[0],ok:false,error:'BAD',status:503};}]){
   const malformed=copy();mutate(malformed);assert.throws(()=>expandSpeakingSourceBatch(inputs,malformed),{code:'SOURCE_BATCH_INVALID'});
  }
  for(const bad of [[{...inputs[0],studentRef:uuid(1)}],[{assignmentCode:'x'}],[{assignmentCode:code,classCode:''}],Array.from({length:1001},()=>inputs[0])])
   await assert.rejects(f.source.contexts(bad),{code:'SOURCE_BATCH_INVALID'});
  const before=f.calls.length;assert.deepEqual(await f.source.contexts([]),{classes:[],exercises:[],rosters:[],entries:[]});assert.equal(f.calls.length,before);
 }finally{await f.close();}
});

test('Speaking source client: tương thích nguồn cũ chỉ khi batch 404/405; quyền/lỗi thật không được fallback',async()=>{
 for(const status of [404,405,401,403,503]){
  const calls=[];let active=0,maxActive=0;
  const source=createIndependentSourceClient({base:'https://source.fixture/speaking',secret,call:async(url,options)=>{
   calls.push({url,options});const target=new URL(url);
   assert.equal(target.search,'');assert.equal(target.href.includes('teacher=fixture'),false);
   assert.equal(options.headers.cookie,'teacher=fixture');assert.equal(options.headers['x-speaking-worker-secret'],secret);
   if(options.method==='POST')return {ok:false,status,json:async()=>{if(status===404)throw SyntaxError('old HTML route');return{ok:false,error:'SOURCE_ERROR'};}};
   active++;maxActive=Math.max(maxActive,active);await new Promise(resolve=>setTimeout(resolve,2));active--;
   return {ok:true,status:200,json:async()=>({ok:true,allowed:target.pathname.endsWith('/2304')})};
  }});
  const ids=Array.from({length:20},(_,i)=>String(2304+i));
  if([404,405].includes(status)){
   assert.deepEqual([...(await source.teachers(ids,{cookie:'teacher=fixture'}))],['2304']);assert.equal(calls.length,21);assert.ok(maxActive<=6);
  }else{await assert.rejects(source.teachers(ids,{cookie:'teacher=fixture'}),error=>error.httpStatus===status);assert.equal(calls.length,1);}
 }
 for(const allowed of [['9999'],['2304','2304'],true,[2304]]){
  const source=createIndependentSourceClient({base:'https://source.fixture/speaking',secret,call:async()=>({ok:true,status:200,json:async()=>({ok:true,allowed})})});
  await assert.rejects(source.teachers(['2304'],{}),{code:'SOURCE_BATCH_INVALID'});
 }
});

test('Speaking source batch benchmark: 100 lượt cùng scope native so với một nhóm, không tăng số SELECT theo watcher',async t=>{
 const f=await fixture();try{
  for(let index=0;index<100;index++)await f.baseline.context(scopes[0]);
  const baseline=f.calls.length;f.calls.length=0;
  const snapshot=await f.source.contexts(Array.from({length:100},()=>scopes[0]));
  assert.equal(baseline,800);assert.equal(f.calls.length,6);assert.equal(snapshot.entries.length,1);
  t.diagnostic(JSON.stringify({event:'speaking_source_batch_benchmark',readers:100,baselineSql:baseline,batchSql:f.calls.length,
   engine:nativeUrl?'postgresql':'pglite',baseline:process.env.SPEAKING_SOURCE_BASE_FILE?'exact captured source':'native context in candidate',
   scope:'source class context only; not UI/save/CPU/capacity',productionMutations:0}));
 }finally{await f.close();}
});
