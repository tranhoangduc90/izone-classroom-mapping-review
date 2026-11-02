import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import pg from 'pg';
let externalAttempts=0;
if(process.env.PRACTICE_FIXTURE_DATABASE_URL){
  const originalFetch=globalThis.fetch;
  globalThis.fetch=(input,...args)=>{
    const target=new URL(typeof input==='string'?input:input.url||input.href);
    if(target.protocol!=='http:'||target.hostname!=='127.0.0.1'){
      externalAttempts++;throw Error('RESULT_NATIVE_EXTERNAL_REQUEST_DENIED');
    }
    return originalFetch(input,...args);
  };
}
// Dữ liệu/DDL giả, DB ngẫu nhiên của task; API chỉ được SELECT hai bảng trạng thái.
// Local dùng PostgreSQL nhúng; native dùng đúng PG16 riêng và kiểm role sau cấp quyền.
export async function createResultSqlFixture(){
  const schema=`CREATE SCHEMA assessment;
    CREATE TABLE assessment.term_test_attempt(id uuid PRIMARY KEY,listening_submitted_at timestamptz,writing_submitted_at timestamptz);
    CREATE TABLE assessment.term_test_writing_grading_final(attempt_id uuid PRIMARY KEY,status text);`;
  if(!process.env.PRACTICE_FIXTURE_DATABASE_URL){
    const {PGlite}=await import('@electric-sql/pglite'),db=new PGlite();
    try{await db.exec(schema);return{db};}catch(error){await db.close();throw error;}
  }
  assert.equal(process.env.PRACTICE_FIXTURE_CONFIRM,'test-services-optimization-20261101');
  const url=new URL(process.env.PRACTICE_FIXTURE_DATABASE_URL);
  assert.equal(url.protocol,'postgres:');assert.equal(url.username,'fixture');assert.equal(url.password,'');
  assert.equal(url.pathname,'/postgres');assert.equal(url.search,'');assert.equal(url.hash,'');assert.match(url.hostname,/^tsto-practice-pg-[a-z0-9]+$/);
  const name='term_mini_k67_test_result_'+randomBytes(6).toString('hex');
  const admin=new pg.Pool({connectionString:url.href,max:1,connectionTimeoutMillis:5000,statement_timeout:10000});
  let owner,pool,created=false,closed=false;
  async function close(){
    if(closed)return;closed=true;
    try{await pool?.end();await owner?.end();if(created)await admin.query('DROP DATABASE '+name);}
    finally{await admin.end();}
    assert.equal(externalAttempts,0);console.log(JSON.stringify({event:'result_native_fixture_closed',database:name,appRole:'k67_app',serverVersion:160014,externalAttempts}));
  }
  try{
    assert.equal(Number((await admin.query('SHOW server_version_num')).rows[0].server_version_num),160014);
    await admin.query(`DO $$ BEGIN
      IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='k67_owner') THEN CREATE ROLE k67_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE; END IF;
      IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='k67_app') THEN CREATE ROLE k67_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE; END IF;
      END $$;ALTER ROLE k67_app SET default_transaction_read_only=on;`);
    await admin.query('CREATE DATABASE '+name+' OWNER k67_owner');created=true;
    const own=new URL(url);own.pathname='/'+name;own.username='k67_owner';owner=new pg.Pool({connectionString:own.href,max:1,connectionTimeoutMillis:5000,statement_timeout:10000});
    await owner.query(schema);
    await owner.query(`REVOKE ALL ON DATABASE ${name} FROM PUBLIC;GRANT CONNECT ON DATABASE ${name} TO k67_app;
      GRANT USAGE ON SCHEMA assessment TO k67_app;GRANT SELECT ON ALL TABLES IN SCHEMA assessment TO k67_app;`);
    const app=new URL(own);app.username='k67_app';pool=new pg.Pool({connectionString:app.href,max:2,connectionTimeoutMillis:5000,statement_timeout:4000});
    assert.deepEqual((await pool.query('SELECT current_user AS role,rolsuper,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user')).rows[0],{role:'k67_app',rolsuper:false,rolcreatedb:false,rolcreaterole:false});
    assert.equal((await pool.query('SHOW default_transaction_read_only')).rows[0].default_transaction_read_only,'on');
    const db={exec:sql=>owner.query(sql),query:(...args)=>owner.query(...args),close};
    return{db,pool};
  }catch(error){await close();throw error;}
}
