import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import {postgresFixture,publishedFixture} from '../../backend/test/learning-postgres-fixture.js';

const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,timeout=30000){const end=performance.now()+timeout;while(performance.now()<end){if(await check())return;await wait(20);}throw Error('SHARED_ENTRYPOINT_TIMEOUT');}
async function freePort(){const server=net.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}

export async function sharedSpeakingEntrypointContract({speakingPool,speakingDatabaseUrl,finishSecond}){
 assert.equal(process.platform,'linux');assert.equal(process.env.PRACTICE_FIXTURE_CONFIRM,'test-services-optimization-20261101');
 const learning=await postgresFixture({asApplication:true,studentCount:20});
 const children=new Set(),modes=[],secret='fixture-shared-attendance-secret-32-only',present=new Set();
 let portal,puts=0,requests=0,holding=false,releaseHold,holdTimer,appPool;
 const tableSnapshot=async(pool,tables)=>{
  const rows=[];for(const table of tables){assert.match(table,/^[a-z_]+\.[a-z_]+$/);rows.push([table,(await pool.query(`SELECT to_jsonb(t) AS value FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows]);}
  return rows;
 };
 const listenerCount=async()=>(await speakingPool.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND application_name='speaking_homework_work_listener'")).rows[0].n;
 try{
  await learning.pool.query("DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='learning_fixture_api') THEN CREATE ROLE learning_fixture_api LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;END IF;END $$;GRANT learning_api TO learning_fixture_api");
  const appUrl=new URL(learning.databaseUrl);appUrl.username='learning_fixture_api';appPool=new pg.Pool({connectionString:appUrl.href,max:1});
  assert.deepEqual((await appPool.query('SELECT current_user AS role,rolsuper,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user')).rows[0],{role:'learning_fixture_api',rolsuper:false,rolcreatedb:false,rolcreaterole:false});
  await assert.rejects(appPool.query('CREATE TABLE learning.forbidden_entrypoint_fixture(id integer)'),error=>error.code==='42501');
  portal=http.createServer(async(req,res)=>{
   try{
    assert.equal(req.url,'/portal');assert.equal(req.headers['x-learning-attendance-sync'],secret);
    let raw='';for await(const chunk of req){raw+=chunk;assert.ok(raw.length<65536);}const request=JSON.parse(raw);requests++;
    const target=String(request.targetSessionId||'35817'),key=request.studentId+':'+target;
    let status=present.has(key)?'already_present':'resolved';
    if(request.commit&&status==='resolved'){
     assert.equal(request.expectedScheduleFingerprint,'schedule-shared-fixture');puts++;present.add(key);status='synced';
     if(puts===20){holding=true;await new Promise(resolve=>{releaseHold=resolve;holdTimer=setTimeout(resolve,12000);});}
    }
    const value={ok:true,status,entityKey:request.entityKey,unitKey:request.unitKey,operationKey:request.operationKey,idempotencyKey:request.idempotencyKey,
     classId:request.classId,studentId:request.studentId,sessionNumber:request.sessionNumber,targetSessionId:target,resolvedSessionId:'35817',
     bindingRevision:request.bindingRevision??null,scheduleFingerprint:'schedule-shared-fixture',sessionDate:'2026-10-05'};
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(value));
   }catch(error){res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({ok:false,error:String(error.code||error.message)}));}
  });
  await new Promise(resolve=>portal.listen(0,'127.0.0.1',resolve));const portalUrl='http://127.0.0.1:'+portal.address().port+'/portal';
  const published=await publishedFixture(learning),block=published.assignment.definition.blocks[0],started=performance.now();
  const checkpoints=await Promise.all(published.inputs.map(input=>learning.service.submitCheckpoint({attemptToken:input.attemptToken,
   checkpointSubmissionId:crypto.randomUUID(),blockId:block.blockId,checkpoint:block.checkpoint,draftRevision:0,definitionHash:input.definitionHash,responses:{},idempotencyKey:crypto.randomUUID()})));
  const submitMs=performance.now()-started;assert.ok(submitMs<60000);assert.equal(checkpoints.length,20);assert.ok(checkpoints.every(row=>row.attendance?.portalSyncQueued===true));
  assert.equal((await learning.pool.query("SELECT count(*)::int n FROM learning.outbox_job WHERE job_type='sync_portal_attendance'")).rows[0].n,20);
  const learnerBefore=await tableSnapshot(learning.pool,['learning.checkpoint_submission','learning.response_item','learning.attendance_event','learning.submission']);
  async function launch(coordinated,enabled){
   const port=await freePort(),env={PATH:process.env.PATH,NODE_ENV:'production',PORT:String(port),AUTH_MODE:'legacy',LEGACY_REVIEW_TOKEN:'fixture-shared-legacy-review-token-32-only',
    DATABASE_URL:speakingDatabaseUrl,DB_POOL_MAX:'2',LEARNING_ENABLED:'true',LEARNING_DATABASE_URL:appUrl.href,LEARNING_DB_POOL_MAX:'8',
    LEARNING_TEST_K56_DATABASE_URL:appUrl.href,LEARNING_TEST_K67_DATABASE_URL:appUrl.href,
    ERP_SYNC_URL:portalUrl,ERP_SYNC_SECRET:secret,LEARNING_ATTENDANCE_SYNC_URL:portalUrl,LEARNING_ATTENDANCE_POLL_MS:'500',LEARNING_ATTENDANCE_SYNC_TIMEOUT_MS:'15000',
    SPEAKING_HOMEWORK_ENABLED:'true',SPEAKING_HOMEWORK_DATABASE_URL:speakingDatabaseUrl,SPEAKING_HOMEWORK_DB_POOL_MAX:'5',
    SPEAKING_HOMEWORK_WORKER_SECRET:'fixture-shared-speaking-worker-secret-32',SPEAKING_HOMEWORK_ACCESS_SECRET:'fixture-shared-speaking-access-secret-32',SPEAKING_PROGRESS_DOCS_ENABLED:'true',
    TEST_SERVICES_COORDINATOR_ENABLED:String(coordinated),WORKER_ENABLED:String(enabled)};
   const child=spawn(process.execPath,['--import',fileURLToPath(new URL('./shared-speaking-entrypoint-net-guard.mjs',import.meta.url)),fileURLToPath(new URL('../../backend/src/server.js',import.meta.url))],{env,stdio:['ignore','pipe','pipe']});children.add(child);
   let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
   const exit=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));let exited=false;void exit.then(()=>exited=true);
   const handle={child,exit,get output(){return output;},async stop(){
    if(!exited)child.kill('SIGTERM');const deadline=setTimeout(()=>{if(!exited)child.kill('SIGKILL');},30000);
    try{const result=await exit;assert.equal(result.code,0,output.slice(-1600));assert.equal(result.signal,null);assert.match(output,/"event":"shared_entrypoint_net_guard","externalAttempts":0/);children.delete(child);await until(async()=>await listenerCount()===0);return result;}
    finally{clearTimeout(deadline);}
   }};
   try{await until(async()=>{if(exited)throw Error('SHARED_ENTRYPOINT_EXITED:'+output.slice(-1600));try{return(await fetch('http://127.0.0.1:'+port+'/health')).ok;}catch{return false;}});await until(async()=>await listenerCount()===(coordinated?1:0));}
   catch(error){await handle.stop();throw error;}
   return handle;
  }
  for(const coordinated of [false,true]){
   const before=await tableSnapshot(speakingPool,['speaking_homework.outbox','speaking_homework.submission_link','speaking_homework.receipt']);
   const queued=(await learning.pool.query("SELECT id,status,attempt_count FROM learning.outbox_job WHERE job_type='sync_portal_attendance' ORDER BY id")).rows;
   const child=await launch(coordinated,false);await wait(1800);assert.equal(requests,0);assert.deepEqual(await tableSnapshot(speakingPool,['speaking_homework.outbox','speaking_homework.submission_link','speaking_homework.receipt']),before);
   assert.deepEqual((await learning.pool.query("SELECT id,status,attempt_count FROM learning.outbox_job WHERE job_type='sync_portal_attendance' ORDER BY id")).rows,queued);await child.stop();modes.push({coordinated,enabled:false,exitCode:0,queuesUnchanged:true,listenerClosed:true});
  }
  const businessBefore=await tableSnapshot(speakingPool,['speaking_homework.submission_link','speaking_homework.receipt','speaking_homework.submission']);
  const child=await launch(true,true);await until(()=>holding,90000);const stopStarted=performance.now();await child.stop();const drainMs=performance.now()-stopStarted;assert.ok(drainMs>=11000);
  assert.equal(puts,20);assert.equal(present.size,20);assert.equal((await learning.pool.query("SELECT count(*)::int n FROM learning.outbox_job WHERE job_type='sync_portal_attendance' AND status='complete'")).rows[0].n,20);
  assert.equal((await learning.pool.query("SELECT count(*)::int n FROM learning.portal_attendance_operation WHERE status IN ('synced','already_present') AND readback_at IS NOT NULL")).rows[0].n,20);
  assert.equal((await speakingPool.query("SELECT count(*)::int n FROM speaking_homework.outbox WHERE kind='grade_speaking' AND status='done'")).rows[0].n,1);
  assert.deepEqual(await tableSnapshot(speakingPool,['speaking_homework.submission_link','speaking_homework.receipt','speaking_homework.submission']),businessBefore);
  assert.deepEqual(await tableSnapshot(learning.pool,['learning.checkpoint_submission','learning.response_item','learning.attendance_event','learning.submission']),learnerBefore);
  modes.push({coordinated:true,enabled:true,exitCode:0,drainMs,portalSynced:20,listenerClosed:true});
  await finishSecond();const finalBusiness=await tableSnapshot(speakingPool,['speaking_homework.submission_link','speaking_homework.receipt','speaking_homework.submission']);
  const legacy=await launch(false,true);await until(async()=>(await speakingPool.query("SELECT count(*)::int n FROM speaking_homework.outbox WHERE kind='grade_speaking' AND status='done'")).rows[0].n===2);await legacy.stop();assert.equal(puts,20);assert.deepEqual(await tableSnapshot(speakingPool,['speaking_homework.submission_link','speaking_homework.receipt','speaking_homework.submission']),finalBusiness);
  modes.push({coordinated:false,enabled:true,exitCode:0,portalPutsUnchanged:true,listenerClosed:true});
  console.log(JSON.stringify({event:'shared_speaking_entrypoint',modes,checkpointSubmitMs:submitMs,checkpointCount:20,portalPuts:puts,realExternalCalls:0,authMode:'fixture-legacy; Google/session contract tested separately'}));
 }finally{
  clearTimeout(holdTimer);releaseHold?.();
  for(const child of children){if(child.exitCode===null){child.kill('SIGKILL');await new Promise(resolve=>child.once('exit',resolve));}}
  if(portal)await new Promise(resolve=>{portal.close(resolve);portal.closeAllConnections();});
  await appPool?.end();await learning.close();
 }
}
