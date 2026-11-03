import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {createDatabasePool} from '../../src/db.js';
import {loadConfig} from '../../src/config.js';
import {createApp} from '../../src/app.js';
import {profileForConfig} from '../../src/deployment-profile.js';

const ident=value=>{assert.equal(typeof value,'string');assert.ok(value&&!value.includes('\0'));return '"'+value.replaceAll('"','""')+'"';};
const table=row=>ident(row.schema)+'.'+ident(row.table);
const sha=raw=>createHash('sha256').update(raw).digest('hex');
const privilege=(value,allowed)=>{assert.ok(allowed.includes(value),value);return value;};

// Chỉ khôi phục cấu trúc trống vào PostgreSQL có marker của task. Vai trò ứng dụng
// nhận đúng quyền hiệu lực đã đọc từ K56; không mượn vai trò K67 hoặc quyền owner.
export async function createNativeK56ObservationFixture(){
 assert.equal(process.env.PRACTICE_FIXTURE_CONFIRM,'test-services-optimization-20261101');
 assert.equal(process.env.K56_OBSERVE_NATIVE_DIRECTORY,'/app/native/fixture-data/k56');
 const variant=process.env.K56_OBSERVE_NATIVE_VARIANT;assert.ok(['real','demo'].includes(variant));
 const base=new URL(process.env.PRACTICE_FIXTURE_DATABASE_URL);
 assert.equal(base.protocol,'postgres:');assert.equal(base.username,'fixture');assert.equal(base.password,'');assert.equal(base.pathname,'/postgres');
 assert.match(base.hostname,/^tsto-practice-pg-[a-z0-9]+$/);assert.equal(base.search,'');assert.equal(base.hash,'');
 const directory=process.env.K56_OBSERVE_NATIVE_DIRECTORY,manifest=JSON.parse(await readFile(directory+'/manifest.private.json','utf8'));
 const binding=manifest[variant],grants=JSON.parse(await readFile(directory+'/'+variant+'.grants.json','utf8'));
 assert.equal(binding.role,variant==='real'?'k56_shared_api':'k56_demo_runtime');assert.equal(grants.identity.role,binding.role);
 assert.deepEqual([grants.identity.attributes.superuser,grants.identity.attributes.createDb,grants.identity.attributes.createRole,grants.identity.attributes.bypassRls],[false,false,false,false]);
 const raw=await readFile(directory+'/'+variant+'.private.sql');assert.equal(sha(raw),binding.schemaSha256);
 const text=raw.toString('utf8'),meta=text.split(/\r?\n/).filter(line=>line.startsWith('\\'));
 assert.equal(meta.length,2);assert.match(meta[0],/^\\restrict [A-Za-z0-9]+$/);assert.equal(meta[1],meta[0].replace('\\restrict','\\unrestrict'));
 assert.equal(/CREATE SERVER|CREATE USER MAPPING|dblink|postgres_fdw|pg_net|http_post|http_get|COPY\s+.*PROGRAM/i.test(text),false);
 const sql=text.split(/\r?\n/).filter(line=>!line.startsWith('\\')).join('\n').replace(/^SET statement_timeout = 0;$/m,"SET statement_timeout = '15s';");
 const database='k56_observe_'+variant+'_'+randomBytes(6).toString('hex'),admin=new pg.Pool({connectionString:base.href,max:1,connectionTimeoutMillis:5000,statement_timeout:15000});
 let owner,seed,pool,app,created=false,closed=false;
 async function close(){
  if(closed)return;closed=true;
  try{
   await app?.locals.termTeacherObservation?.close();await pool?.end();await seed?.end();await owner?.end();
   if(created){assert.match(database,/^k56_observe_(?:real|demo)_[a-f0-9]{12}$/);await admin.query('DROP DATABASE '+ident(database));}
  }finally{await admin.end();}
  console.log(JSON.stringify({event:'k56_native_fixture_closed',variant,database,role:binding.role}));
 }
 try{
  assert.equal((await admin.query('SHOW server_version_num')).rows[0].server_version_num,'160014');
  const exists=await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[binding.role]);
  if(!exists.rowCount)await admin.query('CREATE ROLE '+ident(binding.role)+' LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS '+(grants.identity.attributes.inherit?'INHERIT':'NOINHERIT'));
  await admin.query('CREATE DATABASE '+ident(database));created=true;base.pathname='/'+database;
  owner=new pg.Pool({connectionString:base.href,max:1,connectionTimeoutMillis:5000,statement_timeout:15000});
  await owner.query(sql);
  const schemas=(await owner.query("SELECT nspname FROM pg_namespace WHERE nspname NOT IN ('pg_catalog','information_schema') AND nspname NOT LIKE 'pg_%'")).rows.map(row=>row.nspname);
  for(const schema of schemas){
   await owner.query('REVOKE ALL ON SCHEMA '+ident(schema)+' FROM PUBLIC');
   await owner.query('REVOKE ALL ON ALL TABLES IN SCHEMA '+ident(schema)+' FROM PUBLIC');
   await owner.query('REVOKE ALL ON ALL SEQUENCES IN SCHEMA '+ident(schema)+' FROM PUBLIC');
   await owner.query('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA '+ident(schema)+' FROM PUBLIC');
  }
  await owner.query('REVOKE ALL ON DATABASE '+ident(database)+' FROM PUBLIC');
  for(const row of grants.database)await owner.query('GRANT '+privilege(row.privilege,['CONNECT','CREATE','TEMPORARY'])+' ON DATABASE '+ident(database)+' TO '+ident(binding.role));
  for(const row of grants.schemas)await owner.query('GRANT '+privilege(row.privilege,['USAGE','CREATE'])+' ON SCHEMA '+ident(row.schema)+' TO '+ident(binding.role));
  for(const row of grants.tables)await owner.query('GRANT '+privilege(row.privilege,['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'])+' ON TABLE '+table(row)+' TO '+ident(binding.role));
  for(const row of grants.columns)await owner.query('GRANT '+privilege(row.privilege,['SELECT','INSERT','UPDATE','REFERENCES'])+' ('+ident(row.column)+') ON TABLE '+table(row)+' TO '+ident(binding.role));
  for(const row of grants.sequences)await owner.query('GRANT '+privilege(row.privilege,['USAGE','SELECT','UPDATE'])+' ON SEQUENCE '+ident(row.schema)+'.'+ident(row.sequence)+' TO '+ident(binding.role));
  for(const row of grants.routines){
   assert.equal(/[;\0\r\n]/.test(row.arguments),false);
   await owner.query('GRANT EXECUTE ON ROUTINE '+ident(row.schema)+'.'+ident(row.routine)+'('+row.arguments+') TO '+ident(binding.role));
  }
  const appUrl=new URL(base.href);appUrl.username=binding.role;
  const fixtureEnv={DATABASE_URL:appUrl.href,LEARNING_DATABASE_URL:appUrl.href,AUTH_MODE:'legacy',LEGACY_REVIEW_TOKEN:'fixture-only-key',
   DEPLOYMENT_PROFILE:variant==='real'?'k56-ic2264':'k56-demo',DEMO_ISOLATED_MODE:String(variant==='demo'),
   ALLOWED_ORIGINS:'https://fixture.invalid',DB_POOL_MAX:'5',K56_ROSTER_RECONCILE_ENABLED:'false'};
  process.env.DATABASE_URL=appUrl.href;
  const config=loadConfig(fixtureEnv);assert.equal(profileForConfig(config).name,variant==='real'?'k56-ic2264':'k56-demo');
  config.authMode='legacy';config.legacyReviewToken='fixture-only-key';config.allowedOrigins=new Set(['https://fixture.invalid']);config.trustProxyHops=0;
  pool=createDatabasePool(config);seed=createDatabasePool({...config,databaseUrl:base.href,dbPoolMax:1});
  assert.deepEqual((await pool.query('SELECT current_user AS role,current_database() AS db')).rows[0],{role:binding.role,db:database});
  assert.deepEqual((await pool.query('SELECT rolsuper,rolcreatedb,rolcreaterole,rolbypassrls,rolinherit FROM pg_roles WHERE rolname=current_user')).rows[0],
   {rolsuper:false,rolcreatedb:false,rolcreaterole:false,rolbypassrls:false,rolinherit:grants.identity.attributes.inherit});
  await seed.query("INSERT INTO mapping.classroom_course_mapping(erp_course_class_id,erp_class_name_snapshot,status) VALUES(1293,'IC2304','approved')");
  await seed.query(`INSERT INTO mapping.student_mapping_review(public_id,erp_course_class_id,erp_student_contact_id,erp_student_name_snapshot,status)
   VALUES('11111111-1111-4111-8111-111111111111',1293,900001,'Học viên mô phỏng','approved')`);
  const q={questions:[{number:1,accepted:['A']}]};
  await seed.query(`INSERT INTO assessment.test_definition(slug,title,version,listening_definition,reading_definition,is_active)
   VALUES('term-test-1-k56','Đề K56 mô phỏng',1,$1,$1,true)`,[JSON.stringify(q)]);
  for(const name of ['mapping.classroom_course_mapping','mapping.student_mapping_review','mapping.reviewer_account','mapping.reviewer_session',
   'mapping.reviewer_class_access','mapping.reviewer_class_assignment','assessment.test_definition','assessment.term_test_roster',
   'assessment.term_test_temporary_student','assessment.term_test_attempt','assessment.term_test_exam_session','assessment.mini_test_result',
   'assessment.term_test_writing_grading_run','assessment.term_test_writing_grading_final'])await seed.query('ANALYZE '+name);
  app=createApp({pool,config,syncErpGrades:async()=>{throw Error('K56_NATIVE_EXTERNAL_WRITE_DENIED');},
   verifyGoogleToken:async()=>{throw Error('K56_NATIVE_UNEXPECTED_GOOGLE');}});
  const db={query:(...args)=>seed.query(...args),exec:sql=>seed.query(sql),close};
  return{db,pool,app,config,variant,rawQuery:(...args)=>owner.query(...args),createApp};
 }catch(error){await close();throw error;}
}
