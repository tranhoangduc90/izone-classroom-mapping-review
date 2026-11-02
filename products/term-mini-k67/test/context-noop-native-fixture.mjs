import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import pg from 'pg';
let externalAttempts=0;
globalThis.fetch=()=>{externalAttempts++;throw Error('NATIVE_EXTERNAL_REQUEST_DENIED');};

// Chỉ tạo DB tổng hợp trên PostgreSQL container riêng của task; role đồng bộ
// không DDL/không đọc token. Đóng và xóa đúng DB ngẫu nhiên của fixture này.
export async function nativeContextFixture(){
 assert.equal(process.env.PRACTICE_FIXTURE_CONFIRM,'test-services-optimization-20261101');
 const url=new URL(process.env.PRACTICE_FIXTURE_DATABASE_URL);assert.equal(url.protocol,'postgres:');assert.equal(url.username,'fixture');assert.equal(url.pathname,'/postgres');assert.match(url.hostname,/^tsto-practice-pg-[a-z0-9]+$/);assert.equal(url.password,'');assert.equal(url.search,'');assert.equal(url.hash,'');
 const name='term_mini_k67_test_tsto_'+randomBytes(6).toString('hex'),admin=new pg.Pool({connectionString:url.href,max:1,connectionTimeoutMillis:5000,statement_timeout:10000});let owner,pool,created=false,closed=false;
 async function close(){
  if(closed)return;closed=true;await pool?.end();await owner?.end();
  try{if(created){assert.match(name,/^term_mini_k67_test_tsto_[a-f0-9]{12}$/);await admin.query('DROP DATABASE '+name);}}finally{await admin.end();}
 }
 try{
  const version=Number((await admin.query('SHOW server_version_num')).rows[0].server_version_num);assert.ok(version>=170000&&version<180000);
  await admin.query(`DO $$ BEGIN
   IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='k67_owner') THEN CREATE ROLE k67_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE; END IF;
   IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='k67_context_sync') THEN CREATE ROLE k67_context_sync LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE; END IF;
   END $$;`);
  await admin.query('CREATE DATABASE '+name+' OWNER k67_owner');created=true;
  const own=new URL(url);own.username='k67_owner';own.pathname='/'+name;owner=new pg.Pool({connectionString:own.href,max:1,connectionTimeoutMillis:5000,statement_timeout:10000});
  const app=new URL(own);app.username='k67_context_sync';pool=new pg.Pool({connectionString:app.href,max:2,connectionTimeoutMillis:5000,statement_timeout:10000});
  const db={query:(...args)=>owner.query(...args),exec:sql=>owner.query(sql)};
  async function grantAndVerify(){
   // Cột đang có trên mirror live của bộ đồng bộ ERP course5; chỉ fixture được ALTER.
   await owner.query('ALTER TABLE mapping.classroom_course_mapping ADD COLUMN erp_course_id bigint');
   await owner.query(`REVOKE ALL ON DATABASE ${name} FROM PUBLIC;GRANT CONNECT ON DATABASE ${name} TO k67_context_sync;
    GRANT USAGE ON SCHEMA mapping TO k67_context_sync;
    GRANT SELECT,INSERT,UPDATE,DELETE ON mapping.classroom_course_mapping,mapping.student_mapping_review,mapping.erp_class_membership_snapshot,mapping.reviewer_account,mapping.reviewer_class_access,mapping.k67_context_state TO k67_context_sync;
    GRANT SELECT(reviewer_email,revoked_at),UPDATE(revoked_at,revoked_reason) ON mapping.reviewer_session TO k67_context_sync;`);
   assert.deepEqual((await pool.query('SELECT current_user AS role,rolsuper,rolcreatedb FROM pg_roles WHERE rolname=current_user')).rows[0],{role:'k67_context_sync',rolsuper:false,rolcreatedb:false});
   await assert.rejects(pool.query('CREATE TABLE mapping.forbidden_fixture(id integer)'),e=>e.code==='42501');
   await assert.rejects(pool.query('SELECT token_hash FROM mapping.reviewer_session'),e=>e.code==='42501');
  }
  return{db,pool,grantAndVerify,close:async()=>{await close();assert.equal(externalAttempts,0);console.log(JSON.stringify({event:'term_context_native_cleanup',database:name,role:'k67_context_sync',closed:true,externalAttempts}));}};
 }catch(error){await close();throw error;}
}
