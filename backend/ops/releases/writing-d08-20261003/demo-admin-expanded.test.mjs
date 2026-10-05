// Dữ liệu giả: tài khoản, lớp, phiên và điểm; auth/HTTP/SQL demo nguyên bản chạy trên PostgreSQL RAM.
// Chỉ Google xác thực bên ngoài được thay bằng payload giả; session/hash/quyền và query là code thật.
// Mỗi case đọc đúng đích và giữ bài/điểm ngoài đích; failure giữ nguyên, không ghi production.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {readFile} from 'node:fs/promises';
import request from 'supertest';
import {PGlite} from '@electric-sql/pglite';
import {createApp} from '../src/app.js';
import {loadConfig} from '../src/config.js';
import {resolveDeploymentProfile} from '../src/deployment-profile.js';
import {listTermTestTeacherOptionsLegacySql} from '../src/sql.js';
const flags=JSON.parse(await readFile(new URL('./demo-auth-flags-current-readonly.json',import.meta.url),'utf8'));
const origin='https://tranhoangduc90.github.io';
const identities={teacher:{email:'teacher@example.test',sub:'teacher-subject'},admin:{email:'admin@example.test',sub:'admin-subject'},adminFlagOff:{email:'admin-off@example.test',sub:'admin-off-subject'},outsider:{email:'outsider@example.test',sub:'outsider-subject'},blocked:{email:'blocked@example.test',sub:'blocked-subject'}};
const credential=key=>'fixture-google-credential-'+key;
const demoRef='00000000-0000-4000-8000-000000000901',otherRef='00000000-0000-4000-8000-000000000902';
const attempt='00000000-0000-4000-8000-000000000911',otherAttempt='00000000-0000-4000-8000-000000000912';
async function setup(){
 const database=new PGlite();
 await database.exec(`CREATE SCHEMA mapping;CREATE SCHEMA assessment;
 CREATE TABLE mapping.reviewer_account(email TEXT PRIMARY KEY,display_name TEXT,role TEXT,can_access_all_classes BOOLEAN DEFAULT false,status TEXT DEFAULT 'active',google_subject TEXT,last_login_at TIMESTAMPTZ,updated_at TIMESTAMPTZ);
 CREATE TABLE mapping.reviewer_session(token_hash BYTEA PRIMARY KEY,reviewer_email TEXT,google_subject TEXT,last_seen_at TIMESTAMPTZ,idle_expires_at TIMESTAMPTZ,absolute_expires_at TIMESTAMPTZ,revoked_at TIMESTAMPTZ,revoked_reason TEXT);
 CREATE TABLE mapping.classroom_course_mapping(erp_course_class_id BIGINT PRIMARY KEY,erp_class_name_snapshot TEXT);
 CREATE TABLE mapping.reviewer_class_access(reviewer_email TEXT,erp_course_class_id BIGINT,portal_teacher_contact_id BIGINT,class_started_at TIMESTAMPTZ,class_ended_at TIMESTAMPTZ,class_status_snapshot TEXT);
 CREATE TABLE mapping.student_mapping_review(public_id UUID,erp_course_class_id BIGINT,erp_student_contact_id BIGINT,erp_student_name_snapshot TEXT,status TEXT);
 CREATE TABLE assessment.test_definition(slug TEXT PRIMARY KEY,title TEXT,version INTEGER,is_active BOOLEAN);
 CREATE TABLE assessment.term_test_roster(test_slug TEXT,erp_course_class_id BIGINT,erp_student_contact_id BIGINT,student_ref UUID,student_name_snapshot TEXT);
 CREATE TABLE assessment.term_test_temporary_student(test_slug TEXT,erp_course_class_id BIGINT,temporary_student_id BIGINT,student_ref UUID,student_name_snapshot TEXT,active BOOLEAN);
 CREATE TABLE assessment.mini_test_result(id UUID,test_slug TEXT,erp_course_class_id BIGINT,erp_student_contact_id BIGINT,student_name_snapshot TEXT,updated_at TIMESTAMPTZ,result JSONB,created_at TIMESTAMPTZ);
 CREATE TABLE assessment.term_test_attempt(id UUID,test_slug TEXT,erp_course_class_id BIGINT,erp_student_contact_id BIGINT,completed_at TIMESTAMPTZ,combined_result JSONB,writing_submitted_at TIMESTAMPTZ,created_at TIMESTAMPTZ);
 CREATE TABLE assessment.term_test_writing_grading_final(attempt_id UUID,status TEXT,task_1_score NUMERIC,task_2_score NUMERIC,writing_score NUMERIC);
 CREATE TABLE assessment.term_test_writing_grading_run(attempt_id UUID,task_number SMALLINT,status TEXT,result_json JSONB,grading_version INTEGER,updated_at TIMESTAMPTZ);
 INSERT INTO mapping.classroom_course_mapping VALUES(-56,'CODEXDEMO56'),(-57,'OTHER_SYNTHETIC_CLASS');
 INSERT INTO mapping.reviewer_class_access VALUES('teacher@example.test',-56,100,now(),NULL,'on_going');
 INSERT INTO assessment.test_definition VALUES('term-test-1-k56','Synthetic Term',1,true),('inactive-fixture','Inactive',1,false);
 `);
 for(const [key,id] of Object.entries(identities))await database.query('INSERT INTO mapping.reviewer_account(email,display_name,role,can_access_all_classes,status) VALUES($1,$2,$3,$4,$5)',[id.email,key,key.startsWith('admin')?'admin':'teacher',key==='admin',key==='blocked'?'disabled':'active']);
 for(const [ref,student,token,score] of [[demoRef,-901,attempt,6.5],[otherRef,-902,otherAttempt,8]]){
  await database.query("INSERT INTO assessment.term_test_roster VALUES('term-test-1-k56',-56,$1,$2,'Same synthetic name')",[student,ref]);
  await database.query("INSERT INTO assessment.term_test_attempt VALUES($1,'term-test-1-k56',-56,$2,now(),$3,now(),now())",[token,student,JSON.stringify({listening:{band:score},reading:{band:score}})]);
  await database.query("INSERT INTO assessment.term_test_writing_grading_final VALUES($1,'ready',NULL,$2,$2)",[token,score]);
  await database.query("INSERT INTO assessment.term_test_writing_grading_run VALUES($1,2,'complete',$2,1,now())",[token,JSON.stringify({report:'Report for '+ref,taskScore:score})]);
 }
 const calls=[];
 // Chuẩn hóa rowCount của driver PGlite; mỗi query vẫn chạy SQL thật, không giả kết quả.
 const pool={async query(sql,params=[]){calls.push({sql,params});const value=await database.query(sql,params);return {...value,rowCount:value.rows.length||value.affectedRows||0};}};
 const config=loadConfig({NODE_ENV:'test',DEPLOYMENT_PROFILE:'k56-demo',DATABASE_URL:'postgresql://fixture@demo.invalid/izone_mapping_demo',AUTH_MODE:'google',GOOGLE_CLIENT_ID:'fixture-only.apps.googleusercontent.com',ALLOWED_ORIGINS:origin,TEACHER_SESSION_COOKIE_PATH:'/mapping-api-demo',TEACHER_SESSION_COOKIE_SECURE:'true',TEACHER_SESSION_COOKIE_PARTITIONED:'true',TEACHER_SESSION_COOKIE_SAME_SITE:'none',TEACHER_SESSION_IDLE_DAYS:'90',TEACHER_SESSION_ABSOLUTE_DAYS:'365'});
 let external=0;
 const app=createApp({config,pool,verifyGoogleToken:async token=>{const key=Object.keys(identities).find(k=>credential(k)===token);if(!key)throw Error('invalid synthetic token');return {...identities[key],email_verified:true};},fetchImpl(){external++;throw Error('external request forbidden');}});
 return {database,pool,app,calls,config,external:()=>external};
}
async function login(ctx,key){const response=await request(ctx.app).post('/api/auth/session').set('Origin',origin).send({credential:credential(key)});assert.equal(response.status,201,response.body.error);const header=response.headers['set-cookie'][0];assert.match(header,/Path=\/mapping-api-demo;/);assert.match(header,/HttpOnly/);assert.match(header,/Secure/);assert.match(header,/Partitioned/);assert.match(header,/SameSite=None/);return {cookie:header.split(';',1)[0],reviewer:response.body.reviewer};}
const get=(ctx,url,cookie)=>request(ctx.app).get(url).set('Origin',origin).set('Cookie',cookie);
test('authenticated teacher: phiên thật/SQL legacy 2 tham số trả đúng lớp được giao, không metadata giả',async()=>{
 const ctx=await setup();try{
  const signed=await login(ctx,'teacher');assert.equal(signed.reviewer.canAccessAllClasses,false);
  const response=await get(ctx,'/api/term-tests/teacher/options',signed.cookie);assert.equal(response.status,200);
  assert.deepEqual(response.body.classes.map(x=>({id:x.id,name:x.name})),[{id:'-56',name:'CODEXDEMO56'}]);
  assert.deepEqual(response.body.tests.map(x=>x.slug),['term-test-1-k56']);
  const call=ctx.calls.find(x=>x.sql===listTermTestTeacherOptionsLegacySql);assert.deepEqual(call.params,[identities.teacher.email,false]);assert.equal(resolveDeploymentProfile('k56-demo').teacherOptionsMode,'legacy-access');
  const direct=await ctx.pool.query(listTermTestTeacherOptionsLegacySql,[identities.teacher.email,false]);assert.deepEqual(direct.rows[0].response.classes,response.body.classes);
  assert.equal(ctx.external(),0);
 }finally{await ctx.database.close();}
});
test('authenticated admin flagtrue: options/results cho toàn bộ lớp, giữ điểm và studentRef đúng',async()=>{
 const ctx=await setup();try{
  const signed=await login(ctx,'admin');assert.equal(signed.reviewer.role,'admin');assert.equal(signed.reviewer.canAccessAllClasses,true);
  const options=await get(ctx,'/api/term-tests/teacher/options',signed.cookie);assert.equal(options.status,200);assert.deepEqual(options.body.classes.map(x=>x.name),['CODEXDEMO56','OTHER_SYNTHETIC_CLASS']);
  const response=await get(ctx,'/api/term-tests/teacher/results?class=CODEXDEMO56&test=term-test-1-k56',signed.cookie);assert.equal(response.status,200,response.body.error);
  const students=response.body.students??response.body.items;assert.ok(Array.isArray(students));assert.equal(students.length,2);
  assert.deepEqual(students.map(s=>[s.ref,s.result.reading.band,s.writing.writingScore]).sort(),[[demoRef,6.5,6.5],[otherRef,8,8]].sort());
  assert.equal(ctx.external(),0);
 }finally{await ctx.database.close();}
});
test('teacher sai lớp/outsider bị403 hoặc danh sách rỗng; không lẫn student cùng tên',async()=>{
 const ctx=await setup();try{
  const teacher=await login(ctx,'teacher'),outsider=await login(ctx,'outsider');
  const forbidden=await get(ctx,'/api/term-tests/teacher/results?class=OTHER_SYNTHETIC_CLASS&test=term-test-1-k56',teacher.cookie);assert.equal(forbidden.status,403);
  const empty=await get(ctx,'/api/term-tests/teacher/options',outsider.cookie);assert.equal(empty.status,200);assert.deepEqual(empty.body.classes,[]);
  const denied=await get(ctx,'/api/term-tests/teacher/results?class=CODEXDEMO56&test=term-test-1-k56',outsider.cookie);assert.equal(denied.status,403);assert.equal(denied.body.students,undefined);
  const valid=await get(ctx,'/api/term-tests/teacher/results?class=CODEXDEMO56&test=term-test-1-k56',teacher.cookie);assert.equal(valid.status,200);assert.equal(valid.body.students.length,2);assert.equal(ctx.external(),0);
 }finally{await ctx.database.close();}
});
test('session identity: lưu hash, sai subject/cookie/account dừng trước đọc roster',async()=>{
 const ctx=await setup();try{
  const signed=await login(ctx,'teacher');const raw=decodeURIComponent(signed.cookie.split('=')[1]);assert.equal(raw.length,43);
  const saved=(await ctx.database.query('SELECT token_hash,reviewer_email,google_subject FROM mapping.reviewer_session')).rows;
  assert.equal(saved.length,1);assert.equal(Buffer.from(saved[0].token_hash).toString('hex'),crypto.createHash('sha256').update(raw).digest('hex'));assert.equal(saved[0].google_subject,identities.teacher.sub);
  assert.equal(ctx.calls.some(x=>x.params.some(p=>p===raw||p===credential('teacher'))),false);
  const fake=await get(ctx,'/api/term-tests/teacher/options','izone_teacher_session='+'x'.repeat(43));assert.equal(fake.status,401);
  const blocked=await request(ctx.app).post('/api/auth/session').set('Origin',origin).send({credential:credential('blocked')});assert.equal(blocked.status,403);
  await ctx.database.query("UPDATE mapping.reviewer_account SET google_subject='different-subject' WHERE email=$1",[identities.teacher.email]);
  const wrong=await get(ctx,'/api/term-tests/teacher/options',signed.cookie);assert.equal(wrong.status,401);assert.equal(ctx.external(),0);
 }finally{await ctx.database.close();}
});
test('logout/expiry: CSRFchặn, thu hồi thật, không làm đổi điểm/bài của outsider',async()=>{
 const ctx=await setup();try{
  const before=(await ctx.database.query('SELECT * FROM assessment.term_test_attempt ORDER BY id')).rows;
  const signed=await login(ctx,'teacher');const rejected=await request(ctx.app).delete('/api/auth/session').set('Origin',origin).set('Cookie',signed.cookie);assert.equal(rejected.status,403);
  assert.equal((await get(ctx,'/api/auth/session',signed.cookie)).status,200);
  const logout=await request(ctx.app).delete('/api/auth/session').set('Origin',origin).set('x-izone-csrf','1').set('Cookie',signed.cookie);assert.equal(logout.status,200);
  assert.equal((await get(ctx,'/api/term-tests/teacher/options',signed.cookie)).status,401);
  const admin=await login(ctx,'admin');await ctx.database.query("UPDATE mapping.reviewer_session SET idle_expires_at=now()-interval '1 second' WHERE reviewer_email=$1",[identities.admin.email]);assert.equal((await get(ctx,'/api/term-tests/teacher/options',admin.cookie)).status,401);
  assert.deepEqual((await ctx.database.query('SELECT * FROM assessment.term_test_attempt ORDER BY id')).rows,before);assert.equal(ctx.external(),0);
 }finally{await ctx.database.close();}
});
test('actual config flag receipt: Google/profile/cookie tương ứng loadConfig thật',async()=>{
 const ctx=await setup();try{const actual=flags.flags;for(const key of ['authMode','teacherSessionIdleDays','teacherSessionAbsoluteDays','teacherSessionCookieName','teacherSessionCookiePath','teacherSessionCookieSecure','teacherSessionCookiePartitioned','teacherSessionCookieSameSite'])assert.equal(ctx.config[key],actual[key],key);assert.equal(ctx.config.demoIsolatedMode,true);assert.equal(ctx.config.erpSyncUrl,'');}finally{await ctx.database.close();}
});
// Giữ kỳ vọng business mới từ historicalsuite. Nếu đỏ trên cảbase/head, đây là gap thật,
// không đổi assert sang hành vi source hiện tại hoặc gọi là fixture đã được thay thế.
test('REPLACEMENT-ADMIN: roleadmin flagfalse vẫn phải có quyền toàn bộ lớp theo assertion đã giữ',async()=>{
 const ctx=await setup();try{const signed=await login(ctx,'adminFlagOff');assert.equal(signed.reviewer.role,'admin');assert.equal(signed.reviewer.canAccessAllClasses,true);}finally{await ctx.database.close();}
});
test('REPLACEMENT-METADATA: admin options phải trả accessMode/isAssignedTeacher theo assertion đã giữ',async()=>{
 const ctx=await setup();try{const signed=await login(ctx,'admin');const response=await get(ctx,'/api/term-tests/teacher/options',signed.cookie);assert.equal(response.status,200);const item=response.body.classes.find(x=>x.name==='OTHER_SYNTHETIC_CLASS');assert.ok(item);assert.deepEqual({accessMode:item.accessMode,isAssignedTeacher:item.isAssignedTeacher},{accessMode:'admin_override',isAssignedTeacher:false});}finally{await ctx.database.close();}
});

