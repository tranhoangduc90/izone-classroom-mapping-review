import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import pg from 'pg';
import {createIndependentSpeaking} from '../independent/src/speaking-independent.js';
if(process.env.SPEAKING_NATIVE_TEST_DATABASE_URL)throw Error('ONLY_LOCAL_PGLITE_ALLOWED');
const ref='60000000-0000-4000-8000-000000000006';
const code='67-speaking-ly_do_hanh_vi';
const exercise=n=>`60000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const url=n=>`https://chatgpt.com/share/${String(n).padStart(32,'0')}`;
const fingerprint=n=>String(n).repeat(64).slice(0,64);
const template={assignmentCode:code,title:'Lesson 6',lesson:6,requiredPracticeCount:2,doctorEnabled:true,digest:'a'.repeat(64),
  parts:[{part_key:'benefit_harm',min_questions:0},{part_key:'reason_action',min_questions:2},{part_key:'freestyle',min_questions:1}]};

async function fixture({start=true,recommendations=[],unapproved=false,journal}={}) {
  let db,nativePool;
  if(process.env.SPEAKING_NATIVE_TEST_DATABASE_URL) {
    const url=new URL(process.env.SPEAKING_NATIVE_TEST_DATABASE_URL);
    assert.match(url.pathname,/^\/speaking_independent_fixture_[a-z0-9_]+$/);
    nativePool=new pg.Pool({connectionString:url.href,max:8});
    await nativePool.query('DROP SCHEMA IF EXISTS speaking_independent CASCADE; DROP SCHEMA IF EXISTS speaking_homework CASCADE; DROP SCHEMA IF EXISTS mapping CASCADE');
    db={exec:sql=>nativePool.query(sql),query:(sql,params)=>nativePool.query(sql,params),close:()=>nativePool.end()};
  }else db=new PGlite();
  await db.exec(`CREATE SCHEMA mapping;
    CREATE TABLE mapping.classroom_course_mapping(erp_course_class_id bigint PRIMARY KEY);
    CREATE TABLE mapping.student_mapping_review(public_id uuid PRIMARY KEY);
    CREATE SCHEMA speaking_homework;
    CREATE TABLE speaking_homework.assignment_template(page_path text CONSTRAINT assignment_template_page_path_check CHECK(page_path='lesson-6.html'));
    DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='speaking_homework_api') THEN CREATE ROLE speaking_homework_api; END IF; END $$;`);
  for(const name of ['202609270001_speaking_homework_candidate.sql','202609290003_speaking_lesson4_practice.sql'])
    await db.exec(await readFile(new URL(`../ops/migrations/${name}`,import.meta.url),'utf8'));
  // Live còn khóa hội thoại nguồn legacy; migration phải giữ cả loại nguồn lịch sử này.
  await db.exec("ALTER TABLE speaking_homework.conversation_claim DROP CONSTRAINT conversation_claim_source_kind_check, ADD CONSTRAINT conversation_claim_source_kind_check CHECK(source_kind IN ('homework','practice','legacy'))");
  await db.exec(await readFile(new URL('../ops/migrations/202610080530_speaking_independent_intake.sql',import.meta.url),'utf8'));
  await db.exec(await readFile(new URL('../ops/migrations/202611030102_speaking_unmatched_sources.sql',import.meta.url),'utf8'));
  for(const name of ['202610250930_speaking_progress_docs.sql','202610250931_speaking_independent_progress_docs.sql'])
    await db.exec(await readFile(new URL('../ops/migrations/'+name,import.meta.url),'utf8'));
  await db.exec(`CREATE TABLE speaking_independent.conversation_snapshot(link_id uuid PRIMARY KEY,original_fingerprint text,fingerprint text,messages jsonb,source text DEFAULT 'accepted',recovery_job_id uuid)`);
  const query=async(sql,params)=>{const r=await db.query(sql,params);return {...r,rowCount:r.rowCount??r.rows.length};};
  const pool=nativePool||{query,async connect(){return {query,release(){}};}};
  let active=true;
  const source={async context(i){
    if(i.assignmentCode!==code) throw Object.assign(new Error('Mã cũ'),{code:'UNSUPPORTED_ASSIGNMENT'});
    const classes=[{class_id:1293,class_code:'IC2304',course_id:'826336470852'}];
    const exercises=[{id:exercise(1),title:'Bài một',exercise_url:'https://example.invalid/1'},{id:exercise(2),title:'Bài hai',exercise_url:'https://example.invalid/2'}];
    if(!i.classCode) return {template,classes,exercises};
    if(i.classCode!=='IC2304'||(i.studentRef&&(i.studentRef!==ref||!active))) throw Object.assign(new Error('Hồ sơ không hoạt động'),{code:'STUDENT_NOT_ACTIVE'});
    return {template,scope:classes[0],students:[{student_ref:ref,name:'Học viên fixture',google_user_id:'fixture-user'}],member:i.studentRef?{student_ref:ref,name:'Học viên fixture'}:null,
      selectionStudents:active?[{student_ref:ref,name:'Học viên fixture'},...(unapproved?[{student_ref:exercise(88),name:'Tên ERP chưa ghép'}]:[])]:[],
      exercises,recommendations};},
    async teacher(_class,headers){return headers.cookie==='teacher=allowed';}};
  const service=createIndependentSpeaking({pool,source,accessSecret:'fixture-secret-32-characters-long-only',progressDocsEnabled:true,journal});
  const session=start?await service.startSelected({assignmentCode:code,classCode:'IC2304',studentRef:ref}):null;
  const identity=session?{accessToken:session.accessToken,studentRef:ref}:null;
  return {db,pool,service,session,identity,source,drop:()=>{active=false;}};
}

export {fixture,ref,code,url,fingerprint,exercise};
