// PostgreSQL 17 on this task's internal Docker network only. No production URLs or credentials are accepted.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {compactPulseContract} from './compact-pulse-contract.mjs';
import {workDispatchContract} from './work-dispatch-contract.mjs';
import {request,closeNativeHttp} from './native-http.mjs';
import {entrypointContract} from './practice-entrypoint-contract.mjs';
import {practiceObservationContract} from './practice-observation-contract.mjs';
import {practiceHistoryContract} from './practice-history-contract.mjs';
import {practiceStudentObservationContract} from './practice-student-observation-contract.mjs';
import {practiceFixtureModule} from './practice-fixture-source.mjs';
const require=createRequire(import.meta.url),pg=require('pg');
const nativeFetch=globalThis.fetch;let externalAttempts=0;
globalThis.fetch=(input,options)=>{const target=new URL(typeof input==='string'?input:input.url||input.href);if(!['127.0.0.1','localhost'].includes(target.hostname)){externalAttempts++;throw Error('EXTERNAL_FIXTURE_REQUEST_DENIED');}return nativeFetch(input,options);};
const task='test-services-optimization-20261101',url=new URL(process.env.PRACTICE_FIXTURE_DATABASE_URL||'http://invalid');
assert.equal(process.env.PRACTICE_FIXTURE_CONFIRM,task);assert.match(url.hostname,/^tsto-practice-pg-[a-z0-9]+$/);assert.equal(url.username,'fixture');assert.equal(url.pathname,'/postgres');
const endStates=[],poolUrls=new WeakMap();
async function nativePool(product,{entrypoint=false}={}){
 const schema=product+'_practice',name=entrypoint?schema+'_db':'tsto_practice_'+product+'_'+randomBytes(6).toString('hex'),role=schema+(entrypoint?'_app':'_fixture_app');
 const migrations=product==='reading'?['001-schema.sql','003-teacher-session.sql','004-shared-entry.sql','005-authored-time.sql']:['001-schema.sql','003-teacher-session.sql','004-authored-time.sql','005-shared-entry.sql'];
 // Validate all fixture DDL before opening a connection. Runtime images need not package migration tools.
 const migrationSql=await Promise.all(migrations.map(file=>readFile(new URL('../../fixtures/practice-migrations/'+product+'/'+file,import.meta.url),'utf8')));
 const admin=new pg.Pool({connectionString:url.href,max:1});let owner,app,created=false;
 try{
 const version=await admin.query('SHOW server_version_num');assert.ok(Number(version.rows[0].server_version_num)>=170000&&Number(version.rows[0].server_version_num)<180000);
 await admin.query('CREATE DATABASE '+name);created=true;const ownerUrl=new URL(url);ownerUrl.pathname='/'+name;owner=new pg.Pool({connectionString:ownerUrl.href,max:1});
 for(const sql of migrationSql)await owner.query(sql);
 await owner.query(`DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='${role}') THEN CREATE ROLE ${role} LOGIN; END IF; END $$;
  REVOKE ALL ON DATABASE ${name} FROM PUBLIC;GRANT CONNECT ON DATABASE ${name} TO ${role};GRANT USAGE ON SCHEMA ${schema} TO ${role};
  GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${role};GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO ${role};`);
 const appUrl=new URL(ownerUrl);appUrl.username=role;app=new pg.Pool({connectionString:appUrl.href,max:8,connectionTimeoutMillis:5000,statement_timeout:5000});
 const identity=(await app.query('SELECT current_user AS role,rolsuper,rolcreatedb FROM pg_roles WHERE rolname=current_user')).rows[0];assert.deepEqual(identity,{role,rolsuper:false,rolcreatedb:false});
 await assert.rejects(app.query(`CREATE TABLE ${schema}.forbidden_fixture(id integer)`),e=>e.code==='42501');
 let ended=false;const pool={query:(...args)=>app.query(...args),async connect(){const c=await app.connect();return{query:(...args)=>c.query(...args),release:()=>c.release()};},
  async end(){if(ended)return;ended=true;await app.end();await owner.end();if(entrypoint)assert.equal(name,product+'_practice_db');else assert.match(name,/^tsto_practice_(reading|listening)_[a-f0-9]{12}$/);await admin.query('DROP DATABASE '+name);await admin.end();endStates.push({database:name,role,closed:true});}};
 poolUrls.set(pool,appUrl.href);return pool;
 }catch(error){
  await app?.end();await owner?.end();
  try{if(created)await admin.query('DROP DATABASE '+name);}finally{await admin.end();}
  throw error;
 }
}
const modules={};
for(const product of ['reading','listening']){
 const module=name=>practiceFixtureModule(product,name,import.meta.url);
 const helpers=await import('../'+product+'-practice/test/helpers.js'),docs=await import(module('docs.js')),app=await import(module('app.js')),config=await import(module('config.js')),domain=await import(module('domain.js')),runtime=await import(module('test-work-runtime.js'));
 const stateRuntime=await import(module('test-state-runtime.js'));
 const fixtureFor=entrypoint=>async()=>{
  let allocated;const poolFactory=async()=>allocated=await nativePool(product,{entrypoint});
  try{return await(product==='reading'?helpers.fixture(undefined,{poolFactory}):helpers.fixture({poolFactory}));}
  catch(error){await allocated?.end();throw error;}
 };
 const fixture=fixtureFor(false);
 modules[product]={fixture,docs,runtime,domain};
 const label=product==='reading'?'Reading':'Listening';
 compactPulseContract({product:label,schema:product+'_practice',fixture,createApp:app.createApp,request,secret:domain.secret,uuid:domain.uuid});
 workDispatchContract({product:label,schema:product+'_practice',fixture,createDocsWorker:docs.createDocsWorker,registerWorkPublisher:runtime.registerWorkPublisher,readConfig:config.readConfig,uuid:domain.uuid,secret:domain.secret});
 practiceObservationContract({product:label,schema:product+'_practice',fixture,createApp:app.createApp,request,createHub:stateRuntime.createTestObservationHub,uuid:domain.uuid,secret:domain.secret});
 practiceHistoryContract({product:label,schema:product+'_practice',fixture,createApp:app.createApp,request,uuid:domain.uuid,secret:domain.secret});
 practiceStudentObservationContract({product:label,schema:product+'_practice',fixture,createApp:app.createApp,request,createHub:stateRuntime.createTestObservationHub,uuid:domain.uuid,secret:domain.secret,fail:domain.fail});
 const entryFixture=fixtureFor(true);
 entrypointContract({product,fixture:entryFixture,poolUrl:pool=>poolUrls.get(pool),uuid:domain.uuid});
}
const until=async fn=>{const end=Date.now()+10000;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,20));}throw Error('NATIVE_PEER_TIMEOUT');};
test('Native PG: competing batch claims skip locked bindings and never duplicate leases',{timeout:30000},async t=>{
 const {fixture,docs,domain}=modules.reading,f=await fixture();t.after(f.close);
 for(let n=0;n<5;n++){
  const id=domain.uuid();await f.pool.query(`INSERT INTO reading_practice.binding(id,assignment_id,student_ref,document_id,tab_id,entry_hash,owner_proof)
   SELECT $1,assignment_id,$2,$3,tab_id,$4,owner_proof FROM reading_practice.binding WHERE id=$5`,[id,domain.uuid(),'native_competing_document_'+n,domain.secret(),f.registered.bindingId]);
  await f.pool.query("INSERT INTO reading_practice.doc_job(id,binding_id,sequence,kind,payload) VALUES($1,$2,0,'cta','{}')",[domain.uuid(),id]);
 }
 const locked=await f.pool.connect();await locked.query('BEGIN');await locked.query('SELECT id FROM reading_practice.doc_job WHERE binding_id=$1 FOR UPDATE',[f.registered.bindingId]);
 try{
  const a=docs.createDocsWorker({pool:f.pool,docs:{}}),b=docs.createDocsWorker({pool:f.pool,docs:{}}),batches=await Promise.all([a.claim(4),b.claim(4)]),jobs=batches.flat();
  assert.equal(jobs.length,5);assert.equal(new Set(jobs.map(j=>j.id)).size,5);assert.equal(new Set(jobs.map(j=>j.leaseId)).size,5);assert.ok(jobs.every(j=>j.binding_id!==f.registered.bindingId));
 }finally{await locked.query('ROLLBACK');locked.release();}
});
test('Native PG: peer receives only committed hints, and reconnect reconciles a missed notification',{timeout:30000},async()=>{
 const {fixture,runtime,domain}=modules.listening,f=await fixture(),received=[],clientsA=[],clientsB=[];
 const make=clients=>()=>{const c=new pg.Client({connectionString:poolUrls.get(f.pool),connectionTimeoutMillis:5000});clients.push(c);return c;};
 const a=runtime.createWorkSignals({query:(...args)=>f.pool.query(...args),createClient:make(clientsA),channel:'listening_practice_work_v1',onWake(){}});
 const b=runtime.createWorkSignals({query:(...args)=>f.pool.query(...args),createClient:make(clientsB),channel:'listening_practice_work_v1',onWake:lane=>received.push(lane)});
 const detach=runtime.registerWorkPublisher(f.pool,lane=>a.publish(lane));
 try{
  await until(()=>a.snapshot().connected&&b.snapshot().connected);received.length=0;const start=await f.begin();await until(()=>b.snapshot().received===1);assert.deepEqual(received,['docs']);
  const before=b.snapshot().received,connect=f.pool.connect.bind(f.pool);let reject=true;
  f.pool.connect=async()=>{const c=await connect();return{...c,query:async(sql,args)=>{if(sql==='COMMIT'&&reject){reject=false;throw Error('SYNTHETIC_COMMIT_FAILURE');}return c.query(sql,args);}};};
  const input={token:f.token,operationId:domain.uuid(),attemptId:start.attempts[0].id,lease:start.lease,snapshot:f.draft(),method:'manual'};
  await assert.rejects(f.service.submit(input),/SYNTHETIC_COMMIT_FAILURE/);await new Promise(r=>setTimeout(r,100));assert.equal(b.snapshot().received,before);
  await clientsB.at(-1).end();await until(()=>!b.snapshot().connected);await f.service.submit(input);await until(()=>b.snapshot().connections>=2&&b.snapshot().connected);
  assert.ok(received.includes(undefined));assert.equal((await f.service.read({token:f.token})).attempts[0].status,'submitted');
 }finally{detach();await a.close();await b.close();await f.close();}
});
test.after(async()=>{await closeNativeHttp();assert.equal(externalAttempts,0);console.log(JSON.stringify({event:'practice_native_cleanup',closedDatabases:endStates.length,environment:'isolated-PostgreSQL17-non-DDL-app-role-pool8',externalAttempts}));});
