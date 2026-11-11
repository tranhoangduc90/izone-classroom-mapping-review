import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import request from 'supertest';
import {PGlite} from '@electric-sql/pglite';
import {createAuthService} from '../src/auth.js';
import {createLearningRouter} from '../src/learning-routes.js';
import {createLearningClassPolicy} from '../src/learning-class-policy.js';

const id = n => '59000000-0000-4000-8000-' + String(n).padStart(12,'0');
const assignment=id(1), version=id(2), choice=id(3), open=id(4);
const path='/api/learning/teacher/assignments/'+assignment+'/question-analytics';
const definition={formVersionId:version,blocks:[{items:[
  {itemVersionId:choice,position:2,interactionType:'single_choice',graderType:'exact_option',maxScore:1,required:true,
    options:[{id:'A',label:'Phương án A'},{id:'B',label:'Phương án B'}]},
  {itemVersionId:open,position:1,interactionType:'long_text',graderType:'none',maxScore:0}
]}]};
const schema=`
  CREATE SCHEMA mapping;
  CREATE SCHEMA learning;
  CREATE TABLE mapping.reviewer_account(email text PRIMARY KEY,display_name text,role text,status text,
    can_access_all_classes boolean,google_subject text,last_login_at timestamptz,updated_at timestamptz);
  CREATE TABLE mapping.reviewer_session(token_hash bytea PRIMARY KEY,reviewer_email text,google_subject text,
    idle_expires_at timestamptz,absolute_expires_at timestamptz,last_seen_at timestamptz,revoked_at timestamptz);
  CREATE TABLE mapping.reviewer_class_access(reviewer_email text,erp_course_class_id bigint);
  CREATE TABLE mapping.reviewer_class_assignment(reviewer_email text,class_name text);
  CREATE TABLE mapping.classroom_course_mapping(erp_class_name_snapshot text,erp_course_class_id bigint);
  CREATE TABLE learning.progress_log_admin(reviewer_email text,status text);
  CREATE TABLE learning.progress_log_course_viewer(reviewer_email text,course_id bigint);
  CREATE TABLE learning.form_assignment(id uuid PRIMARY KEY,erp_course_class_id bigint,class_name_snapshot text,
    session_number integer,form_version_id uuid,status text);
  CREATE TABLE learning.form_version(id uuid PRIMARY KEY,public_definition jsonb);
  CREATE TABLE learning.form_grading_key(form_version_id uuid,private_definition jsonb);
  CREATE TABLE learning.assignment_student_status(assignment_id uuid,student_ref uuid,student_name_snapshot text,
    display_discriminator text,submission_id uuid);
  CREATE TABLE learning.submission(id uuid,assignment_id uuid,form_version_id uuid,student_ref uuid,
    response_payload jsonb,grading_status text);
  CREATE TABLE learning.response_item(submission_id uuid,item_version_id uuid,answer_state text);
  CREATE TABLE learning.grading_run(id uuid,submission_id uuid,status text,completed_at timestamptz,created_at timestamptz);
  CREATE TABLE learning.grading_result_item(grading_run_id uuid,item_version_id uuid,verdict text);
  CREATE TABLE learning.evidence_event(erp_course_class_id bigint,session_number int,visibility text,source_system text);
  CREATE TABLE learning.periodic_report(erp_course_class_id bigint,to_session_number int,status text);
  INSERT INTO mapping.reviewer_account(email,display_name,role,status,can_access_all_classes)
    VALUES ('assigned@example.test','Giảng viên lớp','teacher','active',false),
           ('outside@example.test','Giảng viên lớp khác','teacher','active',false);
  INSERT INTO mapping.reviewer_class_access VALUES ('assigned@example.test',1294), ('outside@example.test',1295);
`;

