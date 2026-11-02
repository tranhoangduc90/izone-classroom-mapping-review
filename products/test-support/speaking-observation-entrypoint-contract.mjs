import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {speakingFixtureEntrypoint,speakingFixtureEntrypointSource} from './speaking-fixture-entrypoint.mjs';
import {speakingSourceScopeKey,speakingSourceScopes} from '../../backend/src/speaking-source-batch.js';

const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function within(promise,ms,label){let timer;try{return await Promise.race([promise,new Promise((_resolve,reject)=>{timer=setTimeout(()=>reject(Error(label)),ms);})]);}finally{clearTimeout(timer);}}
async function until(check){const end=performance.now()+20000;while(performance.now()<end){if(await check())return;await wait(25);}throw Error('OBSERVATION_CLI_READY_TIMEOUT');}
async function listen(server){await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return server.address().port;}
async function freePort(){const server=http.createServer(),port=await listen(server);await new Promise(resolve=>server.close(resolve));return port;}

// Hợp đồng nén native, chỉ có dữ liệu tổng hợp của fixture trong cùng process.
export async function speakingFixtureSourceBatch(f,inputs){
 const scopes=speakingSourceScopes(inputs),entries=[],rosters=new Map();
 const catalog=await f.source.context({assignmentCode:scopes[0].assignmentCode});
 for(const scope of scopes){const context=await f.source.context(scope);entries.push({key:speakingSourceScopeKey(scope),...scope,ok:true,template:context.template,...(context.scope?{scope:context.scope}:{})});
  if(context.scope)rosters.set(String(context.scope.class_id),{classId:String(context.scope.class_id),students:context.students||[],webStudents:context.selectionStudents||[],selectionStudents:context.selectionStudents||[],excludedStudents:context.excludedStudents||[]});}
 return{entries,classes:catalog.classes,exercises:catalog.exercises,rosters:[...rosters.values()]};
}
export async function openSpeakingObservationStream(url,body){
 const controller=new AbortController(),response=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:controller.signal});
 assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/text\/event-stream/);
 const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
 return{async state(predicate=()=>true,timeout=20000){return within((async()=>{while(true){
  const end=buffer.indexOf('\n\n');if(end>=0){const packet=buffer.slice(0,end);buffer=buffer.slice(end+2);
   const event=/^event: (.+)$/m.exec(packet)?.[1],raw=/^data: (.+)$/m.exec(packet)?.[1];
   if(event==='state'&&raw){const value=JSON.parse(raw);if(predicate(value))return value;}continue;}
  const chunk=await reader.read();if(chunk.done)throw Error('OBSERVATION_CLI_STREAM_EARLY_EOF');buffer+=decoder.decode(chunk.value,{stream:true});
 }})(),timeout,'OBSERVATION_CLI_STATE_TIMEOUT');},
  async eof(){while(!(await reader.read()).done){}},close(){controller.abort();void reader.cancel().catch(()=>{});}};
}

