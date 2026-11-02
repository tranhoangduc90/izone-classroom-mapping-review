import {randomUUID,createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {createTeacherAccessObserver} from '../src/auth.js';
export const key=n=>createHash('sha256').update('observer-'+n).digest('hex');
export const token=n=>createHash('sha256').update('observer-token-'+n).digest('base64url');
export const cookie=n=>'observe_teacher='+token(n);
export const actor=(n,classIds=['2304','2305','unlinked'])=>({key:key(n),cookie:cookie(n),classIds});

// Hai role fixture riêng: observer chỉ SELECT; native auth được gia hạn phiên.
// Không dùng credentials/database của học viên hoặc Google trong cả hai chế độ.
export async function fixture(){
 let db,reader,authPool,close;const native=process.env.PRACTICE_FIXTURE_DATABASE_URL;
 if(native){
  const target=new URL(native);assert.equal(process.env.PRACTICE_FIXTURE_CONFIRM,'test-services-optimization-20261101');
  assert.match(target.hostname,/^tsto-practice-pg-[a-z0-9]+$/);assert.equal(target.username,'fixture');assert.equal(target.pathname,'/postgres');
  const {default:pg}=await import('pg');const admin=new pg.Client({connectionString:target.href});await admin.connect();
  const name='teacher_observation_fixture_'+randomUUID().replaceAll('-','');
  try{
   for(const role of ['teacher_observation_reader','teacher_observation_auth'])await admin.query(`DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='${role}') THEN CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;END IF;END $$`);
   await admin.query('CREATE DATABASE '+name);target.pathname='/'+name;
   const owner=new pg.Pool({connectionString:target.href,max:2});db={query:(sql,params)=>owner.query(sql,params),exec:sql=>owner.query(sql)};
   target.username='teacher_observation_reader';reader=new pg.Pool({connectionString:target.href,max:2});
   target.username='teacher_observation_auth';authPool=new pg.Pool({connectionString:target.href,max:2});
   close=async()=>{await reader.end();await authPool.end();await owner.end();await admin.query('DROP DATABASE '+name);await admin.end();};
  }catch(error){await admin.end();throw error;}
 }else{
  const {PGlite}=await import('@electric-sql/pglite');db=new PGlite();reader=db;authPool=db;close=()=>db.close();
 }
 try{
  await db.exec(`CREATE SCHEMA mapping;
   CREATE TABLE mapping.reviewer_account(email text PRIMARY KEY,display_name text,role text,can_access_all_classes boolean,google_subject text,status text,last_login_at timestamptz,updated_at timestamptz);
   CREATE TABLE mapping.reviewer_session(token_hash bytea PRIMARY KEY,reviewer_email text,google_subject text,revoked_at timestamptz,
    idle_expires_at timestamptz,absolute_expires_at timestamptz,last_seen_at timestamptz DEFAULT '2026-01-01T00:00:00Z');
   CREATE TABLE mapping.classroom_course_mapping(erp_course_class_id bigint,erp_class_name_snapshot text);
   CREATE TABLE mapping.reviewer_class_access(reviewer_email text,erp_course_class_id bigint);
   CREATE TABLE mapping.reviewer_class_assignment(reviewer_email text,class_name text);
   INSERT INTO mapping.classroom_course_mapping VALUES(2304,'IC2304'),(2305,'IC2305');
   INSERT INTO mapping.reviewer_class_access VALUES('teacher1@fixture.test',2304);
   INSERT INTO mapping.reviewer_class_assignment VALUES('teacher2@fixture.test',' ic2305 ');`);
  for(let n=1;n<=9;n++){
   await db.query('INSERT INTO mapping.reviewer_account(email,display_name,role,can_access_all_classes,google_subject,status) VALUES($1,$2,$3,$4,$5,$6)',
    ['teacher'+n+'@fixture.test',n===1?null:'Tên giả',n===3?' ADMIN ':'reviewer',n===4,'subject-'+n,n===5?'blocked':'active']);
   await db.query(`INSERT INTO mapping.reviewer_session(token_hash,reviewer_email,google_subject,revoked_at,idle_expires_at,absolute_expires_at)
    VALUES($1,$2,$3,CASE WHEN $4 THEN now() ELSE NULL END,now()+($5::int*interval '1 day'),now()+($6::int*interval '1 day'))`,
    [createHash('sha256').update(token(n)).digest(),'teacher'+n+'@fixture.test',n===9?'wrong-subject':'subject-'+n,n===8,n===6?-1:1,n===7?-1:365]);
  }
  if(native)await db.exec(`GRANT USAGE ON SCHEMA mapping TO teacher_observation_reader,teacher_observation_auth;
   GRANT SELECT ON ALL TABLES IN SCHEMA mapping TO teacher_observation_reader,teacher_observation_auth;
   GRANT UPDATE(last_seen_at,idle_expires_at) ON mapping.reviewer_session TO teacher_observation_auth;
   GRANT UPDATE(google_subject,last_login_at,updated_at) ON mapping.reviewer_account TO teacher_observation_auth;`);
  const calls=[],authCalls=[];
  const wrap=(database,queries)=>({async query(sql,params){queries.push(sql);const result=await database.query(sql,params);return{...result,rowCount:result.rowCount??result.rows.length};}});
  const pool=wrap(reader,calls),nativeAuth=wrap(authPool,authCalls);
  const config={authMode:'google',teacherSessionCookieName:'observe_teacher',nodeEnv:'test',allowedOrigins:new Set(['https://tranhoangduc90.github.io'])};
  return{db,pool,authPool:nativeAuth,reader,calls,authCalls,config,observe:createTeacherAccessObserver({config,pool}),close};
 }catch(error){await close();throw error;}
}

export async function seedHundred(f){
 const rows=Array.from({length:100},(_,index)=>{const n=1000+index;return{email:'teacher'+n+'@fixture.test',subject:'subject-'+n,hash:createHash('sha256').update(token(n)).digest('hex')};});
 await f.db.query(`WITH input AS(SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(email text,subject text,hash text)),
  accounts AS(INSERT INTO mapping.reviewer_account(email,display_name,role,can_access_all_classes,google_subject,status)
   SELECT email,'Tên trùng','reviewer',false,subject,'active' FROM input RETURNING email),
  sessions AS(INSERT INTO mapping.reviewer_session(token_hash,reviewer_email,google_subject,idle_expires_at,absolute_expires_at)
   SELECT decode(x.hash,'hex'),x.email,x.subject,now()+interval '1 day',now()+interval '365 days' FROM input x JOIN accounts a ON a.email=x.email)
  INSERT INTO mapping.reviewer_class_access SELECT x.email,CASE WHEN x.email ~ '[02468]@' THEN 2304 ELSE 2305 END FROM input x JOIN accounts a ON a.email=x.email`,[JSON.stringify(rows)]);
 return Array.from({length:100},(_,index)=>actor(1000+index));
}
