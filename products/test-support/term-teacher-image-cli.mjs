import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdir} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';

// Chạy đúng server.js trong image ứng viên, trên DB giả riêng. Không gọi Google,
// AI, Portal hoặc tạo bài trên DB học viên; cookie giả dùng cùng đường xác thực native.
test('Term teacher physical image: native CLI, cookie authorization, compact/legacy reads, SSE and graceful shutdown',
 {timeout:90000},async t=>{
 assert.equal(process.env.PRACTICE_FIXTURE_CONFIRM,'test-services-optimization-20261101');
 assert.equal(process.env.SPEAKING_NATIVE_IMAGE_SOURCE_ROOT,'/app/src');
 const variant=process.env.TERM_IMAGE_VARIANT;assert.ok(['k67','real','demo'].includes(variant));
 const k67=variant==='k67';let f,child,stream;
 t.after(async()=>{await stream?.body.cancel().catch(()=>{});
  if(child&&child.exitCode===null){child.kill('SIGTERM');await Promise.race([new Promise(done=>child.once('exit',done)),delay(12000)]);if(child.exitCode===null)child.kill('SIGKILL');}
  await f?.db.close();});
 if(k67){
  const {createNativeOrderFixture}=await import('../term-mini-k67/test/helpers/native-exam-order-fixture.js');
  f=await createNativeOrderFixture({examOrder:true});
  const questions={questions:[{number:1,accepted:['A']}]};
  await f.db.query(`INSERT INTO assessment.test_definition(slug,title,version,listening_definition,reading_definition,is_active)
   VALUES('term-test-1','Đề CLI giả',1,$1,$1,true)`,[JSON.stringify(questions)]);
 }else{
  const {createNativeK56ObservationFixture}=await import('../../backend/test/helpers/k56-native-observation-fixture.mjs');
  f=await createNativeK56ObservationFixture();
 }
 const testSlug=k67?'term-test-1':'term-test-1-k56',ref='11111111-1111-4111-8111-111111111111';
 const email='teacher-cli@fixture.test',token='T'.repeat(43),subject='fixture-cli-subject',session='60000000-0000-4000-8000-000000000011';
 await f.db.query("INSERT INTO mapping.reviewer_account(email,google_subject,role,status) VALUES($1,$2,'teacher','active')",[email,subject]);
 await f.db.query('INSERT INTO mapping.reviewer_class_access(reviewer_email,erp_course_class_id) VALUES($1,1293)',[email]);
 await f.db.query(`INSERT INTO mapping.reviewer_session(token_hash,reviewer_email,google_subject,idle_expires_at,absolute_expires_at)
  VALUES($1,$2,$3,now()+interval '1 day',now()+interval '2 days')`,[createHash('sha256').update(token).digest(),email,subject]);
 await f.db.query(`INSERT INTO assessment.term_test_exam_session(id,test_slug,definition_version,erp_course_class_id,class_name_snapshot,
  erp_student_contact_id,student_name_snapshot,attempt_mode,listening_draft,listening_draft_updated_at)
  VALUES($1,$2,1,1293,'IC2304',900001,'Học viên CLI giả','cbt','{"1":"Nội dung đã lưu"}','2026-11-01T00:00:00Z')`,[session,testSlug]);
 const snapshot=async()=>({sessions:(await f.db.query('SELECT to_jsonb(s) AS value FROM assessment.term_test_exam_session s ORDER BY id')).rows,
  attempts:(await f.db.query('SELECT to_jsonb(a) AS value FROM assessment.term_test_attempt a ORDER BY id')).rows});
 const before=await snapshot(),dbUrl=k67?f.pool.options.connectionString:process.env.DATABASE_URL;
 const reservation=createServer();await new Promise(done=>reservation.listen(0,'127.0.0.1',done));const port=reservation.address().port;
 await new Promise(done=>reservation.close(done));const base='http://127.0.0.1:'+port;
 const env=Object.fromEntries(['PATH','HOME','LANG','TZ'].filter(key=>process.env[key]).map(key=>[key,process.env[key]]));
 Object.assign(env,{NODE_ENV:'test',EXAM_JOURNAL_ENABLED:'false'});
 if(k67){await mkdir('/tmp/tsto-term-cli-assets',{recursive:true});Object.assign(env,{
  K67_ENV:'test',K67_PORT:String(port),K67_DATABASE_URL:dbUrl,K67_DB_POOL_MAX:'5',K67_AUTH_MODE:'google',K67_GOOGLE_CLIENT_ID:'fixture-cli',
  K67_ALLOWED_ORIGINS:base,K67_TRUST_PROXY_HOPS:'0',K67_PUBLIC_API_BASE_URL:base+'/term-mini-k67-api',K67_ASSET_DIR:'/tmp/tsto-term-cli-assets',
  K67_SESSION_SECRET:'F'.repeat(32),K67_APP_VERSION:'fixture-cli',K67_BUILD_SHA:'1234567'
 });}else Object.assign(env,{PORT:String(port),DATABASE_URL:dbUrl,DB_POOL_MAX:'5',AUTH_MODE:'google',GOOGLE_CLIENT_ID:'fixture-cli',
  DEPLOYMENT_PROFILE:variant==='real'?'k56-ic2264':'k56-demo',DEMO_ISOLATED_MODE:String(variant==='demo'),
  ALLOWED_ORIGINS:base,TRUST_PROXY_HOPS:'0',K56_ROSTER_RECONCILE_ENABLED:'false'});
 let output='';child=spawn(process.execPath,['--import','/app/native/products/test-support/shared-speaking-entrypoint-net-guard.mjs','/app/src/server.js'],
  {cwd:'/app',env,stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',chunk=>output=(output+chunk).slice(-24000));child.stderr.on('data',chunk=>output=(output+chunk).slice(-24000));
 const exited=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});
 let ready=false;for(let i=0;i<160;i++){
  if(child.exitCode!==null)throw Error('TERM_IMAGE_CLI_EXITED_BEFORE_READY:'+output);
  try{const response=await fetch(base+'/health',{signal:AbortSignal.timeout(500)});ready=response.ok;await response.text();if(ready)break;}catch{}
  await delay(125);
 }
 assert.equal(ready,true,'native server must become ready: '+output);
 const headers={cookie:(k67?'izone_k67_teacher_session':'izone_teacher_session')+'='+token};
 const get=async(path,authorized=true)=>{const response=await fetch(base+path,{headers:authorized?headers:{},signal:AbortSignal.timeout(10000)});
  return{status:response.status,body:await response.json(),headers:response.headers};};
 const params=new URLSearchParams({class:'IC2304',test:testSlug,student:ref});
 assert.equal((await get('/api/term-tests/teacher/state?'+params,false)).status,401);
 const options=await get('/api/term-tests/teacher/options');assert.equal(options.status,200);
 assert.deepEqual(options.body.capabilities,{teacherStateVersion:1,teacherSavedProgressVersion:1});
 const state=await get('/api/term-tests/teacher/state?'+params);assert.equal(state.status,200);assert.equal(state.body.state.studentRef,ref);
 const legacy=await get('/api/term-tests/teacher/saved-progress?'+params),index=await get('/api/term-tests/teacher/saved-progress?'+params+'&mode=index');
 assert.equal(legacy.status,200);assert.equal(index.status,200);assert.match(index.headers.get('cache-control'),/no-store/);
 assert.equal(index.body.attempts.length,1);assert.equal(Object.hasOwn(index.body.attempts[0],'listening'),false);
 const detail=await get('/api/term-tests/teacher/saved-progress?'+params+'&mode=view&viewId='+index.body.attempts[0].viewId);
 assert.equal(detail.status,200);const {revision,...original}=detail.body.attempts[0];assert.match(revision,/^[a-f0-9]{32}$/);assert.deepEqual(original,legacy.body.attempts[0]);
 stream=await fetch(base+'/api/term-tests/teacher/state/stream?'+params,{headers,signal:AbortSignal.timeout(20000)});assert.equal(stream.status,200);
 const reader=stream.body.getReader();let frames='';while(!frames.includes('term-teacher-state-v1')){const part=await reader.read();assert.equal(part.done,false);frames+=new TextDecoder().decode(part.value);}
 assert.equal(frames.includes(token),false);assert.equal(frames.includes('Nội dung đã lưu'),false);
 await f.db.query("UPDATE mapping.reviewer_session SET revoked_at=now(),revoked_reason='fixture-cli-revoked' WHERE reviewer_email=$1",[email]);
 assert.equal((await get('/api/term-tests/teacher/state?'+params)).status,401);
 assert.equal((await get('/api/term-tests/teacher/saved-progress?'+params+'&mode=index')).status,401);
 assert.deepEqual(await snapshot(),before);
 child.kill('SIGTERM');const result=await Promise.race([exited,delay(12000).then(()=>{throw Error('TERM_IMAGE_CLI_SHUTDOWN_TIMEOUT');})]);
 assert.deepEqual(result,{code:0,signal:null});let ended=false;while(!ended)ended=(await reader.read()).done;reader.releaseLock();stream=null;
 assert.match(output,/"externalAttempts":0/);assert.equal(/"externalAttempts":[1-9]/.test(output),false);
 t.diagnostic(JSON.stringify({variant,physicalServer:'/app/src/server.js',nativeCookie:true,legacyAndCompact:true,sseShutdown:true,learnerRowsUnchanged:true,externalAttempts:0,googleTokenExchange:false}));
});