test('590: phiên giảng viên lớp thấy chi tiết khớp tổng, phiên giảng viên lớp khác bị từ chối trước khi đọc bài', async t=>{
  const db=new PGlite();
  t.after(()=>db.close());
  await db.exec(schema);
  await db.query("INSERT INTO learning.form_assignment VALUES($1,1294,'IC2305',11,$2,'published')",[assignment,version]);
  await db.query('INSERT INTO learning.form_version VALUES($1,$2)',[version,JSON.stringify(definition)]);
  for(const [i,value,verdict] of [[0,'A','incorrect'],[1,'B','correct'],[2,null,'incorrect'],[3,'B','pending']]){
    const student=id(10+i),submission=id(20+i),grade=id(30+i);
    await db.query("INSERT INTO learning.assignment_student_status VALUES($1,$2,'Học viên giả','',$3)",[assignment,student,submission]);
    await db.query('INSERT INTO learning.submission VALUES($1,$2,$3,$4,$5,$6)',
      [submission,assignment,version,student,JSON.stringify({[choice]:value,[open]:'Bài mở giả '+i}),verdict==='pending'?'pending':'complete']);
    await db.query('INSERT INTO learning.response_item VALUES($1,$2,$3),($1,$4,$5)',[submission,choice,value?'answered':'blank',open,'answered']);
    if(verdict!=='pending'){
      await db.query("INSERT INTO learning.grading_run VALUES($1,$2,'complete',now()-interval '1 hour',now()-interval '2 hours'),($3,$2,'processing',NULL,now())",
        [grade,submission,id(40+i)]);
      await db.query('INSERT INTO learning.grading_result_item VALUES($1,$2,$3)',[grade,choice,verdict]);
    }
  }
  let attemptedRead=0;
  const pool={async query(sql,params){
    if(sql.includes('response_payload'))attemptedRead++;
    const result=await db.query(sql,params);
    return {...result,rowCount:result.rows.length};
  }};
  const auth=createAuthService({config:{nodeEnv:'test',authMode:'google',teacherSessionCookiePath:'/',allowedOrigins:new Set()},
    pool,verifyGoogleToken:async credential=>{
      const user=credential.includes('outside')?'outside':'assigned';
      return {email:user+'@example.test',sub:user+'-google',email_verified:true};
    }});
  const app=express();
  app.use(express.json());
  app.post('/login',auth.login);
  app.use('/api/learning',createLearningRouter({pool,authenticate:auth.authenticate,classPolicy:createLearningClassPolicy({pool})}));
  async function login(user){
    const res=await request(app).post('/login').send({credential:'fixture-google-session-'+user});
    assert.equal(res.status,201);
    assert.equal(res.body.reviewer.canAccessAllClasses,false);
    return res.headers['set-cookie'][0].split(';',1)[0];
  }
  const own=await login('assigned');
  const summary=await request(app).get(path+'?view=summary').set('Cookie',own);
  assert.equal(summary.status,200,JSON.stringify(summary.body));
  assert.ok(summary.body.analytics.items.every(item=>!('students' in item)));
  assert.doesNotMatch(summary.text,/Bài mở giả|Học viên giả/);
  const scored=await request(app).get(path+'/'+choice+'/responses').set('Cookie',own);
  assert.equal(scored.status,200,JSON.stringify(scored.body));
  assert.equal(scored.headers['cache-control'],'no-store');
  const detail=scored.body.detail;
  const expected=summary.body.analytics.items.find(item=>item.itemVersionId===choice);
  assert.equal(detail.responseVersion,expected.responseVersion);
  assert.deepEqual(detail.counts,expected.counts);
  assert.deepEqual(detail.students.map(row=>[row.answer,row.answerState,row.verdict]),[
    ['A','answered','incorrect'],['B','answered','correct'],[null,'blank','incorrect'],['B','answered','pending']
  ]);
  assert.doesNotMatch(scored.text,/Bài mở giả/);
  const reflection=await request(app).get(path+'/'+open+'/responses').set('Cookie',own);
  assert.equal(reflection.status,200);
  assert.equal(reflection.body.detail.counts.graded,0);
  assert.equal(reflection.body.detail.students[0].answer,'Bài mở giả 0');
  assert.equal((await request(app).get(path+'/'+id(99)+'/responses').set('Cookie',own)).status,404);
  const outside=await login('outside');
  const before=attemptedRead;
  for(const url of [path+'?view=summary',path+'/'+choice+'/responses',path+'/'+open+'/responses']){
    const res=await request(app).get(url).set('Cookie',outside);
    assert.equal(res.status,404);
    assert.equal(res.body.error,'ASSIGNMENT_ACCESS_DENIED');
    assert.equal(res.body.detail,undefined);
    assert.equal(res.body.analytics,undefined);
  }
  assert.equal(attemptedRead,before);
  assert.equal((await request(app).get(path+'/'+choice+'/responses')).status,401);
});
