import {randomUUID,createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {createIndependentSpeaking} from '../src/speaking-independent.js';
import {createSpeakingHomeworkService,SpeakingHomeworkError} from '../src/speaking-homework.js';
import {createSpeakingObservationData} from '../src/speaking-observation-data.js';
export const id=n=>`7400000a-0000-4000-8000-${String(n).padStart(12,'0')}`;
export const code='67-speaking-state-fixture';
export const token=n=>String.fromCharCode(96+n).repeat(43);
export const hash=value=>createHash('sha256').update(value).digest('hex');
const stamp='2026-11-01T00:00:00.000Z';

// 100 chủ thật sự khác nhau trong fixture, cố ý trùng tên và dùng cùng UUID lượt
// ở hai schema để kiểm ranh giới kho; không giả100 người bằng100 bản sao một token.
export async function seedBatch(f,count=100){
 const rows=Array.from({length:count},(_,index)=>{
  const n=index+1;return {student:id(10000+n),profile:id(20000+n),unit:id(30000+n),grant_id:id(40000+n),contact:60000+n,
   document:'state-bulk-document-'+n,hash:hash(Buffer.from(hash('state-bulk-token-'+n),'hex').toString('base64url'))};
 });
 const input=`input AS(SELECT * FROM jsonb_to_recordset($1::jsonb)
  AS x(student uuid,profile uuid,unit uuid,grant_id uuid,contact bigint,document text,hash text))`;
 await f.db.query(`WITH ${input}, inserted AS(INSERT INTO mapping.student_mapping_review
  SELECT student,2304,contact,'Tên trùng','bulk-google-'||contact,'approved' FROM input RETURNING public_id)
  INSERT INTO mapping.erp_class_membership_snapshot SELECT 2304,x.contact,'active','on_going'
  FROM input x JOIN inserted m ON m.public_id=x.student`,[JSON.stringify(rows)]);
 await f.db.query(`WITH ${input}, inserted AS(INSERT INTO speaking_independent.profile
  SELECT profile,student,'member',2304,'IC2304',student,'Tên trùng','100',NULL FROM input RETURNING id)
  INSERT INTO speaking_independent.work_unit(id,profile_id,assignment_code,context_key,template,origin,status,token_hash)
  SELECT x.unit,x.profile,$2,'web',$3::jsonb,'web','draft',x.hash FROM input x JOIN inserted p ON p.id=x.profile`,[JSON.stringify(rows),code,JSON.stringify(f.template)]);
 await f.db.query(`WITH ${input}, docs AS(INSERT INTO speaking_homework.assignment_document
  SELECT '${id(101)}'::uuid,document,student FROM input RETURNING document_id), grants AS(INSERT INTO speaking_homework.access_grant
  SELECT x.grant_id,'${id(101)}'::uuid,x.student,x.document,x.hash,NULL FROM input x JOIN docs d ON d.document_id=x.document RETURNING id)
  INSERT INTO speaking_homework.submission(id,access_grant_id,status) SELECT x.unit,x.grant_id,'draft' FROM input x JOIN grants g ON g.id=x.grant_id`,[JSON.stringify(rows)]);
 return rows;
}

export async function fixture(){
 let db,readerPool,nativePool,close;
 const nativeUrl=process.env.PRACTICE_FIXTURE_DATABASE_URL;
 if(nativeUrl){
  const target=new URL(nativeUrl);assert.equal(process.env.PRACTICE_FIXTURE_CONFIRM,'test-services-optimization-20261101');
  assert.match(target.hostname,/^tsto-practice-pg-[a-z0-9]+$/);assert.equal(target.username,'fixture');assert.equal(target.pathname,'/postgres');
  const {default:pg}=await import('pg');const admin=new pg.Client({connectionString:target.href});await admin.connect();
  const name='speaking_state_fixture_'+randomUUID().replaceAll('-','');
  try{
   for(const role of ['speaking_state_reader','speaking_state_native'])await admin.query(`DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='${role}') THEN CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;END IF;END $$`);
   await admin.query('CREATE DATABASE '+name);target.pathname='/'+name;
   const owner=new pg.Pool({connectionString:target.href,max:2});db={query:(sql,params)=>owner.query(sql,params),exec:sql=>owner.query(sql)};
   target.username='speaking_state_reader';readerPool=new pg.Pool({connectionString:target.href,max:4});
   target.username='speaking_state_native';nativePool=new pg.Pool({connectionString:target.href,max:4});
   close=async()=>{await readerPool.end();await nativePool.end();await owner.end();await admin.query('DROP DATABASE '+name);await admin.end();};
  }catch(error){await admin.end();throw error;}
 }else{
  const {PGlite}=await import('@electric-sql/pglite');db=new PGlite();readerPool=db;nativePool=db;close=()=>db.close();
 }
 try{
  await db.exec(`CREATE SCHEMA mapping;CREATE SCHEMA speaking_homework;CREATE SCHEMA speaking_independent;
   CREATE TABLE mapping.classroom_course_mapping(erp_course_class_id bigint PRIMARY KEY,erp_class_name_snapshot text,classroom_course_id text,status text);
   CREATE TABLE mapping.student_mapping_review(public_id uuid PRIMARY KEY,erp_course_class_id bigint,erp_student_contact_id bigint,erp_student_name_snapshot text,classroom_user_id text,status text);
   CREATE TABLE mapping.erp_class_membership_snapshot(erp_course_class_id bigint,erp_student_contact_id bigint,source_state text,registration_status text);
   CREATE TABLE speaking_homework.assignment(id uuid PRIMARY KEY,class_id bigint,course_id text,course_work_id text,assignment_code text,title text,status text,
    doctor_course_key text,required_practice_count integer,delivery_mode text);
   CREATE TABLE speaking_homework.assignment_document(assignment_id uuid,document_id text PRIMARY KEY,student_ref uuid);
   CREATE TABLE speaking_homework.access_grant(id uuid PRIMARY KEY,assignment_id uuid,student_ref uuid,document_id text,token_hash char(64),revoked_at timestamptz);
   CREATE TABLE speaking_homework.submission(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),access_grant_id uuid UNIQUE,status text DEFAULT 'draft',submitted_at timestamptz);
   CREATE TABLE speaking_homework.submission_link(id uuid PRIMARY KEY,submission_id uuid,part text,revision integer,share_url text,share_id text,fingerprint char(64),
    check_status text,check_code text,question_count integer,evidence jsonb DEFAULT '{}',typing_warning boolean DEFAULT false,voice_confirmed boolean DEFAULT false,
    checked_at timestamptz,created_at timestamptz DEFAULT '${stamp}');
   CREATE TABLE speaking_homework.practice_link(id uuid PRIMARY KEY,access_grant_id uuid,slot integer,revision integer,share_url text,exercise_id uuid,status text,
    check_code text,question_count integer,evidence jsonb DEFAULT '{}',typing_warning boolean DEFAULT false,voice_confirmed boolean DEFAULT false,
    checked_at timestamptz,submitted_at timestamptz DEFAULT '${stamp}');
   CREATE TABLE speaking_homework.practice_check_job(id uuid PRIMARY KEY,practice_link_id uuid,status text,attempts integer);
   CREATE TABLE speaking_homework.practice_analysis_job(id uuid PRIMARY KEY,practice_link_id uuid,status text,attempts integer);
   CREATE TABLE speaking_homework.assignment_part(assignment_id uuid,part_key text,display_title text,practice_url text,min_questions integer,position integer);
   CREATE TABLE speaking_homework.receipt(id uuid PRIMARY KEY,submission_id uuid UNIQUE,created_at timestamptz DEFAULT '${stamp}');
   CREATE TABLE speaking_homework.outbox(id uuid PRIMARY KEY,receipt_id uuid,kind text,status text,attempts integer,created_at timestamptz DEFAULT '${stamp}');
   CREATE TABLE speaking_homework.doctor_exercise(id uuid PRIMARY KEY,title text,exercise_url text,course_key text,active boolean);
   CREATE TABLE speaking_homework.doctor_recommendation(class_id bigint,student_ref uuid,exercise_id uuid,recommendation_count integer,practice_count integer,
    waiting boolean,proposed_at timestamptz,last_practiced_at timestamptz);
   CREATE TABLE speaking_homework.doc_progress(unit_id uuid PRIMARY KEY,status text,error_code text,sequence bigint,applied_sequence bigint,verified_at timestamptz);
   CREATE TABLE speaking_independent.profile(id uuid PRIMARY KEY,identity_ref uuid,kind text,class_id bigint,class_code text,student_ref uuid,student_name text,
    course_id text,linked_profile_id uuid);
   CREATE TABLE speaking_independent.work_unit(id uuid PRIMARY KEY,profile_id uuid,assignment_code text,context_key text,template jsonb,origin text,status text,
    document_id text,tab_id text,token_hash char(64),revoked_at timestamptz,submitted_at timestamptz,created_at timestamptz DEFAULT '${stamp}');
   CREATE TABLE speaking_independent.link(id uuid PRIMARY KEY,work_unit_id uuid,kind text,part text,slot integer,exercise_id uuid,exercise_title text,revision integer,
    share_url text,share_id text,fingerprint char(64),question_count integer,evidence jsonb DEFAULT '{}',status text,check_code text,
    typing_warning boolean DEFAULT false,voice_confirmed boolean DEFAULT false,checked_at timestamptz,created_at timestamptz DEFAULT '${stamp}');
   CREATE TABLE speaking_independent.job(id uuid PRIMARY KEY,work_unit_id uuid,kind text,status text,link_id uuid,attempts integer,created_at timestamptz DEFAULT '${stamp}');
   CREATE TABLE speaking_independent.receipt(id uuid PRIMARY KEY,work_unit_id uuid UNIQUE,created_at timestamptz DEFAULT '${stamp}');
   CREATE TABLE speaking_independent.doctor_recommendation(profile_id uuid,exercise_id uuid,recommendation_count integer,practice_count integer,waiting boolean,
    proposed_at timestamptz,last_practiced_at timestamptz);
   CREATE TABLE speaking_independent.doc_progress(LIKE speaking_homework.doc_progress INCLUDING ALL);
   INSERT INTO mapping.classroom_course_mapping VALUES(2304,'IC2304','100','approved'),(2305,'IC2305','200','approved');
   INSERT INTO speaking_homework.doctor_exercise VALUES('${id(201)}','Bài A','https://fixture.invalid/a','67',true),
    ('${id(202)}','Bài B','https://fixture.invalid/b','67',true);`);
  const template={assignmentCode:code,title:'Speaking fixture',lesson:4,parts:[{part_key:'main',display_title:'Phần chính',min_questions:2}],requiredPracticeCount:2,doctorEnabled:true};
  for(const n of [1,2,3]){
   const classId=n===2?'2305':'2304',course=n===2?'200':'100';
   await db.query('INSERT INTO mapping.student_mapping_review VALUES($1,$2,$3,$4,$5,$6)',[id(n),classId,n,'Tên trùng','google-'+n,'approved']);
   await db.query("INSERT INTO mapping.erp_class_membership_snapshot VALUES($1,$2,'active','on_going')",[classId,n]);
   const assignmentId=id(n===2?102:101);
   if(n!==3){
    await db.query('INSERT INTO speaking_homework.assignment VALUES($1,$2,$3,$4,$5,$6,$7,$8,2,$9)',
     [assignmentId,classId,course,n===2?'2001':'1001',code,'Speaking fixture','open','67','direct']);
    await db.query("INSERT INTO speaking_homework.assignment_part VALUES($1,'main','Phần chính','https://fixture.invalid/main',2,1)",[assignmentId]);
   }
   await db.query('INSERT INTO speaking_homework.assignment_document VALUES($1,$2,$3)',[assignmentId,'document-l'+n,id(n)]);
   await db.query('INSERT INTO speaking_homework.access_grant VALUES($1,$2,$3,$4,$5,NULL)',[id(200+n),assignmentId,id(n),'document-l'+n,hash(token(n))]);
   await db.query('INSERT INTO speaking_homework.submission VALUES($1,$2,$3,$4)',[id(2000+n),id(200+n),n===3?'submitted':'draft',n===3?stamp:null]);
   await db.query("INSERT INTO speaking_independent.profile VALUES($1,$2,'member',$3,$4,$2,$5,$6,NULL)",[id(300+n),id(n),classId,'IC'+classId,'Tên trùng',course]);
   await db.query(`INSERT INTO speaking_independent.work_unit(id,profile_id,assignment_code,context_key,template,origin,status,document_id,tab_id,token_hash,submitted_at)
    VALUES($1,$2,$3,'web',$4,'web',$5,$6,$7,$8,$9)`,[id(1000+n),id(300+n),code,JSON.stringify(template),n===3?'submitted':'draft',n===3?'document-i3':null,n===3?'t.0':null,hash(token(n)),n===3?stamp:null]);
  }
  await db.query("INSERT INTO speaking_independent.profile VALUES($1,$2,'document',2304,'IC2304',$3,'Tên trùng',NULL,$4)",[id(304),id(4),id(1),id(301)]);
  await db.query(`INSERT INTO speaking_independent.work_unit(id,profile_id,assignment_code,context_key,template,origin,status,document_id,tab_id,token_hash)
   VALUES($1,$2,$3,'document:fixture',$4,'document','draft','document-i4','t.0',$5)`,[id(1004),id(304),code,JSON.stringify(template),hash(token(4))]);
  for(const n of [1,2,3]){
   for(const revision of n===1?[1,2]:[1]){
    const status=n===1&&revision===2?'pending':'accepted';
    await db.query(`INSERT INTO speaking_homework.submission_link(id,submission_id,part,revision,share_url,share_id,fingerprint,check_status,question_count,checked_at)
     VALUES($1,$2,'main',$3,$4,$5,$6,$7,$8,$9)`,[id(4000+n*10+revision),id(2000+n),revision,'https://chatgpt.com/share/'+id(n+revision),id(n+revision),'f'.repeat(64),status,status==='accepted'?2:null,stamp]);
    await db.query(`INSERT INTO speaking_independent.link(id,work_unit_id,kind,part,revision,share_url,share_id,fingerprint,status,question_count,checked_at)
     VALUES($1,$2,'main','main',$3,$4,$5,$6,$7,$8,$9)`,[id(3000+n*10+revision),id(1000+n),revision,'https://chatgpt.com/share/'+id(n+revision),id(n+revision),'f'.repeat(64),status,status==='accepted'?2:null,stamp]);
   }
  }
  for(const slot of [1,2]){
   const status=slot===1?'accepted':'pending';
   await db.query(`INSERT INTO speaking_homework.practice_link(id,access_grant_id,slot,revision,share_url,exercise_id,status,question_count)
    VALUES($1,$2,$3,1,$4,$5,$6,$7)`,[id(4100+slot),id(201),slot,'https://chatgpt.com/share/'+id(100+slot),id(200+slot),status,slot===1?3:null]);
   await db.query(`INSERT INTO speaking_independent.link(id,work_unit_id,kind,part,slot,exercise_id,exercise_title,revision,share_url,share_id,status,question_count)
    VALUES($1,$2,'practice',$3,$4,$5,$6,1,$7,$8,$9,$10)`,[id(3100+slot),id(1001),'practice_'+slot,slot,id(200+slot),'Bài '+(slot===1?'A':'B'),'https://chatgpt.com/share/'+id(100+slot),id(100+slot),status,slot===1?3:null]);
   await db.query("INSERT INTO speaking_homework.practice_check_job VALUES($1,$2,'failed',5)",[id(5100+slot),id(4100+slot)]);
   await db.query("INSERT INTO speaking_homework.practice_analysis_job VALUES($1,$2,'failed',5)",[id(5200+slot),id(4100+slot)]);
   await db.query("INSERT INTO speaking_independent.job VALUES($1,$2,'check_practice','failed',$3,5,$4)",[id(5300+slot),id(1001),id(3100+slot),stamp]);
   await db.query("INSERT INTO speaking_independent.job VALUES($1,$2,'analyze_practice','review',$3,5,$4)",[id(5400+slot),id(1001),id(3100+slot),stamp]);
   await db.query(`INSERT INTO speaking_homework.practice_link(id,access_grant_id,slot,revision,share_url,exercise_id,status,question_count)
    VALUES($1,$2,$3,1,$4,$5,'accepted',3)`,[id(4300+slot),id(203),slot,'https://chatgpt.com/share/'+id(300+slot),id(200+slot)]);
   await db.query(`INSERT INTO speaking_independent.link(id,work_unit_id,kind,part,slot,exercise_id,exercise_title,revision,share_url,share_id,status,question_count)
    VALUES($1,$2,'practice',$3,$4,$5,$6,1,$7,$8,'accepted',3)`,[id(3300+slot),id(1003),'practice_'+slot,slot,id(200+slot),'Bài '+(slot===1?'A':'B'),
     'https://chatgpt.com/share/'+id(300+slot),id(300+slot)]);
  }
  await db.exec(`INSERT INTO speaking_homework.receipt VALUES('${id(601)}','${id(2003)}','${stamp}');
   INSERT INTO speaking_independent.receipt VALUES('${id(602)}','${id(1003)}','${stamp}');
   INSERT INTO speaking_homework.outbox VALUES('${id(701)}','${id(601)}','doctor_analyze','failed',5,'${stamp}'),
    ('${id(702)}','${id(601)}','write_doc','pending',0,'${stamp}');
   INSERT INTO speaking_independent.job VALUES('${id(703)}','${id(1003)}','analyze_homework','review',NULL,5,'${stamp}'),
    ('${id(704)}','${id(1003)}','write_doc','pending',NULL,0,'${stamp}');
   INSERT INTO speaking_homework.doctor_recommendation VALUES(2304,'${id(1)}','${id(201)}',3,1,true,'${stamp}',NULL),
    (2304,'${id(1)}','${id(202)}',1,2,false,'${stamp}','${stamp}');
   INSERT INTO speaking_independent.doctor_recommendation VALUES('${id(301)}','${id(201)}',3,1,true,'${stamp}',NULL),
    ('${id(301)}','${id(202)}',1,2,false,'${stamp}','${stamp}');
   INSERT INTO speaking_homework.doc_progress VALUES('${id(201)}','pending',NULL,1,0,NULL),('${id(203)}','verified',NULL,2,2,'${stamp}');
   INSERT INTO speaking_independent.doc_progress VALUES('${id(1003)}','verified',NULL,2,2,'${stamp}'),('${id(1004)}','pending',NULL,1,0,NULL);`);
  if(nativeUrl)await db.exec(`GRANT USAGE ON SCHEMA mapping,speaking_homework,speaking_independent TO speaking_state_reader,speaking_state_native;
   GRANT SELECT ON ALL TABLES IN SCHEMA mapping,speaking_homework,speaking_independent TO speaking_state_reader,speaking_state_native;
   GRANT INSERT,UPDATE ON speaking_homework.submission TO speaking_state_native;`);
  const reads=[],nativeReads=[];
  const pool={async query(sql,params){reads.push(sql);return readerPool.query(sql,params);}};
  const native={async query(sql,params){nativeReads.push(sql);const result=await nativePool.query(sql,params);return {...result,rowCount:result.rowCount??result.rows.length};}};
  const source={async context(input){
   const classes=(await pool.query("SELECT erp_course_class_id AS class_id,erp_class_name_snapshot AS class_code,classroom_course_id AS course_id FROM mapping.classroom_course_mapping WHERE status='approved' ORDER BY erp_course_class_id")).rows;
   const scope=classes.find(row=>row.class_code===input.classCode);
   const exercises=(await pool.query("SELECT id,title,exercise_url FROM speaking_homework.doctor_exercise WHERE active AND course_key='67' ORDER BY id")).rows;
   if(!input.classCode)return {template,classes,exercises};
   if(!scope)throw new SpeakingHomeworkError('CLASS_SCOPE_INVALID','Lớp fixture không còn hợp lệ.',403);
   const students=(await pool.query(`SELECT m.public_id AS student_ref,m.erp_student_name_snapshot AS name
    FROM mapping.student_mapping_review m WHERE m.erp_course_class_id=$1 AND m.status='approved' AND m.classroom_user_id IS NOT NULL
    AND EXISTS(SELECT 1 FROM mapping.erp_class_membership_snapshot e WHERE e.erp_course_class_id=m.erp_course_class_id
     AND e.erp_student_contact_id=m.erp_student_contact_id AND e.source_state='active' AND e.registration_status='on_going') ORDER BY m.public_id`,[scope.class_id])).rows;
   const member=students.find(row=>row.student_ref===input.studentRef);
   if(input.studentRef&&!member)throw new SpeakingHomeworkError('STUDENT_NOT_ACTIVE','Hồ sơ fixture không còn học.',403);
   return {template,scope,students,selectionStudents:students,member,exercises};
  }};
  if(nativeUrl&&(!process.env.SPEAKING_STATE_INDEPENDENT_BASE||!process.env.SPEAKING_STATE_LEGACY_BASE))throw Error('SPEAKING_STATE_BASELINES_REQUIRED');
  const independentFactory=nativeUrl?(await import(pathToFileURL(process.env.SPEAKING_STATE_INDEPENDENT_BASE).href)).createIndependentSpeaking:createIndependentSpeaking;
  const legacyFactory=nativeUrl?(await import(pathToFileURL(process.env.SPEAKING_STATE_LEGACY_BASE).href)).createSpeakingHomeworkService:createSpeakingHomeworkService;
  return {db,pool,reads,nativeReads,nativeUrl,source,template,close,
   data:schema=>createSpeakingObservationData({pool,schema}),
   independent:independentFactory({pool:native,source,accessSecret:'fixture-only-secret-at-least32characters'}),
   legacy:legacyFactory({pool:native,accessSecret:'fixture-only-secret-at-least32characters'})};
 }catch(error){await close();throw error;}
}