// Chỉ actualCLI trong database tsto được cấp riêng. Các mode producer luôn tắt
// AI và Docs writer; job mới phải còn pending qua SIGTERM và restart.
export async function speakingObservationEntrypointContract({service,fixture,identity,dbUrl,seedAccepted,mutation}){
 const independent=service==='speaking-independent';assert.ok(independent||service==='speaking-legacy');assert.equal(process.platform,'linux');
 const database=new URL(dbUrl);assert.equal(process.env.PRACTICE_FIXTURE_CONFIRM,'test-services-optimization-20261101');assert.match(database.hostname,/^tsto-practice-pg-[a-z0-9]+$/);
 assert.equal(database.username,'speaking_fixture_api');assert.match(database.pathname,independent?/^\/speaking_independent_fixture_[a-z0-9_]+$/:/^\/speaking_legacy_fixture_[a-z0-9_]+$/);
 const schema=independent?'speaking_independent':'speaking_homework',linkTable=independent?'link':'submission_link',jobTable=independent?'job':'check_job';
 const tables=independent?['work_unit','link','job','receipt','doc_progress']:['submission','submission_link','check_job','receipt','outbox','doc_progress'];
 const records=[];let f,source,child,childClosed,stream,output='';const secret='observation-cli-source-secret-at-least32';
 const snapshot=async()=>{const result={};for(const table of tables)result[table]=(await f.pool.query(`SELECT to_jsonb(t) AS value FROM ${schema}.${table} t ORDER BY to_jsonb(t)::text`)).rows;return result;};
 const listenerCount=async()=>Number((await f.pool.query('SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND application_name=$1',[schema+'_work_listener'])).rows[0].n);
 async function stop(){
  if(!child)return;const current=child,closed=childClosed;child=null;
  if(current.exitCode===null)current.kill('SIGTERM');
  try{const result=await within(closed,12000,'OBSERVATION_CLI_DRAIN_TIMEOUT');assert.equal(result.code,0,output.slice(-1600));assert.equal(result.signal,null);assert.match(output,/"event":"shared_entrypoint_net_guard","externalAttempts":0/);}
  catch(error){if(current.exitCode===null){current.kill('SIGKILL');await closed;}throw error;}
 }
 async function launch(observed,coordinated){
  const port=await freePort();output='';const env={PATH:process.env.PATH,NODE_ENV:'test',PORT:String(port),WORKER_ENABLED:'false',
   TEST_SERVICES_COORDINATOR_ENABLED:String(coordinated),TEST_SERVICES_OBSERVATION_ENABLED:String(observed),SPEAKING_PROGRESS_DOCS_ENABLED:'false',
   ...(independent?{INDEPENDENT_DATABASE_URL:dbUrl,INDEPENDENT_ACCESS_SECRET:'fixture-secret-32-characters-long-only',SPEAKING_SOURCE_URL:'http://127.0.0.1:'+source.address().port,SPEAKING_SOURCE_SECRET:secret}:
    {DATABASE_URL:dbUrl,DB_POOL_MAX:'2',AUTH_MODE:'legacy',LEGACY_REVIEW_TOKEN:'observation-cli-fixture-review-secret-32',LEARNING_ENABLED:'false',SPEAKING_HOMEWORK_ENABLED:'true',SPEAKING_HOMEWORK_DATABASE_URL:dbUrl,SPEAKING_HOMEWORK_DB_POOL_MAX:'4',SPEAKING_HOMEWORK_WORKER_SECRET:secret,SPEAKING_HOMEWORK_ACCESS_SECRET:'observation-cli-fixture-access-secret-32'})};
  child=spawn(process.execPath,['--import',fileURLToPath(new URL('./shared-speaking-entrypoint-net-guard.mjs',import.meta.url)),speakingFixtureEntrypoint(independent?'speaking-independent-server.js':'server.js')],{env,stdio:['ignore','pipe','pipe']});
  childClosed=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
  child.stdout.on('data',part=>output=(output+part).slice(-6000));child.stderr.on('data',part=>output=(output+part).slice(-6000));
  const origin='http://127.0.0.1:'+port;
  await until(async()=>{if(child.exitCode!==null)throw Error('OBSERVATION_CLI_EARLY_EXIT:'+output.slice(-1600));try{return(await fetch(origin+'/health',{signal:AbortSignal.timeout(500)})).ok;}catch{return false;}});
  await until(async()=>await listenerCount()===(coordinated?1:0));return origin+'/api/speaking-homework'+(independent?'-independent':'');
 }
 async function post(base,path,body){const response=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});return{response,value:await response.json()};}
 try{
  if(independent){source=http.createServer(async(req,res)=>{try{
   assert.equal(req.headers['x-speaking-worker-secret'],secret);let raw='';for await(const part of req){raw+=part;assert.ok(raw.length<65536);}const body=JSON.parse(raw);
   const value=req.url==='/internal/independent/context'?await f.source.context(body):req.url==='/internal/independent/contexts'?await speakingFixtureSourceBatch(f,body.scopes):null;
   assert.ok(value);res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({ok:true,...value}));
  }catch{res.writeHead(503,{'content-type':'application/json'}).end('{"ok":false,"error":"OBSERVATION_CLI_SOURCE_ERROR"}');}});await listen(source);}
  for(const mode of [{observed:false,coordinated:false},{observed:true,coordinated:false},{observed:true,coordinated:true}]){
   f=await fixture();const accepted=await seedAccepted(f),beforeAccepted=(await f.pool.query(`SELECT * FROM ${schema}.${linkTable} WHERE id=$1`,[accepted])).rows[0];
   assert.equal(beforeAccepted[independent?'status':'check_status'],'accepted');const who=identity(f),before=await snapshot(),base=await launch(mode.observed,mode.coordinated);
   const opened=await post(base,'/open',who);assert.equal(opened.response.status,200);assert.equal(opened.value.capabilities?.studentStateStream===true,mode.observed);
   assert.deepEqual(await snapshot(),before);
   if(!mode.observed){const response=await fetch(base+'/observation/student/status',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(who)});assert.equal(response.status,404);await response.arrayBuffer();}
   else{
    stream=await openSpeakingObservationStream(base+'/observation/student/events',who);const first=await stream.state();assert.equal(first.studentRef,who.studentRef);
    const started=performance.now(),queued=await post(base,'/checks/request',{...who,...mutation});assert.equal(queued.response.status,202);
    const linkId=queued.value.check.id||queued.value.check.linkId;assert.ok(linkId);const next=await stream.state(value=>value.contentRevision!==first.contentRevision,mode.coordinated?5000:20000);
    const elapsedMs=performance.now()-started;assert.equal(next.studentRef,who.studentRef);assert.equal(next.unitId,first.unitId);if(mode.coordinated)assert.ok(elapsedMs<10000);
    assert.deepEqual((await f.pool.query(`SELECT * FROM ${schema}.${linkTable} WHERE id=$1`,[accepted])).rows[0],beforeAccepted);
    const jobs=(await f.pool.query(`SELECT status,attempts FROM ${schema}.${jobTable} WHERE link_id=$1`,[linkId])).rows;assert.equal(jobs.length,1);assert.equal(jobs[0].status,'pending');assert.equal(Number(jobs[0].attempts),0);
    const committed=await snapshot(),eof=stream.eof();await stop();await within(eof,3000,'OBSERVATION_CLI_STREAM_NOT_DRAINED');stream.close();stream=null;
    assert.deepEqual(await snapshot(),committed);assert.equal(await listenerCount(),0);
    const restart=await launch(false,mode.coordinated),again=await post(restart,'/open',who);assert.equal(again.response.status,200);assert.equal(again.value.capabilities?.studentStateStream===true,false);assert.deepEqual(await snapshot(),committed);
    records.push({...mode,producerStatus:202,changedFrame:true,elapsedMs,oldAcceptedPreserved:true,pendingAttempts:0,streamDrained:true,restartPreserved:true});
   }
   await stop();assert.equal(await listenerCount(),0);if(!mode.observed){assert.deepEqual(await snapshot(),before);records.push({...mode,businessUnchanged:true,endpointStatus:404});}
   await f.db.close();f=null;
  }
  console.log(JSON.stringify({event:'speaking_observation_actual_entrypoint',service,entrypointSource:speakingFixtureEntrypointSource(),modes:records,realExternalCredentials:false,workersEnabled:false,docsWriterEnabled:false}));
 }finally{
  stream?.close();await stop();if(source){source.closeAllConnections();await new Promise(resolve=>source.close(resolve));}await f?.db.close();
 }
}
