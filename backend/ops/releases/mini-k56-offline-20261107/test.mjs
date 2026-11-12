import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {mkdtemp,readFile,rmdir,unlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const runtime=process.env.MINI_RUNTIME_ROOT;
assert.ok(runtime);
const require=createRequire(process.env.TERM2_DEPS_PACKAGE);
const {PGlite}=require('@electric-sql/pglite');
const express=require('express');
const {schema,registerMiniOffline}=await import(pathToFileURL(runtime+'/src/mini-offline.mjs'));
const {createTermTestWritingGradingService}=await import(pathToFileURL(runtime+'/src/term-test-writing-grading.js'));
const slug='mini-test-k56';
const timing={listeningDurationSeconds:446,listeningReviewSeconds:0,readingDurationMinutes:25,writingDurationMinutes:15};
export async function fixture(mode,paper,{listeningInterruption=false,realtime=false,mountJournal,dropResponse,record=()=>{}}={}){
 const content={writing:{tasks:[{id:'task2',prompt:'Fixture prompt'}]}};
 const db=new PGlite(),pool={query:(...args)=>db.query(...args),connect:async()=>({query:(...args)=>db.query(...args),release(){}})};
 await db.exec(`CREATE SCHEMA assessment;
 CREATE TABLE assessment.term_test_attempt(id uuid PRIMARY KEY,test_slug text,exam_session_id uuid,generation int DEFAULT 0,
  attempt_mode text,exam_mode text,erp_course_class_id bigint DEFAULT 5601,erp_student_contact_id bigint DEFAULT 5602,
  writing_task_1 text DEFAULT '',writing_task_2 text DEFAULT '',superseded_at timestamptz,
  reading_started_at timestamptz,reading_deadline_at timestamptz,reading_submitted_at timestamptz,reading_draft jsonb,
  reading_draft_revision bigint DEFAULT 0,reading_draft_updated_at timestamptz,
  writing_started_at timestamptz,writing_deadline_at timestamptz,writing_submitted_at timestamptz,writing_draft_revision bigint DEFAULT 0,writing_draft_updated_at timestamptz,writing_updated_at timestamptz,
  listening_submitted_at timestamptz,listening_answers jsonb,listening_result jsonb,reading_answers jsonb,reading_result jsonb,combined_result jsonb,completed_at timestamptz,updated_at timestamptz);
 CREATE TABLE assessment.term_test_exam_session(id uuid PRIMARY KEY,generation int DEFAULT 0,
  listening_started_at timestamptz,listening_deadline_at timestamptz,listening_submitted_at timestamptz,listening_draft jsonb,
  listening_draft_revision bigint DEFAULT 0,listening_draft_updated_at timestamptz,updated_at timestamptz);
 CREATE TABLE assessment.k56_portal_field_dispatch(attempt_id uuid,field text,grade numeric,status text,PRIMARY KEY(attempt_id,field));
 CREATE TABLE assessment.term_test_writing_grading_run(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),attempt_id uuid,task_number int,grading_version int,run_key text,prompt_text text,prompt_image_url text,essay_text text,word_count int,
   status text,task_score numeric,result_json jsonb,completed_at timestamptz,UNIQUE(attempt_id,task_number,grading_version));
 CREATE TABLE assessment.term_test_writing_grading_final(attempt_id uuid PRIMARY KEY,grading_version int,task_1_run_id uuid,task_2_run_id uuid,task_1_score numeric,task_2_score numeric,writing_score numeric,status text,ready_at timestamptz);
 CREATE TABLE assessment.term_test_writing_grading_job(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),run_id uuid,job_type text,idempotency_key text UNIQUE,status text,max_attempts int,next_attempt_at timestamptz);
 `);
 await db.exec(schema);
 if(listeningInterruption){
  await db.exec(`ALTER TABLE assessment.term_test_attempt ADD CONSTRAINT term_test_attempt_writing_order_check CHECK (
   (writing_started_at IS NULL AND writing_updated_at IS NULL AND writing_submitted_at IS NULL) OR
   (completed_at IS NOT NULL AND writing_started_at IS NOT NULL AND writing_updated_at IS NOT NULL
    AND (writing_submitted_at IS NULL OR writing_submitted_at>=writing_started_at))); `);
  for(const name of ['listening-interruption.sql','listening-interruption-k56-phase2.sql']){
   await db.exec(await readFile(new URL('../term1-offline-20261107/'+name,import.meta.url),'utf8'));
  }
 }
 const a=randomUUID(),s=randomUUID(),student=randomUUID(),owner=randomUUID(),delivery=paper?'answer_sheet':'cbt';
 await db.query('INSERT INTO assessment.term_test_attempt(id,test_slug,exam_session_id,attempt_mode,exam_mode) VALUES($1,$2,$3,$4,$5)',[a,slug,s,delivery,mode]);
 await db.query('INSERT INTO assessment.term_test_exam_session(id) VALUES($1)',[s]);
 const definition=n=>({questions:Array.from({length:n},(_,i)=>({number:i+1,type:'completion',accepted:['A']}))});
 const load=async(client,testSlug,id)=>{
  assert.equal(testSlug,slug);
  const result=await client.query(`SELECT a.*,a.id::text AS attempt_token,a.exam_session_id::text AS exam_session_token,
  a.erp_course_class_id::text AS class_id,a.erp_student_contact_id::text AS student_id,s.generation AS session_generation,
  s.listening_started_at FROM assessment.term_test_attempt a JOIN assessment.term_test_exam_session s ON s.id=a.exam_session_id WHERE a.id=$1`,[id]);
  return {...result.rows[0],server_now:clock(),definition_version:1,test_title:'Fixture Mini',score_mode:'raw',
   listening_definition:definition(10),reading_definition:definition(13),listening_band_adjustment:0,mini_definition_snapshot:{content,timing}};
 };
 const transaction=async work=>{
  await db.query('BEGIN');
  try{const result=await work(pool);await db.query('COMMIT');return result;}
  catch(error){await db.query('ROLLBACK');throw error;}
 };
 const app=express(),router=express.Router(),grader=createTermTestWritingGradingService({pool});
 app.use(express.json());
 const journal=mountJournal?.(app,{pool,config:{allowedOrigins:[]}});
 if(dropResponse)app.use((req,res,next)=>{
  const json=res.json;
  res.json=function(body){
   if(dropResponse(req.body,body)){this.destroy();return this;}
   return json.call(this,body);
  };
  next();
 });
 app.use('/api/term-tests',router);
 app.use((error,_req,res,_next)=>res.status(500).json({ok:false,error:error.code||error.message}));
 let now=Date.now(),writingCalls=0;
 const clock=()=>new Date(realtime?Date.now():now).toISOString();
 const ensure=(task2)=>grader.ensureSubmission({attemptToken:a,testSlug:slug,task2,taskDefinitions:content.writing.tasks});
 const stop=registerMiniOffline(router,{pool,secret:'fixture-secret-do-not-use-in-production'.repeat(2),
  assets:{getSessionAudioKey:()=>Buffer.alloc(32)},load,transaction,
  prepare:async(testSlug,body)=>{
   if(body.studentRef!==student||body.attemptMode!==delivery||(paper&&!body.identityConfirmed))return null;
   return load(pool,testSlug,body.attemptToken);
  },
  serialize:row=>({ok:true,attemptToken:row.attempt_token,examSessionToken:row.exam_session_token,generation:0,examMode:mode,attemptMode:delivery}),
  resultFor:row=>({listening:row.listening_result,reading:row.reading_result}),limiter:(_req,_res,next)=>next(),
  record(...args){journal?.business(...args);record(...args);},
  onWriting:async row=>{writingCalls++;await ensure(row.writing_task_2);}});
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 const base='http://127.0.0.1:'+server.address().port+'/api/term-tests/'+slug;
 const scope={attemptToken:a,examSessionToken:s,generation:0,ownerId:owner};
 let permit='';
 const request=async(path,body)=>{
  const response=await fetch(`${base}/offline/${path}`,
   {method:'POST',headers:{'content-type':'application/json','x-term2-permit':permit},body:JSON.stringify(body)});
  return {status:response.status,...await response.json()};
 };
 const prepare=async(overrides={})=>{
  const result=await request('prepare',{...scope,classCode:'FIXTURE',studentRef:student,mode,attemptMode:delivery,identityConfirmed:true,...overrides});
  if(result.offline)permit=result.offline.permit;
  return result;
 };
 return {base,db,a,s,student,scope,request,prepare,ensure,load,pool,content,advance:ms=>{now+=ms;},clock,
  writingCalls:()=>writingCalls,close:async()=>{stop();await new Promise(resolve=>server.close(resolve));await db.close();}};
}

if(!process.env.K56_MINI_FIXTURE_IMPORT_ONLY){
test('Mini rollout separates modes and class scope; disabling keeps issued permits readable',async()=>{
 const folder=await mkdtemp(join(tmpdir(),'mini-k56-flags-'));
 const file=join(folder,'config.json');
 process.env.MINI_K56_OFFLINE_CONFIG_FILE=file;
 const write=value=>writeFile(file,JSON.stringify(value));
 const cbt=await fixture('lis_first',false),paper=await fixture('lis_first',true);
 try{
  await write({cbt:false,paper:true,classes:['OTHER']});
  assert.equal((await paper.prepare()).error,'OFFLINE_NEW_DISABLED');
  await write({cbt:false,paper:true,classes:['FIXTURE']});
  assert.equal((await cbt.prepare()).error,'OFFLINE_NEW_DISABLED');
  assert.equal((await paper.prepare()).status,200);
  await write({cbt:false,paper:false,classes:[]});
  const receipt=await paper.request('status',{...paper.scope,operationId:randomUUID()});
  assert.equal(receipt.status,200);
  assert.equal(receipt.persisted,false);
 }finally{
  delete process.env.MINI_K56_OFFLINE_CONFIG_FILE;
  await paper.close();await cbt.close();
  await unlink(file);await rmdir(folder);
 }
});

process.env.MINI_K56_CBT_OFFLINE_NEW='true';
process.env.MINI_K56_PAPER_OFFLINE_NEW='true';
if(process.env.K56_LISTENING_PHASE2==='1')for(const [mode,paper] of [['lis_first',false],['read_first',false],['lis_first',true]]){
 test(`Mini gián đoạn Listening ${mode} ${paper?'phiếu':'thi máy'}`,async()=>{
  const f=await fixture(mode,paper,{listeningInterruption:true});
  try{
   assert.equal((await f.prepare()).status,200);
   let dependency=null;
   async function operation(section,kind,startedAt=f.clock()){
    const minutes=section==='reading'?25:15;
    const deadlineAt=paper||section==='listening'?null:new Date(Date.parse(startedAt)+minutes*60000).toISOString();
    const data=kind==='interrupt'?{interruptionReason:'learner_cannot_hear'}:
     section==='writing'?{task2:''}:{answers:{'1':'A'}};
    const body={...f.scope,operationId:randomUUID(),section,kind,revision:0,occurredAt:f.clock(),dependency,
     payload:{startedAt,deadlineAt,timeValid:true,...data,...kind==='seal'?{reason:'manual'}:{}}};
    return {body,result:await f.request('operation',body)};
   }
   if(mode==='read_first'){
    const reading=await operation('reading','start');assert.equal(reading.result.receipt?.status,'accepted');
    const seal=await operation('reading','seal',reading.body.payload.startedAt);
    assert.equal(seal.result.receipt?.status,'accepted');dependency=seal.body.operationId;
   }
   const listening=await operation('listening','start');assert.equal(listening.result.receipt?.status,'accepted');
   const interrupted=await operation('listening','interrupt',listening.body.payload.startedAt);
   if(paper){assert.equal(interrupted.result.error,'OFFLINE_INVALID');return;}
   assert.equal(interrupted.result.receipt?.status,'accepted',JSON.stringify(interrupted.result));
   dependency=interrupted.body.operationId;
   for(const section of mode==='lis_first'?['reading','writing']:['writing']){
    const opened=await operation(section,'start');assert.equal(opened.result.receipt?.status,'accepted',JSON.stringify(opened.result));
    const sealed=await operation(section,'seal',opened.body.payload.startedAt);
    assert.equal(sealed.result.receipt?.status,'accepted',JSON.stringify(sealed.result));dependency=sealed.body.operationId;
   }
   const {rows:[row]}=await f.db.query('SELECT listening_interrupted_at,listening_submitted_at,listening_result FROM assessment.term_test_attempt');
   assert.ok(row.listening_interrupted_at);assert.equal(row.listening_submitted_at,null);assert.equal(row.listening_result,null);
   assert.deepEqual((await f.db.query("SELECT field FROM assessment.k56_portal_field_dispatch WHERE field='listening'")).rows,[]);
  }finally{await f.close();}
 });
}

for(const paper of [true,false])for(const mode of ['lis_first','read_first']){
 test(`Mini HTTP/SQL ${paper?'paper':'cbt'} ${mode}`,async()=>{
  const f=await fixture(mode,paper);
  try{
   assert.equal((await f.prepare({studentRef:randomUUID()})).status,403);
   assert.equal((await f.prepare({examSessionToken:randomUUID()})).status,403);
   const prepared=await f.prepare();assert.equal(prepared.status,200,JSON.stringify(prepared));
   assert.equal(Boolean(prepared.audioKey),!paper);
   assert.equal(Boolean(prepared.content),!paper);
   assert.equal((await f.prepare({ownerId:randomUUID()})).error,'OFFLINE_OWNER_CONFLICT');
   let dependency=null;
   const skills=mode==='lis_first'?['listening','reading']:['reading','listening'];
   const essay=mode==='lis_first'?' \t\n\u200b':'A nonblank Mini paragraph.';
   for(const section of [...skills,...paper?[]:['writing']]){
    const startedAt=f.clock();
    const mins=section==='reading'?25:15;
    const deadlineAt=paper||section==='listening'?null:new Date(Date.parse(startedAt)+mins*60000).toISOString();
    const base={...f.scope,section,dependency};
    const clock={startedAt,deadlineAt,timeValid:true};
    const start={...base,operationId:randomUUID(),kind:'start',revision:0,occurredAt:startedAt,
     payload:{...clock,...section==='writing'?{task2:''}:{answers:{}}}};
    const opened=await f.request('operation',start);assert.equal(opened.receipt?.status,'accepted',JSON.stringify(opened));
    if(!paper&&section==='listening'){
     f.advance(30000);
     const early=await f.request('operation',{...base,kind:'seal',operationId:randomUUID(),revision:1,occurredAt:f.clock(),
      payload:{...clock,answers:{'1':'A'},reason:'ended',audioEnded:false,heardSeconds:30}});
     assert.equal(early.receipt?.reason,'AUDIO_NOT_FINISHED');
     f.advance(416000);
    }else f.advance(paper?5000:mins*60000);
    const seal={...base,operationId:randomUUID(),kind:'seal',revision:1,occurredAt:f.clock(),
     payload:{...clock,...section==='writing'?{task2:essay}:{answers:{'1':'A'}},
      reason:paper?'manual':section==='listening'?'ended':'deadline',
      ...(!paper&&section==='listening'?{audioEnded:true,heardSeconds:446}:{})}};
    const saved=await f.request('operation',seal);assert.equal(saved.receipt?.status,'accepted',JSON.stringify(saved));
    assert.deepEqual((await f.request('status',{...f.scope,operationId:seal.operationId})).receipt,saved.receipt);
    assert.deepEqual((await f.request('operation',seal)).receipt,saved.receipt);
    if(section==='writing')assert.equal(Boolean(saved.receipt.writingBlank),mode==='lis_first');
    dependency=seal.operationId;
   }
   const row=(await f.db.query('SELECT * FROM assessment.term_test_attempt WHERE id=$1',[f.a])).rows[0];
   assert.equal(row.listening_result.correct,1);assert.equal(row.reading_result.correct,1);
   if(paper){
    assert.equal(row.reading_deadline_at,null);assert.equal(row.writing_submitted_at,null);
    const denied=await f.request('operation',{...f.scope,operationId:randomUUID(),section:'writing',kind:'start',revision:0,occurredAt:f.clock(),dependency,
     payload:{task2:'',startedAt:f.clock(),deadlineAt:null,timeValid:true}});
    assert.equal(denied.error,'MODE_CONFLICT');
   }else if(mode==='lis_first'){
    const status=await f.ensure('injected stale client text');
    assert.deepEqual(status,{status:'blank',ready:true,mode:'blank',taskStates:{task2:'blank'}});
    assert.equal(f.writingCalls(),0);
    assert.equal((await f.db.query('SELECT * FROM assessment.term_test_writing_grading_run')).rows.length,0);
   }else{
    assert.equal(row.writing_task_2,essay);
    const grading=(await f.db.query('SELECT essay_text FROM assessment.term_test_writing_grading_run')).rows;
    assert.deepEqual(grading,[{essay_text:essay}]);
   }
   assert.equal((await f.db.query('SELECT * FROM assessment.term_test_writing_grading_job')).rows.length,!paper&&mode==='read_first'?1:0);
   assert.deepEqual((await f.db.query('SELECT field FROM assessment.k56_portal_field_dispatch ORDER BY field')).rows,[{field:'listening'},{field:'reading'}]);
  }finally{await f.close();}
 });
}
}
