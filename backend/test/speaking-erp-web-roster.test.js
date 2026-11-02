import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {pathToFileURL} from 'node:url';
const {createIndependentSource}=await import(process.env.SPEAKING_SOURCE_TEST_FILE?pathToFileURL(process.env.SPEAKING_SOURCE_TEST_FILE).href:'../src/speaking-independent-source.js');
// SQL thật trên dữ liệu giả: phân biệt quyền web ERP với ghép Google cho Docs.
test('ERP web: hai lớp pending được vào, giữ UUID/Google chờ; rời lớp/sai chủ và lớp khác bị chặn',async t=>{
 const db=new PGlite();t.after(()=>db.close());
 await db.exec(`CREATE SCHEMA mapping;CREATE SCHEMA speaking_homework;
 CREATE TABLE speaking_homework.assignment_template(assignment_code text,course_key text,active bool,page_path text,title text,parts jsonb,required_practice_count int,doctor_course_key text);
 INSERT INTO speaking_homework.assignment_template VALUES('fixture-speaking','67',true,'lesson-6.html','Fixture','[]',0,null);
 CREATE TABLE speaking_homework.class_scope(class_id bigint,class_code text,course_key text,active bool);
 CREATE TABLE mapping.classroom_course_mapping(erp_course_class_id bigint,erp_class_name_snapshot text,classroom_course_id text,status text);
 CREATE TABLE speaking_homework.doctor_exercise(id uuid,title text,exercise_url text,active bool,course_key text);
 CREATE TABLE speaking_homework.doctor_recommendation(class_id bigint,student_ref uuid,exercise_id uuid,recommendation_count int,practice_count int,waiting bool,proposed_at timestamptz,last_practiced_at timestamptz);
 CREATE TABLE mapping.student_mapping_review(public_id uuid,erp_course_class_id bigint,erp_student_contact_id bigint,erp_student_name_snapshot text,classroom_user_id text,status text);
 CREATE TABLE mapping.erp_class_membership_snapshot(erp_course_class_id bigint,erp_student_contact_id bigint,source_state text,registration_status text,erp_student_name_snapshot text);
 INSERT INTO speaking_homework.class_scope VALUES(1333,'FixtureA','67',true),(1345,'FixtureB','67',true),(1293,'FixtureOther','67',true);
 INSERT INTO mapping.classroom_course_mapping SELECT class_id,class_code,'course-'||class_id,'approved' FROM speaking_homework.class_scope;
 INSERT INTO mapping.student_mapping_review SELECT ('00000000-0000-4000-8000-'||lpad(class_id::text,12,'0'))::uuid,class_id,class_id,'Tên ERP', 'google-suggestion','pending_review' FROM speaking_homework.class_scope;
 INSERT INTO mapping.erp_class_membership_snapshot SELECT class_id,class_id,'active','on_going','Tên đúng ERP' FROM speaking_homework.class_scope;`);
 const source=createIndependentSource({pool:{query:(sql,p)=>db.query(sql,p)}});
 const input={assignmentCode:'fixture-speaking',classCode:'FixtureA',studentRef:'00000000-0000-4000-8000-000000001333'};
 const web=await source.context({...input,webEntry:true});assert.equal(web.member.student_ref,input.studentRef);assert.equal(web.member.google_user_id,null);assert.equal(web.member.name,'Tên đúng ERP');
 await assert.rejects(source.context(input),e=>e.code==='STUDENT_NOT_ACTIVE');
 const other={...input,classCode:'FixtureOther',studentRef:'00000000-0000-4000-8000-000000001293'};
 await assert.rejects(source.context({...other,webEntry:true}),e=>e.code==='STUDENT_NOT_ACTIVE');
 await assert.rejects(source.context({...input,classCode:'FixtureB',webEntry:true}),e=>e.code==='STUDENT_NOT_ACTIVE');
 for(const status of ['on_hold','dropped','completed']){await db.query('UPDATE mapping.erp_class_membership_snapshot SET registration_status=$1 WHERE erp_course_class_id=1333',[status]);await assert.rejects(source.context({...input,webEntry:true}),e=>e.code==='STUDENT_NOT_ACTIVE');}
 await db.exec("UPDATE mapping.erp_class_membership_snapshot SET registration_status='on_going',source_state='removed' WHERE erp_course_class_id=1333");await assert.rejects(source.context({...input,webEntry:true}),e=>e.code==='STUDENT_NOT_ACTIVE');
 assert.equal((await db.query('SELECT status FROM mapping.student_mapping_review WHERE erp_course_class_id=1333')).rows[0].status,'pending_review');
});
