// HTTP và SQL thật trên PGlite cách ly; thời gian giả, không gọi AI/Portal thật.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
const PRODUCT=1;
const taskId='task2',minutesR=25,minutesW=15,audioSeconds=446;
const runtime=process.env.TERM2_RUNTIME_ROOT;
assert.ok(runtime,'Cần TERM2_RUNTIME_ROOT trỏ source K56 đã ghép trong kho thử.');
const require=createRequire(process.env.TERM2_DEPS_PACKAGE||new URL('../../../package.json',import.meta.url));
const pgUrl=process.env.TERM2_TEST_PG_URL,express=require('express');
if(pgUrl){
 const u=new URL(pgUrl),local=u.hostname==='127.0.0.1'&&u.pathname==='/term1_fallback_race'
  &&u.username==='term1_fixture'&&u.searchParams.get('application_name')==='term1-fallback-race';
 assert.ok(local || pgUrl==='postgresql://k67_fixture_admin@127.0.0.1:55468/postgres', 'Local synthetic database only');
}
const {registerK56ExamOrder} = await import(pathToFileURL(runtime+'/src/k56-exam-order.js'));
const mod={...await import(pathToFileURL(runtime+'/src/mini-offline.mjs')),SLUG:'mini-test-k56'};
const blank=await import(pathToFileURL(runtime+`/src/term${PRODUCT}-blank.mjs`));const isBlank=blank.isBlank,storeTerm2Blank=blank[`storeTerm${PRODUCT}Blank`];
const {createTermTestWritingGradingService}=await import(pathToFileURL(runtime+'/src/term-test-writing-grading.js'));
export async function fixture(mode='lis_first',{writingFailures=0,receiptFailures=0,skipPrepare=false,realtime=false,defaultPolicy=false,listeningInterruption=false,beforeReceipt,dropResponse,record=()=>{}}={}){
 let db,pool,dispose;
 if(pgUrl){
  const {Pool}=require('pg'),raw=new Pool({connectionString:pgUrl,max:10}),schema='term2_fixture_'+randomUUID().replaceAll('-','');
  const rewrite=sql=>sql.replaceAll('term2_offline_',`term${PRODUCT}_offline_`).replace(/\b(assessment|mapping)\b/g,schema);
  const query=(target)=>(sql,...args)=>target.query(rewrite(sql),...args);
  db={query:query(raw),exec:query(raw)};
  pool={query:db.query,connect:async()=>{const c=await raw.connect();return {query:query(c),release:()=>c.release()};}};
  dispose=async()=>{await raw.query('DROP SCHEMA '+schema+' CASCADE');await raw.end();};
 }else{
  const {PGlite}=require('@electric-sql/pglite');db=new PGlite();
  const originalQuery=db.query.bind(db),originalExec=db.exec.bind(db),rewrite=sql=>sql.replaceAll('term2_offline_',`term${PRODUCT}_offline_`);db.query=(sql,...args)=>originalQuery(rewrite(sql),...args);db.exec=(sql,...args)=>originalExec(rewrite(sql),...args);
  pool={query:(...args)=>db.query(...args),connect:async()=>({query:(...args)=>db.query(...args),release(){}})};
  dispose=()=>db.close();
 }
 const a=randomUUID(),s=randomUUID(),owner=randomUUID(),student=randomUUID();let clock=Date.now(),calls=0,newEnabled=true;
 if(!pgUrl)await db.exec('CREATE SCHEMA mapping;');
 await db.exec(`CREATE SCHEMA assessment;
 CREATE TABLE assessment.term_test_attempt(id uuid PRIMARY KEY, test_slug text, exam_session_id uuid,generation int DEFAULT 0,attempt_mode text DEFAULT 'cbt',exam_mode text,
 superseded_at timestamptz,erp_course_class_id bigint DEFAULT 5601,erp_student_contact_id bigint DEFAULT 5602,writing_task_1 text DEFAULT '',writing_task_2 text DEFAULT '',
 reading_started_at timestamptz,reading_deadline_at timestamptz,reading_submitted_at timestamptz,reading_draft jsonb DEFAULT '{}',reading_draft_revision bigint DEFAULT 0,reading_draft_updated_at timestamptz,
 writing_started_at timestamptz,writing_deadline_at timestamptz,writing_submitted_at timestamptz,writing_draft_revision bigint DEFAULT 0,writing_draft_updated_at timestamptz,
 listening_submitted_at timestamptz,listening_answers jsonb,listening_result jsonb,reading_answers jsonb,reading_result jsonb,combined_result jsonb,completed_at timestamptz,updated_at timestamptz);
 CREATE TABLE assessment.term_test_exam_session(id uuid PRIMARY KEY,listening_started_at timestamptz,listening_deadline_at timestamptz,listening_submitted_at timestamptz,
 listening_draft jsonb DEFAULT '{}',listening_draft_revision bigint DEFAULT 0,listening_draft_updated_at timestamptz,updated_at timestamptz);
 CREATE TABLE assessment.k56_portal_field_dispatch(attempt_id uuid,field text,grade numeric,status text,PRIMARY KEY(attempt_id,field));
 CREATE TABLE assessment.term_test_writing_grading_run(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),attempt_id uuid,task_number int,grading_version int,run_key text,prompt_text text,prompt_image_url text,essay_text text,word_count int,
 status text,task_score numeric,result_json jsonb,completed_at timestamptz, UNIQUE(attempt_id,task_number,grading_version));
 CREATE TABLE assessment.term_test_writing_grading_final(attempt_id uuid PRIMARY KEY,grading_version int,task_1_run_id uuid,task_2_run_id uuid,task_1_score numeric,task_2_score numeric,writing_score numeric,status text,ready_at timestamptz);
 CREATE TABLE assessment.term_test_writing_grading_job(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),run_id uuid,job_type text,idempotency_key text UNIQUE,status text,max_attempts int,next_attempt_at timestamptz);
 `);
 if(listeningInterruption){
  // Mirror the live Writing constraint and timestamp bridge before applying the candidate migration.
  await db.exec(`ALTER TABLE assessment.term_test_attempt
    ADD COLUMN writing_updated_at timestamptz,
    ADD CONSTRAINT term_test_attempt_writing_order_check CHECK (
      (writing_started_at IS NULL AND writing_updated_at IS NULL AND writing_submitted_at IS NULL)
      OR (completed_at IS NOT NULL AND writing_started_at IS NOT NULL AND writing_updated_at IS NOT NULL
      AND (writing_submitted_at IS NULL OR writing_submitted_at >= writing_started_at))
    );
    CREATE FUNCTION assessment.fixture_sync_writing_timestamp() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.writing_updated_at IS NULL OR NEW.writing_updated_at < NEW.writing_draft_updated_at THEN
        NEW.writing_updated_at := NEW.writing_draft_updated_at;
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER fixture_sync_writing_timestamp BEFORE UPDATE OF writing_draft_updated_at
    ON assessment.term_test_attempt FOR EACH ROW WHEN (
      NEW.test_slug = 'term-test-1-k56' AND NEW.writing_started_at IS NOT NULL
      AND NEW.writing_draft_updated_at IS NOT NULL
      AND OLD.writing_draft_updated_at IS DISTINCT FROM NEW.writing_draft_updated_at
    ) EXECUTE FUNCTION assessment.fixture_sync_writing_timestamp();`);
  await db.exec(await readFile(new URL('../term1-offline-20261107/listening-interruption.sql',import.meta.url),'utf8'));
  // Mini uses Task 2 but the serving schema has the shared K56 interruption constraint.
  await db.exec(await readFile(new URL('../term1-offline-20261107/listening-interruption-k56-phase2.sql',import.meta.url),'utf8'));
 }
 await db.exec(`
  ALTER TABLE assessment.term_test_attempt ADD COLUMN definition_version int DEFAULT 1;
  ALTER TABLE assessment.term_test_exam_session
   ADD COLUMN test_slug text DEFAULT 'term-test-1-k56',
   ADD COLUMN definition_version int DEFAULT 1, ADD COLUMN attempt_mode text DEFAULT 'cbt',
   ADD COLUMN erp_course_class_id bigint DEFAULT 5601, ADD COLUMN erp_student_contact_id bigint DEFAULT 5602,
   ADD COLUMN generation bigint DEFAULT 0, ADD COLUMN superseded_at timestamptz;
  CREATE UNIQUE INDEX uq_term_test_exam_session_one_active_student ON assessment.term_test_exam_session
   (test_slug,definition_version,erp_course_class_id,erp_student_contact_id)
   WHERE listening_submitted_at IS NULL AND superseded_at IS NULL;
  CREATE UNIQUE INDEX uq_term_test_attempt_one_active_student ON assessment.term_test_attempt
   (test_slug,definition_version,erp_course_class_id,erp_student_contact_id)
   WHERE completed_at IS NULL AND superseded_at IS NULL;
 `);
 await db.exec(await readFile(new URL('../term2-k56-parallel-entry-20261117/parallel-attempts.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../term1-k56-parallel-entry-20261118/parallel-attempts.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../term1-k56-parallel-entry-20261118/term2-valid-submission-only.sql',import.meta.url),'utf8'));
 await db.exec(mod.schema);
 await db.query('INSERT INTO assessment.term_test_exam_session(id) VALUES($1)',[s]);
 await db.query('INSERT INTO assessment.term_test_attempt(id,test_slug,exam_session_id,exam_mode) VALUES($1,$2,$3,$4)',[a,mod.SLUG,s,mode]);
 const section={questions:Array.from({length:10},(_,i)=>({number:i+1,type:'completion',accepted:['A']}))};
 const readingSection={questions:Array.from({length:13},(_,i)=>({number:i+1,type:'completion',accepted:['A']}))};
 const content={baseTestSlug:mod.SLUG,writing:{tasks:[{id:taskId,prompt:'Fixture chart'}]},listening:{sections:[]},reading:{sections:[]}};
 const timing={listeningDurationSeconds:audioSeconds,listeningReviewSeconds:0,readingDurationMinutes:minutesR,writingDurationMinutes:minutesW};
 const load=async(client,slug,id,bySession=false,lock=false)=>{
  const row=(await client.query(`SELECT a.*,a.id::text AS attempt_token,a.exam_session_id::text AS exam_session_token,a.erp_course_class_id::text AS class_id,a.erp_student_contact_id::text AS student_id,
   s.listening_started_at,s.listening_deadline_at,s.listening_draft,s.listening_draft_revision FROM assessment.term_test_attempt a JOIN assessment.term_test_exam_session s ON s.id=a.exam_session_id
   WHERE a.${bySession?'exam_session_id':'id'}=$1 AND a.superseded_at IS NULL${lock?' FOR UPDATE OF a':''}`,[id])).rows[0];
  if(!row||row.test_slug!==slug)throw Object.assign(Error('not found'),{status:404,code:'ATTEMPT_NOT_FOUND'});
  return {...row,server_now:new Date(realtime?Date.now():clock).toISOString(),student_name:'Học viên giả',definition_version:1,test_title:'Mini K56 fixture',listening_definition:section,reading_definition:readingSection,listening_band_adjustment:0,
   mini_definition_snapshot:{content,timing},...(PRODUCT===1?{score_mode:'raw'}:{})};
 };
 const transaction=async work=>{const c=await pool.connect(),proxy={query:async(sql,...args)=>{
  if(sql.startsWith(`INSERT INTO assessment.term${PRODUCT}_offline_operation`)){
   if(receiptFailures-->0)throw Error('Fixture receipt insert failed');
   await beforeReceipt?.(args[0]);
  }
  return c.query(sql,...args);
 }};await c.query('BEGIN');try{const r=await work(proxy);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}};
 const app=express();
 app.use(express.json({limit:'1mb'}));
 if(dropResponse)app.use((request,response,next)=>{
  const send=response.json;
  response.json=function(body){
   if(dropResponse(request.body,body)){this.destroy();return this;}
   return send.call(this,body);
  };
  next();
 });
 const router=express.Router();
 const grading=createTermTestWritingGradingService({pool});
 const stop=process.env.K56_REAL_ROSTER_FIXTURE==='1'?()=>{}:mod[`registerTerm${PRODUCT}Offline`](router,{pool,secret:'x'.repeat(40),assets:{getSessionAudioKey:()=>Buffer.alloc(32)},prepare:async(slug,b)=>load(pool,slug,b.attemptToken),load,transaction,...(defaultPolicy?{}:{allowNew:()=>newEnabled}),
  serialize:x=>({ok:true,attemptToken:x.attempt_token,examSessionToken:x.exam_session_token,generation:0,examMode:x.exam_mode,studentName:'Học viên giả',serverNow:x.server_now}),
  resultFor:x=>({listening:x.listening_result,reading:x.reading_result}),limiter:(_q,_r,next)=>next(),record,
  onWriting:async row=>{calls++;if(writingFailures-->0)throw Error('Fixture crash after commit');await grading.ensureSubmission({attemptToken:row.attempt_token,testSlug:mod.SLUG,task1:PRODUCT===2?row.writing_task_1:'',task2:PRODUCT===1?row.writing_task_2:'',taskDefinitions:content.writing.tasks});}});
 app.use('/api/term-tests',router);
 if(process.env.K56_REAL_ROSTER_FIXTURE==='1'){
  await db.exec(`
   ALTER TABLE assessment.term_test_attempt
    ALTER COLUMN id SET DEFAULT gen_random_uuid(),
    ADD COLUMN client_submission_id uuid, ADD COLUMN class_name_snapshot text,
    ADD COLUMN student_name_snapshot text, ADD COLUMN created_at timestamptz DEFAULT now(),
    ADD COLUMN mini_definition_snapshot jsonb;
   ALTER TABLE assessment.term_test_exam_session
    ALTER COLUMN id SET DEFAULT gen_random_uuid(),
    ADD COLUMN class_name_snapshot text, ADD COLUMN student_name_snapshot text,
    ADD COLUMN prepared_at timestamptz DEFAULT now(), ADD COLUMN attempt_id uuid,
    ADD COLUMN listening_audio_checkpoint_seconds numeric DEFAULT 0;
   CREATE TABLE mapping.classroom_course_mapping(erp_course_class_id bigint,erp_class_name_snapshot text);
   CREATE TABLE mapping.student_mapping_review(erp_course_class_id bigint,erp_student_contact_id bigint,
     erp_student_name_snapshot text,public_id uuid,status text);
   CREATE TABLE assessment.term_test_class_access(test_slug text,erp_course_class_id bigint,enabled boolean);
   CREATE TABLE assessment.term_test_roster(test_slug text,erp_course_class_id bigint,erp_student_contact_id bigint,
     student_ref uuid,student_name_snapshot text,is_eligible boolean);
   CREATE TABLE assessment.term_test_temporary_student(test_slug text,erp_course_class_id bigint,temporary_student_id bigint,
     student_ref uuid,student_name_snapshot text,active boolean);
   CREATE TABLE assessment.test_definition(slug text,version int,title text,listening_definition jsonb,
     reading_definition jsonb,listening_band_adjustment numeric,is_active boolean);
   INSERT INTO mapping.classroom_course_mapping VALUES (5601,'FIXTURE');
   INSERT INTO assessment.term_test_class_access VALUES ('mini-test-k56',5601,true);
  `);
  await db.query('INSERT INTO assessment.term_test_roster VALUES ($1,5601,5602,$2,$3,true)',[mod.SLUG,student,'Học viên giả']);
  await db.query('INSERT INTO assessment.test_definition VALUES ($1,1,$2,$3::jsonb,$4::jsonb,0,true)',
   [mod.SLUG,'Đề giả',JSON.stringify(section),JSON.stringify(readingSection)]);
  registerK56ExamOrder(app,{pool,profile:{family:'k56'},assets:{getContent:async()=>content,getTiming:()=>timing,
   getSessionAudioKey:()=>Buffer.alloc(32)},limiter:(_q,_r,next)=>next(),onJournalEvent:record,
   secret:'x'.repeat(40),readPortalSyncStatus:async()=>null,requestPortalSync:async()=>{},onWriting:async row=>{calls++;await grading.ensureSubmission({attemptToken:row.attempt_token,
    testSlug:mod.SLUG,task1:PRODUCT===2?row.writing_task_1:'',task2:PRODUCT===1?row.writing_task_2:'',taskDefinitions:content.writing.tasks});}});
 }
 app.use((e,q,r,n)=>r.status(500).json({ok:false,error:e.code||e.message,message:e.message,constraint:e.constraint||null}));
 const server=app.listen(0,'127.0.0.1');await new Promise(ok=>server.once('listening',ok));const base=`http://127.0.0.1:${server.address().port}/api/term-tests/${mod.SLUG}`;
 let permit;
 const scope={attemptToken:a,examSessionToken:s,generation:0,ownerId:owner};
 async function request(path,body,override){const response=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json','x-term2-permit':override??permit??''},body:JSON.stringify(body)});return {status:response.status,...await response.json()};}
 clock=Date.now();if(!skipPrepare){const prepared=await request('/offline/prepare',{...scope,classCode:'FIXTURE',studentRef:student,mode});assert.equal(prepared.status,200,JSON.stringify(prepared));permit=prepared.offline.permit;}
 const newRun=async()=>{const next={attemptToken:randomUUID(),examSessionToken:randomUUID(),generation:0,ownerId:randomUUID()};
  await db.query('INSERT INTO assessment.term_test_exam_session(id) VALUES($1)',[next.examSessionToken]);
  await db.query('INSERT INTO assessment.term_test_attempt(id,test_slug,exam_session_id,exam_mode) VALUES($1,$2,$3,$4)',[next.attemptToken,mod.SLUG,next.examSessionToken,mode]);
  const p=await request('/offline/prepare',{...next,classCode:'FIXTURE',studentRef:randomUUID(),mode});assert.equal(p.status,200);return {scope:next,permit:p.offline.permit};};
 return {base,db,a,s,scope,student,request,grading,timing,content,load,pool,transaction,newRun,setEnrollment:value=>{newEnabled=value;},get clock(){return realtime?Date.now():clock;},advance:ms=>clock+=ms,get calls(){return calls;},close:async()=>{stop();await new Promise(ok=>server.close(ok));await dispose();}};
}
