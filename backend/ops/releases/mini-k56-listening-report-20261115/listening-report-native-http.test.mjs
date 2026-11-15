import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {cp,mkdtemp,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {assembleMiniReportOverlay} from './assemble-overlay.mjs';
import {miniListeningReportSchema} from './listening-report-queue.mjs';

const runtime=resolve(process.env.K56_RUNTIME_FIXTURE);
const transport=resolve(process.env.JOURNAL_TRANSPORT_FIXTURE);
const deps=resolve(process.env.SUBMIT_DEPS_PACKAGE);
const {PGlite}=createRequire(deps)('@electric-sql/pglite');
const express=createRequire(join(runtime,'package.json'))('express');
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQ1sAAAAASUVORK5CYII=';
const slug='mini-test-k56';
const pass=(_req,_res,next)=>next();

async function assemble() {
  const candidate=await mkdtemp(join(tmpdir(),'mini-k56-listening-native-'));
  const src=join(candidate,'src'), modules=join(src,'mini-listening-report');
  const outputDir=join(candidate,'overlay');
  await assembleMiniReportOverlay({sourceDir:join(runtime,'src'),transportDir:transport,outputDir});
  await cp(join(runtime,'src'),src,{recursive:true});
  await cp(join(outputDir,'src'),src,{recursive:true});
  await cp(join(runtime,'package.json'),join(candidate,'package.json'));
  await symlink(join(runtime,'node_modules'),join(candidate,'node_modules'),'junction');
  return {candidate,src,modules};
}

export async function miniNativeReportFixture(t,{authorized=false,generation=3}={}){
  const {candidate,src,modules}=await assemble();
  const {registerMiniOffline,schema}=await import(pathToFileURL(join(src,'mini-offline.mjs')));
  const {createTelegramAlertSender}=await import(pathToFileURL(join(modules,'telegram-alerts.mjs')));
  const {checkpointK56ListeningAudio}=await import(pathToFileURL(join(src,'k56-listening-audio-recovery.js')));
  const {issueMiniOnlineListeningReportGrant}=await import(pathToFileURL(join(modules,'listening-report-online.mjs')));
  const {k56OfflineObservation}=await import(pathToFileURL(join(src,'exam-journal-runtime/adapters/term-k56-offline.mjs')));
  const credentialFile=join(candidate,'synthetic-telegram.json');
  const chatId='-1001234567890';
  await writeFile(credentialFile,JSON.stringify({version:1,botToken:'123456789:'+('f'.repeat(32)),
    chatId,messageThreadId:111}),{mode:0o600});
  const provider=[];
  let releaseAuth;
  const authGate=new Promise(resolve=>{releaseAuth=resolve;});
  const send=createTelegramAlertSender({credentialFile,fetcher:async(url,req)=>{
    const method=new URL(url).pathname.split('/').at(-1);
    const reply=result=>new Response(JSON.stringify({ok:true,result}),{status:200});
    if(method==='getMe')return reply({is_bot:true});
    if(method==='getChat'){await authGate;return reply({id:Number(chatId)});}
    assert.equal(method,'sendPhoto');
    provider.push(req);
    return reply({chat:{id:Number(chatId)},message_id:48+provider.length});
  }});
  const db=new PGlite();
  const query=db.query.bind(db);
  const pool={query,connect:async()=>({async query(...args){
    const result=await query(...args);
    return {...result,rowCount:result.rows.length};
  },release(){}})};
  let server,stop;
  t.after(async()=>{
    releaseAuth();
    await stop?.();
    if(server)await new Promise(resolve=>server.close(resolve));
    await db.close();
  });
  await db.exec(`
    CREATE SCHEMA assessment;
    CREATE TABLE assessment.term_test_exam_session (id uuid PRIMARY KEY,generation bigint,test_slug text,
      superseded_at timestamptz,listening_started_at timestamptz,listening_deadline_at timestamptz,
      listening_submitted_at timestamptz,listening_draft jsonb,listening_draft_revision bigint,
      listening_draft_updated_at timestamptz,updated_at timestamptz,
      prepared_at timestamptz DEFAULT now(), attempt_id uuid, student_name_snapshot text,
      audio_state_revision int DEFAULT 0,listening_recovery_seconds int DEFAULT 0,
      listening_audio_checkpoint_seconds numeric DEFAULT 0,listening_audio_checkpoint_at timestamptz,
      listening_audio_interruption_id uuid,listening_audio_legacy_recovery_id uuid,listening_audio_owner_id uuid,
      listening_audio_interrupted_at timestamptz,listening_audio_interrupted_seconds numeric,listening_audio_state text);
    CREATE TABLE assessment.term_test_audio_recovery_receipt(session_id uuid,recovery_id uuid,granted_seconds int);
    CREATE TABLE assessment.term_test_attempt (id uuid PRIMARY KEY,exam_session_id uuid,generation bigint,
      test_slug text,attempt_mode text,exam_mode text,student_name_snapshot text,class_name_snapshot text,
      superseded_at timestamptz,listening_interrupted_at timestamptz,updated_at timestamptz);
    ${schema}
    ${miniListeningReportSchema}
  `);
  const [attemptToken,examSessionToken,ownerId,studentRef]=Array.from({length:4},()=>randomUUID());
  const scope={attemptToken,examSessionToken,ownerId,generation};
  await query('INSERT INTO assessment.term_test_exam_session(id,generation) VALUES ($1,$2)',[examSessionToken,generation]);
  await query("INSERT INTO assessment.term_test_attempt VALUES ($1,$2,$3,$4,'cbt','lis_first','Học viên giả','FIXTURE',NULL,NULL,NULL)",
    [attemptToken,examSessionToken,generation,slug]);
  const section={questions:[{number:1,type:'completion',accepted:['A']}]};
  const load=async(client,_slug,id)=>{
    const {rows:[row]}=await client.query(`
    SELECT a.*,a.id::text AS attempt_token,s.id::text AS exam_session_token,s.generation AS session_generation,
      a.attempt_mode AS session_attempt_mode,s.superseded_at AS session_superseded_at,s.listening_started_at,
      now() AS server_now
    FROM assessment.term_test_attempt a JOIN assessment.term_test_exam_session s ON s.id=a.exam_session_id
    WHERE a.id=$1`,[id]);
    return row&&{...row,test_title:'Mini K56 fixture',definition_version:1,
      listening_definition:section,reading_definition:section};
  };
  const transaction=work=>db.transaction(c=>work(c));
  const app=express(),router=express.Router();
  app.use(express.json({limit:'768kb'}));
  app.use('/api/term-tests',router);
  app.use((error,_req,res,_next)=>res.status(500).json({ok:false,error:error.code||error.message}));
  process.env.MINI_K56_CBT_OFFLINE_NEW='true';
  const secret='n'.repeat(40);
  const policyFile=join(candidate,'policy.json');
  const setReporting=enabled=>writeFile(policyFile,JSON.stringify({enabled}));
  await setReporting(true);
  const priorPolicy=process.env.MINI_K56_LISTENING_REPORT_POLICY_FILE;
  process.env.MINI_K56_LISTENING_REPORT_POLICY_FILE=policyFile;
  const log=[],content={listening:{sections:[]}};
  const timing={listeningDurationSeconds:445.544,listeningReviewSeconds:0,readingDurationMinutes:25,writingDurationMinutes:15};
  stop=registerMiniOffline(router,{pool,secret,assets:{
    getSessionAudioKey:()=>Buffer.alloc(32),getContent:()=>content,getTiming:()=>timing,
  },prepare:(_slug,b)=>load(pool,slug,b.attemptToken),load,transaction,serialize:row=>({
    ok:true,attemptToken:row.attempt_token,examSessionToken:row.exam_session_token,
    generation:Number(row.generation),examMode:row.exam_mode,nextSection:'listening',studentRef,
    studentName:row.student_name_snapshot,serverNow:row.server_now,attemptMode:'cbt',
  }),
  resultFor:()=>({}),limiter:pass,miniListeningReportSender:send,
  record:(name,product,token,details)=>{
    if(name==='mini_listening_report')log.push({token,...k56OfflineObservation(name,product,details)});
  }});
  if(priorPolicy===undefined)delete process.env.MINI_K56_LISTENING_REPORT_POLICY_FILE;
  else process.env.MINI_K56_LISTENING_REPORT_POLICY_FILE=priorPolicy;
  server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  const base=`http://127.0.0.1:${server.address().port}/api/term-tests/${slug}`;
  async function request(path,body,permit='') {
    const response=await fetch(base+path,{method:'POST',headers:{
      'content-type':'application/json','x-term2-permit':permit,
    },body:JSON.stringify(body)});
    return {status:response.status,body:await response.json()};
  }
  if(authorized){
    releaseAuth();
    for(let i=0;i<100&&!stop.listeningReportsEnabled();i++)await new Promise(resolve=>setTimeout(resolve,25));
    assert.equal(stop.listeningReportsEnabled(),true);
  }
  return {a:attemptToken,s:examSessionToken,student:studentRef,generation,scope,base,request,content,query,pool,
    log,releaseAuth,provider,secret,chatId,setReporting,checkpointK56ListeningAudio,issueMiniOnlineListeningReportGrant};
}

if(process.env.K56_NATIVE_REPORT_FIXTURE_ONLY!=='1')test('captured Mini native runtime accepts interruption and sends one scoped Telegram image through the HTTP route',async t=>{
  const f=await miniNativeReportFixture(t);
  const {scope,request,query,pool,log,releaseAuth,provider,secret,chatId,setReporting,
    checkpointK56ListeningAudio,issueMiniOnlineListeningReportGrant}=f;
  const {attemptToken,examSessionToken,ownerId}=scope;
  const studentRef=f.student;
  const prepareBody={...scope,classCode:'FIXTURE',studentRef,mode:'lis_first'};
  const first=await request('/offline/prepare',prepareBody);
  assert.equal(first.status,200,JSON.stringify(first));
  assert.equal(first.body.offline.listeningReportsEnabled,undefined);
  releaseAuth();
  let prepared;
  for(let i=0;i<40;i++){
    prepared=await request('/offline/prepare',prepareBody);
    if(prepared.body.offline?.listeningReportsEnabled)break;
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  assert.equal(prepared.body.offline.listeningReportsEnabled,true);
  const permit=prepared.body.offline.permit,reportedAt=new Date().toISOString();
  const operationId=randomUUID();
  const incident={...scope,operationId,reportedAt,positionSeconds:2,pngBase64:png,mode:'offline',
    audioHash:'93a3901c37fb37a8eb2ec989ef8d382810d4dc99e6b6506a8377fac68dc756ab'};
  await setReporting(false);
  const paused=await request('/offline/prepare',prepareBody);
  assert.equal(paused.body.offline.listeningReportsEnabled,undefined);
  assert.equal(paused.body.offline.permit,permit);
  assert.equal((await request('/listening/report',incident,permit)).body.error,'LISTENING_REPORT_PAUSED');
  await setReporting(true);
  assert.equal((await request('/listening/report',incident,permit)).status,403);
  const skeleton={...scope,section:'listening',occurredAt:reportedAt,dependency:null,revision:0};
  const timing={startedAt:reportedAt,deadlineAt:null,timeValid:true};
  const start=await request('/offline/operation',{...skeleton,operationId:randomUUID(),
    kind:'start',payload:{...timing,answers:{}}},permit);
  assert.equal(start.body.receipt?.status,'accepted',JSON.stringify(start));
  const interruption=await request('/offline/operation',{...skeleton,operationId,
    kind:'interrupt',payload:{...timing,interruptionReason:'learner_cannot_hear'}},permit);
  assert.equal(interruption.body.receipt?.status,'accepted',JSON.stringify(interruption));
  assert.equal((await request('/listening/report',{...incident,positionSeconds:20},permit)).status,400);
  assert.equal((await request('/listening/report',{...incident,ownerId:randomUUID()},permit)).status,403);
  const queued=await request('/listening/report',incident,permit);
  assert.equal(queued.status,202,JSON.stringify(queued));
  const replay=await request('/listening/report',incident,permit);
  assert.equal(replay.body.incidentId,queued.body.incidentId);
  let delivered;
  for(let i=0;i<70;i++){
    delivered=(await query('SELECT * FROM assessment.mini_k56_listening_report')).rows[0];
    if(delivered?.state==='sent')break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.equal(delivered?.state,'sent',JSON.stringify(delivered));
  assert.equal(delivered.photo_message_id,'49');
  assert.equal(delivered.png,null);
  assert.equal(delivered.caption,null);
  assert.deepEqual(log.find(row=>row.phase==='delivery'),{token:attemptToken,mini_k56OfflineVersion:1,
    operationId,incidentId:queued.body.incidentId,miniListeningReportVersion:1,
    phase:'delivery',reportStatus:'sent',generation:3});
  assert.equal(provider.length,1);
  const sent=provider[0].body;
  assert.ok(sent.includes(Buffer.from(png,'base64')));
  for(const value of [chatId,'Học viên giả','FIXTURE','111',queued.body.incidentId])
    assert.ok(sent.includes(Buffer.from(value)),value);
  for(const token of [attemptToken,examSessionToken,ownerId,permit])
    assert.ok(!sent.includes(Buffer.from(token)));

  const [onlineAttempt,onlineSession,onlineOwner,recoveryId]=Array.from({length:4},()=>randomUUID());
  await query(`INSERT INTO assessment.term_test_exam_session(id,generation,test_slug,attempt_id,listening_started_at,listening_deadline_at,
    listening_audio_owner_id,listening_audio_checkpoint_at) VALUES ($1,3,$2,$3,now()-interval '52 seconds',now()+interval '400 seconds',$4,now())`,
  [onlineSession,slug,onlineAttempt,onlineOwner]);
  await query("INSERT INTO assessment.term_test_attempt VALUES ($1,$2,3,$3,'cbt','lis_first','Học viên online','FIXTURE',NULL,NULL,NULL)",
    [onlineAttempt,onlineSession,slug]);
  const manualListeningReport={audioHash:incident.audioHash,positionSeconds:52,reportedAt:new Date().toISOString()};
  const progress={token:onlineSession,examSessionToken:onlineSession,slug,heardSeconds:52,state:'pause',
    recoveryId,audioStateRevision:0,generation:3,audioOwnerId:onlineOwner,listeningDurationSeconds:445.544};
  const checkpoint=await checkpointK56ListeningAudio(pool,progress);
  assert.equal(issueMiniOnlineListeningReportGrant(secret,progress,checkpoint),null);
  assert.equal(issueMiniOnlineListeningReportGrant(secret,{...progress,audioOwnerId:ownerId,manualListeningReport},checkpoint),null);
  const grant=issueMiniOnlineListeningReportGrant(secret,{...progress,manualListeningReport},checkpoint);
  assert.equal(grant.ownerId,onlineOwner);
  const {capability,...onlineScope}=grant;
  const onlineIncident={...onlineScope,...manualListeningReport,pngBase64:png,mode:'online'};
  assert.equal((await request('/listening/report',onlineIncident,permit)).status,403);
  assert.equal((await request('/listening/report',{...onlineIncident,positionSeconds:53},capability)).status,403);
  const acceptedOnline=await request('/listening/report',onlineIncident,capability);
  assert.equal(acceptedOnline.status,202,JSON.stringify(acceptedOnline));
  assert.notEqual(acceptedOnline.body.incidentId,queued.body.incidentId);
  await query('UPDATE assessment.term_test_exam_session SET listening_audio_owner_id=$2 WHERE id=$1',[onlineSession,ownerId]);
  assert.equal((await request('/listening/report',onlineIncident,capability)).status,403);
});
