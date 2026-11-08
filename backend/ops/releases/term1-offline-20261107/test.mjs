// HTTP và SQL thật trên PGlite cách ly; thời gian giả, không gọi AI/Portal thật.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
const PRODUCT=Number(process.env.K56_TEST_PRODUCT||2);assert.ok([1,2].includes(PRODUCT));
const taskId=PRODUCT===1?'task2':'task1',minutesR=PRODUCT===1?40:60,minutesW=PRODUCT===1?55:30,audioSeconds=PRODUCT===1?1848:1824;
const runtime=process.env.TERM2_RUNTIME_ROOT;
assert.ok(runtime,'Cần TERM2_RUNTIME_ROOT trỏ source K56 đã ghép trong kho thử.');
const require=createRequire(process.env.TERM2_DEPS_PACKAGE||new URL('../../../package.json',import.meta.url));
const pgUrl=process.env.TERM2_TEST_PG_URL,express=require('express');
if(pgUrl){
 const u=new URL(pgUrl),local=u.hostname==='127.0.0.1'&&u.pathname==='/term1_fallback_race'
  &&u.username==='term1_fixture'&&u.searchParams.get('application_name')==='term1-fallback-race';
 if(!local){assert.equal(u.hostname,'izone-term1-fixture-pg-20261107');assert.equal(u.pathname,'/fixture');}
}
const mod=await import(pathToFileURL(runtime+`/src/term${PRODUCT}-offline.mjs`));
const blank=await import(pathToFileURL(runtime+`/src/term${PRODUCT}-blank.mjs`));const isBlank=blank.isBlank,storeTerm2Blank=blank[`storeTerm${PRODUCT}Blank`];
const {createTermTestWritingGradingService}=await import(pathToFileURL(runtime+'/src/term-test-writing-grading.js'));
export async function fixture(mode='lis_first',{writingFailures=0,receiptFailures=0,skipPrepare=false,realtime=false,defaultPolicy=false,beforeReceipt}={}){
 let db,pool,dispose;
 if(pgUrl){
  const {Pool}=require('pg'),raw=new Pool({connectionString:pgUrl,max:10}),schema='term2_fixture_'+randomUUID().replaceAll('-','');
  const rewrite=sql=>sql.replaceAll('term2_offline_',`term${PRODUCT}_offline_`).replace(/\bassessment\b/g,schema);
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
 await db.exec(mod.schema);
 await db.query('INSERT INTO assessment.term_test_attempt(id,test_slug,exam_session_id,exam_mode) VALUES($1,$2,$3,$4)',[a,mod.SLUG,s,mode]);
 await db.query('INSERT INTO assessment.term_test_exam_session(id) VALUES($1)',[s]);
 const section={questions:Array.from({length:40},(_,i)=>({number:i+1,type:'completion',accepted:['A']}))};
 if(PRODUCT===1)section.questions[31]={number:32,type:'completion',compound:{keys:['32a','32b'],accepted:{'32a':['A'],'32b':['B']}}};
 const readingSection=PRODUCT===1?{questions:section.questions.slice(0,26)}:section;
 const content={baseTestSlug:mod.SLUG,writing:{tasks:[{id:taskId,prompt:'Fixture chart'}]},listening:{sections:[]},reading:{sections:[]}};
 const timing={listeningDurationSeconds:audioSeconds,listeningReviewSeconds:0,readingDurationMinutes:minutesR,writingDurationMinutes:minutesW};
 const load=async(client,slug,id,bySession=false,lock=false)=>{
  const row=(await client.query(`SELECT a.*,a.id::text AS attempt_token,a.exam_session_id::text AS exam_session_token,a.erp_course_class_id::text AS class_id,a.erp_student_contact_id::text AS student_id,
   s.listening_started_at,s.listening_deadline_at,s.listening_draft,s.listening_draft_revision FROM assessment.term_test_attempt a JOIN assessment.term_test_exam_session s ON s.id=a.exam_session_id
   WHERE a.${bySession?'exam_session_id':'id'}=$1 AND a.superseded_at IS NULL${lock?' FOR UPDATE OF a':''}`,[id])).rows[0];
  if(!row||row.test_slug!==slug)throw Object.assign(Error('not found'),{status:404,code:'ATTEMPT_NOT_FOUND'});
  return {...row,server_now:new Date(realtime?Date.now():clock).toISOString(),student_name:'Học viên giả',definition_version:1,test_title:'Term 2 fixture',listening_definition:section,reading_definition:readingSection,listening_band_adjustment:0,
   mini_definition_snapshot:{content,timing},...(PRODUCT===1?{score_mode:'raw'}:{})};
 };
 const transaction=async work=>{const c=await pool.connect(),proxy={query:async(sql,...args)=>{
  if(sql.startsWith(`INSERT INTO assessment.term${PRODUCT}_offline_operation`)){
   if(receiptFailures-->0)throw Error('Fixture receipt insert failed');
   await beforeReceipt?.(args[0]);
  }
  return c.query(sql,...args);
 }};await c.query('BEGIN');try{const r=await work(proxy);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}};
 const app=express();app.use(express.json({limit:'1mb'}));const router=express.Router();
 const grading=createTermTestWritingGradingService({pool});
 const stop=mod[`registerTerm${PRODUCT}Offline`](router,{pool,secret:'x'.repeat(40),assets:{getSessionAudioKey:()=>Buffer.alloc(32)},prepare:async(slug,b)=>load(pool,slug,b.attemptToken),load,transaction,...(defaultPolicy?{}:{allowNew:()=>newEnabled}),
  serialize:x=>({ok:true,attemptToken:x.attempt_token,examSessionToken:x.exam_session_token,generation:0,examMode:mode,studentName:'Học viên giả',serverNow:x.server_now}),
  resultFor:x=>({listening:x.listening_result,reading:x.reading_result}),limiter:(_q,_r,next)=>next(),record(){},
  onWriting:async row=>{calls++;if(writingFailures-->0)throw Error('Fixture crash after commit');await grading.ensureSubmission({attemptToken:row.attempt_token,testSlug:mod.SLUG,task1:PRODUCT===2?row.writing_task_1:'',task2:PRODUCT===1?row.writing_task_2:'',taskDefinitions:content.writing.tasks});}});
 app.use('/api/term-tests',router);app.use((e,q,r,n)=>r.status(500).json({ok:false,error:e.code||e.message}));
 const server=app.listen(0,'127.0.0.1');await new Promise(ok=>server.once('listening',ok));const base=`http://127.0.0.1:${server.address().port}/api/term-tests/${mod.SLUG}`;
 let permit;
 const scope={attemptToken:a,examSessionToken:s,generation:0,ownerId:owner};
 async function request(path,body,override){const response=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json','x-term2-permit':override??permit??''},body:JSON.stringify(body)});return {status:response.status,...await response.json()};}
 clock=Date.now();if(!skipPrepare){const prepared=await request('/offline/prepare',{...scope,classCode:'FIXTURE',studentRef:student,mode});assert.equal(prepared.status,200,JSON.stringify(prepared));permit=prepared.offline.permit;}
 const newRun=async()=>{const next={attemptToken:randomUUID(),examSessionToken:randomUUID(),generation:0,ownerId:randomUUID()};
  await db.query('INSERT INTO assessment.term_test_attempt(id,test_slug,exam_session_id,exam_mode) VALUES($1,$2,$3,$4)',[next.attemptToken,mod.SLUG,next.examSessionToken,mode]);await db.query('INSERT INTO assessment.term_test_exam_session(id) VALUES($1)',[next.examSessionToken]);
  const p=await request('/offline/prepare',{...next,classCode:'FIXTURE',studentRef:randomUUID(),mode});assert.equal(p.status,200);return {scope:next,permit:p.offline.permit};};
 return {base,db,a,s,scope,request,grading,timing,content,load,pool,transaction,newRun,setEnrollment:value=>{newEnabled=value;},get clock(){return realtime?Date.now():clock;},advance:ms=>clock+=ms,get calls(){return calls;},close:async()=>{stop();await new Promise(ok=>server.close(ok));await dispose();}};
}
export function op(f,section,kind,{dependency=null,startedAt=new Date(f.clock).toISOString(),revision=0,reason='manual',task1='',audioEnded=false,heardSeconds=0,timeValid=true}={}){
 const minutes=section==='reading'?minutesR:minutesW;
 return {...f.scope,operationId:randomUUID(),section,kind,revision,occurredAt:new Date(f.clock).toISOString(),dependency,
 payload:{startedAt,deadlineAt:section==='listening'?null:new Date(Date.parse(startedAt)+minutes*60000).toISOString(),timeValid,
 ...(section==='writing'?{[taskId]:task1}:{answers:{'1':'A'}}),...(kind==='seal'?{reason}:{}),...(section==='listening'&&kind==='seal'?{audioEnded,heardSeconds}:{})}};
}
if(!process.env.TERM2_FIXTURE_IMPORT_ONLY){
for(const mode of ['lis_first','read_first'])test('HTTP/SQL: trọn '+mode+', receipt và điểm 0 không gọi AI',async()=>{
 const f=await fixture(mode);try{let dependency=null;
 for(const skill of mode==='read_first'?['reading','listening','writing']:['listening','reading','writing']){
  const start=op(f,skill,'start',{dependency});let r=await f.request('/offline/operation',start);assert.equal(r.receipt?.status,'accepted',JSON.stringify(r));
  f.advance(skill==='listening'?audioSeconds*1000:skill==='reading'?minutesR*60000:minutesW*60000);
  const seal=op(f,skill,'seal',{dependency,startedAt:start.payload.startedAt,reason:skill==='listening'?'ended':'deadline',audioEnded:true,heardSeconds:audioSeconds});
  r=await f.request('/offline/operation',seal);assert.equal(r.receipt?.status,'accepted',JSON.stringify(r));assert.equal(r.receipt.payloadHash,mod.digest(seal));
  const again=await f.request('/offline/operation',seal);assert.deepEqual(again.receipt,r.receipt);
  const status=await f.request('/offline/status',{...f.scope,operationId:seal.operationId});assert.deepEqual(status.receipt,r.receipt);
  assert.equal((await f.request('/offline/operation',{...seal,revision:1})).error,'OPERATION_CONFLICT');dependency=seal.operationId;
 }
 const result=(await f.db.query('SELECT writing_score,status FROM assessment.term_test_writing_grading_final')).rows[0];assert.equal(Number(result.writing_score),0);assert.equal(result.status,'ready');
 assert.equal((await f.db.query('SELECT * FROM assessment.term_test_writing_grading_job')).rows.length,0);
 const scores=(await f.db.query('SELECT field,grade FROM assessment.k56_portal_field_dispatch ORDER BY field')).rows;assert.deepEqual(scores.map(x=>[x.field,Number(x.grade)]),[['listening',1],['reading',1],['writing',0]]);
 assert.ok(f.calls>=1);
 }finally{await f.close();}
});
test('Không tự công nhận audio chưa hết; giữ payload để đối soát',async()=>{const f=await fixture();try{
 const start=op(f,'listening','start');await f.request('/offline/operation',start);f.advance(40000);
 const premature=op(f,'listening','seal',{startedAt:start.payload.startedAt,reason:'deadline',heardSeconds:40});
 const r=await f.request('/offline/operation',premature);assert.equal(r.receipt.reason,'AUDIO_NOT_FINISHED');
 assert.equal((await f.load(f.pool,mod.SLUG,f.a)).listening_submitted_at,null);
 assert.equal((await f.db.query('SELECT * FROM assessment.term2_offline_operation')).rows.length,2);
 }finally{await f.close();}});
test('Sai quyền/generation/dependency không ghi bài; payload thiếu không thành điểm 0',async()=>{const f=await fixture();try{
 const first=op(f,'listening','start');assert.equal((await f.request('/offline/operation',first,'invalid')).status,403);
 assert.equal((await f.request('/offline/operation',{...first,generation:1})).status,403);
 assert.equal((await f.request('/offline/operation',op(f,'reading','start'))).error,'OFFLINE_DEPENDENCY');
 const malformed=op(f,'writing','seal');delete malformed.payload[taskId];assert.equal((await f.request('/offline/operation',malformed)).status,409);
 assert.equal((await f.db.query('SELECT * FROM assessment.term_test_writing_grading_final')).rows.length,0);
 }finally{await f.close();}});
test('Ngoài 24 giờ hoặc mất chứng cứ giờ giữ dữ liệu và chưa tự chấm',async()=>{const f=await fixture();try{
 const start=op(f,'listening','start');await f.request('/offline/operation',start);const seal=op(f,'listening','seal',{startedAt:start.payload.startedAt,reason:'manual'});f.advance(86400001);
 assert.equal((await f.request('/offline/operation',seal)).receipt.status,'review_required');
 assert.equal((await f.load(f.pool,mod.SLUG,f.a)).listening_submitted_at,null);
 }finally{await f.close();}});
test('Định nghĩa trống không gom field thiếu hoặc bài ngắn có nội dung',()=>{for(const x of ['', ' \n\t', '\u00a0\u200b'])assert.equal(isBlank(x),true);for(const x of [undefined,null,{},'A','...'])assert.equal(isBlank(x),false);});
for(const task1 of [' \t\n\u00a0','\u200b\u200d\u00ad\u2060'])test('Canonical trắng Unicode nhận 0, không có job dispatch '+JSON.stringify(task1),async()=>{
 const f=await fixture();try{let dependency=null;for(const section of ['listening','reading','writing']){
 const start=op(f,section,'start',{dependency});await f.request('/offline/operation',start);const seal=op(f,section,'seal',{dependency,startedAt:start.payload.startedAt,task1});assert.equal((await f.request('/offline/operation',seal)).receipt.status,'accepted');dependency=seal.operationId;}
 assert.equal(Number((await f.db.query('SELECT writing_score FROM assessment.term_test_writing_grading_final')).rows[0].writing_score),0);assert.equal((await f.db.query('SELECT * FROM assessment.term_test_writing_grading_job')).rows.length,0);
 assert.equal((await f.db.query(`SELECT writing_task_${PRODUCT===1?2:1} AS essay FROM assessment.term_test_attempt`)).rows[0].essay,task1);
 }finally{await f.close();}
});
test('Thiếu field Task 1 trên đúng thứ tự không bị diễn giải thành bài trắng',async()=>{
 const f=await fixture();try{let dependency=null;for(const section of ['listening','reading']){const start=op(f,section,'start',{dependency});await f.request('/offline/operation',start);const seal=op(f,section,'seal',{dependency,startedAt:start.payload.startedAt});await f.request('/offline/operation',seal);dependency=seal.operationId;}
 const start=op(f,'writing','start',{dependency});await f.request('/offline/operation',start);const missing=op(f,'writing','seal',{dependency,startedAt:start.payload.startedAt});delete missing.payload[taskId];
 assert.equal((await f.request('/offline/operation',missing)).error,'OFFLINE_WRITING_REQUIRED');assert.equal((await f.load(f.pool,mod.SLUG,f.a)).writing_submitted_at,null);assert.equal((await f.db.query('SELECT * FROM assessment.term_test_writing_grading_run')).rows.length,0);
 }finally{await f.close();}
});
test('Biên 24 giờ chỉ dành cho truyền bài; hạn/đồng hồ sai chuyển đối soát',()=>{
 const start=Date.parse('2026-11-06T00:00:00.000Z'),run={prepared_at:new Date(start).toISOString()},timing={readingDurationMinutes:60,writingDurationMinutes:30,listeningDurationSeconds:1824};
 const a={server_now:new Date(start+3600000+86400000).toISOString()},b={section:'reading',kind:'seal',occurredAt:new Date(start+3600000).toISOString(),payload:{startedAt:new Date(start).toISOString(),deadlineAt:new Date(start+3600000).toISOString(),timeValid:true}};
 assert.equal(mod.validateTimeline(b,run,a,timing),null);assert.equal(mod.validateTimeline(b,run,{server_now:new Date(Date.parse(a.server_now)+1).toISOString()},timing),'OFFLINE_WINDOW_REVIEW_REQUIRED');
 assert.equal(mod.validateTimeline({...b,payload:{...b.payload,timeValid:false}},run,a,timing),'TIME_REVIEW_REQUIRED');
 assert.equal(mod.validateTimeline({...b,payload:{...b.payload,deadlineAt:new Date(start+3600001).toISOString()}},run,a,timing),'TIME_REVIEW_REQUIRED');
});
test('Ngừng cấp v2 vẫn nhận/đọc pending v2 đã cấp; không xóa dữ liệu khi quay giao diện',async()=>{
 const f=await fixture();try{f.setEnrollment(false);const start=op(f,'listening','start');const r=await f.request('/offline/operation',start);assert.equal(r.receipt.status,'accepted');
 assert.equal((await f.request('/offline/status',{...f.scope,operationId:start.operationId})).persisted,true);
 const next={attemptToken:randomUUID(),examSessionToken:randomUUID(),generation:0,ownerId:randomUUID()};await f.db.query('INSERT INTO assessment.term_test_attempt(id,test_slug,exam_session_id,exam_mode) VALUES($1,$2,$3,$4)',[next.attemptToken,mod.SLUG,next.examSessionToken,'lis_first']);await f.db.query('INSERT INTO assessment.term_test_exam_session(id) VALUES($1)',[next.examSessionToken]);
 assert.equal((await f.request('/offline/prepare',{...next,classCode:'FIXTURE',studentRef:randomUUID(),mode:'lis_first'})).error,'OFFLINE_NEW_DISABLED');
 assert.equal((await f.db.query('SELECT * FROM assessment.term2_offline_run')).rows.length,1);
 }finally{await f.close();}
});
test('Receipt lỗi phải rollback cả bài, điểm và outbox; retry cùng operation được nhận một lần',async()=>{
 const f=await fixture('lis_first',{receiptFailures:1});try{const start=op(f,'listening','start');assert.equal((await f.request('/offline/operation',start)).status,500);
 assert.equal((await f.load(f.pool,mod.SLUG,f.a)).listening_started_at,null);assert.equal((await f.db.query('SELECT * FROM assessment.term2_offline_operation')).rows.length,0);
 assert.equal((await f.request('/offline/operation',start)).receipt.status,'accepted');
 }finally{await f.close();}
});
test('Cùng revision khác nội dung và session generation cũ không đè canonical',async()=>{
 const f=await fixture();try{const start=op(f,'listening','start');await f.request('/offline/operation',start);
 const draft=op(f,'listening','draft',{startedAt:start.payload.startedAt,revision:1});await f.request('/offline/operation',draft);
 const conflict=structuredClone(draft);conflict.operationId=randomUUID();conflict.payload.answers['1']='B';assert.equal((await f.request('/offline/operation',conflict)).error,'OFFLINE_REVISION_CONFLICT');
 await f.db.query('UPDATE assessment.term_test_attempt SET generation=1');assert.equal((await f.request('/offline/status',{...f.scope,operationId:draft.operationId})).status,403);
 assert.equal((await f.load(f.pool,mod.SLUG,f.a)).listening_draft['1'],'A');
 }finally{await f.close();}
});
test('Bài ngắn có nội dung dùng canonical đã khóa, chỉ tạo một job AI',async()=>{
 const f=await fixture();try{let dependency=null;
 for(const section of ['listening','reading','writing']){const start=op(f,section,'start',{dependency});await f.request('/offline/operation',start);
 const seal=op(f,section,'seal',{dependency,startedAt:start.payload.startedAt,task1:section==='writing'?'One real sentence.':''});assert.equal((await f.request('/offline/operation',seal)).receipt.status,'accepted');dependency=seal.operationId;}
 await f.grading.ensureSubmission({attemptToken:f.a,testSlug:mod.SLUG,task1:'',task2:'',taskDefinitions:f.content.writing.tasks});
 const rows=(await f.db.query('SELECT essay_text,status FROM assessment.term_test_writing_grading_run')).rows;assert.deepEqual(rows.map(x=>[x.essay_text,x.status]),[['One real sentence.','queued']]);
 assert.equal((await f.db.query('SELECT * FROM assessment.term_test_writing_grading_job')).rows.length,1);
 }finally{await f.close();}
});
test('Crash sau commit vẫn giữ bài và worker quét bù Writing 0 khi không có trình duyệt',{timeout:25000},async()=>{
 const f=await fixture('lis_first',{writingFailures:1});try{let dependency=null;
 for(const section of ['listening','reading','writing']){const start=op(f,section,'start',{dependency});await f.request('/offline/operation',start);const seal=op(f,section,'seal',{dependency,startedAt:start.payload.startedAt});await f.request('/offline/operation',seal);dependency=seal.operationId;}
 assert.equal((await f.db.query('SELECT * FROM assessment.term_test_writing_grading_run')).rows.length,0);
 const until=Date.now()+19000;while(Date.now()<until&&(await f.db.query('SELECT * FROM assessment.term_test_writing_grading_final')).rows.length===0)await new Promise(ok=>setTimeout(ok,200));
 assert.equal(Number((await f.db.query('SELECT writing_score FROM assessment.term_test_writing_grading_final')).rows[0]?.writing_score),0);assert.equal((await f.db.query('SELECT * FROM assessment.term_test_writing_grading_job')).rows.length,0);
 }finally{await f.close();}
});
if(pgUrl)test('Role API chỉ có SELECT/INSERT/UPDATE trên hai bảng mới, rollback giữ receipt/bài nguyên vẹn',async()=>{
 const f=await fixture(),role='term2_api_'+randomUUID().replaceAll('-','');let c;
 try{await f.db.exec(`CREATE ROLE ${role} NOLOGIN; GRANT USAGE ON SCHEMA assessment TO ${role}; GRANT SELECT,INSERT,UPDATE ON assessment.term2_offline_run,assessment.term2_offline_operation TO ${role};`);
  c=await f.pool.connect();await c.query('BEGIN');await c.query('SET LOCAL ROLE '+role);
  await c.query('SELECT * FROM assessment.term2_offline_run WHERE attempt_id=$1 FOR UPDATE',[f.a]);await c.query("UPDATE assessment.term2_offline_run SET state='{}' WHERE attempt_id=$1",[f.a]);
  await c.query("INSERT INTO assessment.term2_offline_operation(operation_id,attempt_id,payload_hash,section,kind,payload,receipt) VALUES($1,$2,'fixture','listening','draft','{}','{}')",[randomUUID(),f.a]);
  await c.query('SAVEPOINT denied');await assert.rejects(c.query('DELETE FROM assessment.term2_offline_run'),e=>e.code==='42501');await c.query('ROLLBACK TO SAVEPOINT denied');await c.query('ROLLBACK');
  assert.equal((await f.db.query('SELECT * FROM assessment.term2_offline_operation')).rows.length,0);
 }finally{if(c){try{await c.query('ROLLBACK');}catch{}c.release();}await f.db.exec(`DROP OWNED BY ${role}; DROP ROLE ${role};`);await f.close();}
});
if(pgUrl)for(const count of [30,50])test('PostgreSQL reconnect đồng thời '+count+' người giả và ACK lặp không nhân bài',async()=>{
 const f=await fixture();try{const people=[];for(let i=0;i<count;i++)people.push(await f.newRun());
 const timings=[];await Promise.all(people.map(async person=>{let dependency=null;for(const section of ['listening','reading','writing']){
  const local={scope:person.scope,clock:f.clock},start=op(local,section,'start',{dependency});let at=performance.now();const r=await f.request('/offline/operation',start,person.permit);timings.push(performance.now()-at);assert.equal(r.receipt?.status,'accepted',JSON.stringify(r));
  const seal=op(local,section,'seal',{dependency,startedAt:start.payload.startedAt});const responses=await Promise.all([f.request('/offline/operation',seal,person.permit),f.request('/offline/operation',seal,person.permit)]);
  assert.deepEqual(responses[0].receipt,responses[1].receipt);assert.equal(responses[0].receipt?.status,'accepted',JSON.stringify(responses));dependency=seal.operationId;
 }}));
 assert.equal((await f.db.query('SELECT * FROM assessment.term2_offline_operation')).rows.length,count*6);assert.equal((await f.db.query('SELECT * FROM assessment.term_test_writing_grading_final')).rows.length,count);assert.equal((await f.db.query('SELECT * FROM assessment.term_test_writing_grading_job')).rows.length,0);
 timings.sort((a,b)=>a-b);console.log(JSON.stringify({count,operationStartP95Ms:timings[Math.floor(timings.length*.95)],maxMs:timings.at(-1),receipts:count*6}));
 }finally{await f.close();}
});

}