// Phiên đã mở phải đọc lại role hiện hành; chỉ admin hoặc cờ rõ ràng được xem toàn lớp.
test('admin cờ tắt: Google và cookie đều trả toàn lớp cùng nhãn quyền',async()=>{
 const ctx=await setup();try{
  const signed=await login(ctx,'adminFlagOff');
  const session=await get(ctx,'/api/auth/session',signed.cookie);
  assert.equal(session.status,200);assert.equal(session.body.reviewer.canAccessAllClasses,true);
  const options=await get(ctx,'/api/term-tests/teacher/options',signed.cookie);
  assert.equal(options.status,200);
  assert.deepEqual(options.body.classes.map(x=>[x.name,x.accessMode,x.isAssignedTeacher]),[
   ['CODEXDEMO56','admin_override',false],['OTHER_SYNTHETIC_CLASS','admin_override',false]]);
  assert.equal(ctx.external(),0);
 }finally{await ctx.database.close();}
});
test('admin được phân công: lớp được giao mang nhãn giáo viên, lớp khác mang nhãn quản trị',async()=>{
 const ctx=await setup();try{
  await ctx.database.query('INSERT INTO mapping.reviewer_class_access VALUES($1,-56,101,now(),NULL,$2)',[identities.admin.email,'on_going']);
  const signed=await login(ctx,'admin');const response=await get(ctx,'/api/term-tests/teacher/options',signed.cookie);
  assert.deepEqual(response.body.classes.map(x=>[x.name,x.accessMode,x.isAssignedTeacher]),[
   ['CODEXDEMO56','assigned_teacher',true],['OTHER_SYNTHETIC_CLASS','admin_override',false]]);
  assert.equal(ctx.external(),0);
 }finally{await ctx.database.close();}
});
test('giáo viên giữ phạm vi; cờ toàn lớp rõ ràng vẫn hoạt động và thu hồi được trong phiên',async()=>{
 const ctx=await setup();try{
  const signed=await login(ctx,'teacher');
  let response=await get(ctx,'/api/term-tests/teacher/options',signed.cookie);
  assert.deepEqual(response.body.classes.map(x=>[x.name,x.accessMode,x.isAssignedTeacher]),[['CODEXDEMO56','assigned_teacher',true]]);
  await ctx.database.query('UPDATE mapping.reviewer_account SET can_access_all_classes=true WHERE email=$1',[identities.teacher.email]);
  response=await get(ctx,'/api/term-tests/teacher/options',signed.cookie);
  assert.deepEqual(response.body.classes.map(x=>[x.name,x.accessMode,x.isAssignedTeacher]),[
   ['CODEXDEMO56','assigned_teacher',true],['OTHER_SYNTHETIC_CLASS','admin_override',false]]);
  await ctx.database.query('UPDATE mapping.reviewer_account SET can_access_all_classes=false WHERE email=$1',[identities.teacher.email]);
  response=await get(ctx,'/api/term-tests/teacher/options',signed.cookie);assert.equal(response.body.classes.length,1);
  await ctx.database.query("UPDATE mapping.reviewer_account SET status='disabled' WHERE email=$1",[identities.teacher.email]);
  assert.equal((await get(ctx,'/api/term-tests/teacher/options',signed.cookie)).status,401);
  assert.equal(ctx.external(),0);
 }finally{await ctx.database.close();}
});
